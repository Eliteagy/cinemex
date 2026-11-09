// Captions: local Whisper transcription (engine/transcribe.py) and word grouping into short,
// readable caption chunks like the ones on Reels/TikTok. The formatting options follow AutoSubs
// (density / max characters per line, max lines, text case, punctuation, censored words).
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { cleanWord, pickKeyword } = require('../src/lib/emphasis.js');

const PYTHON = process.env.ELITE_PYTHON || 'python';
const STYLES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'styles.json'), 'utf8'));

const MODELS = ['auto', 'large-v3-turbo', 'large-v3', 'medium', 'small', 'base', 'tiny'];

/**
 * Transcribe a file. opts: language ('auto' or a code), model (MODELS), translate (to English),
 * prompt (vocabulary / context for Whisper).
 */
function transcribe(file, opts = {}) {
  const o = typeof opts === 'string' ? { language: opts } : opts || {};
  const args = ['-E', '-P', path.join(__dirname, '..', 'engine', 'transcribe.py'), file, String(o.language || 'pt')];
  if (o.model && MODELS.includes(o.model) && o.model !== 'auto') args.push('--model', o.model);
  if (o.translate) args.push('--translate');
  if (o.prompt) args.push('--prompt', String(o.prompt).slice(0, 500));
  return new Promise((resolve, reject) => {
    execFile(PYTHON, args, { encoding: 'utf8', timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(err.code === 'ENOENT' ? 'Python não encontrado' : String(stderr || err.message).split('\n').filter(Boolean).slice(-2).join(' ')));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('Resposta inválida do transcritor'));
      }
    });
  });
}

/** Characters per line for each AutoSubs-style density. */
const DENSITY = { single: 0, less: 18, standard: 30, more: 42 };

const PUNCT = /[.,!?;:…"“”«»()¡¿]/g;

function applyCase(w, mode) {
  if (mode === 'upper') return w.toUpperCase();
  if (mode === 'lower') return w.toLowerCase();
  if (mode === 'title') return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  return w;
}

/** Censored word: first letter kept, the rest as asterisks (punctuation stays). */
function censorWord(w, list) {
  const bare = cleanWord(w).toLowerCase();
  if (!bare || !list.has(bare)) return w;
  return w.replace(cleanWord(w), (m) => m.charAt(0) + '*'.repeat(Math.max(1, m.length - 1)));
}

/** Lines needed to show `texts` with at most `maxChars` per line (greedy wrap). */
function linesFor(texts, maxChars) {
  let lines = 1;
  let len = 0;
  for (const t of texts) {
    const add = (len ? 1 : 0) + t.length;
    if (len && len + add > maxChars) {
      lines++;
      len = t.length;
    } else len += add;
  }
  return lines;
}

/**
 * Group words into caption chunks: at most `maxWords` words or `maxDur` seconds, breaking on
 * punctuation and on pauses longer than `gap`. Times stay in the words' own clock.
 * Options (AutoSubs): maxChars per line (or density), maxLines, textCase (none, lower, upper,
 * title), stripPunct, censor (list of words). keywordEdge: keyword captions (Felipe) keep the
 * keyword at the start or the end of the block, so the block never needs more than 2 lines.
 */
function groupWords(words, opts = {}) {
  const density = opts.density && opts.density !== 'custom' ? opts.density : null;
  let maxWords = Math.max(1, opts.maxWords ?? 3);
  if (density === 'single') maxWords = 1;
  const maxChars = density && DENSITY[density] ? DENSITY[density] : opts.maxChars ? Math.max(4, opts.maxChars) : 0;
  const maxLines = Math.max(1, opts.maxLines ?? (maxChars ? 2 : 99));
  // Keyword blocks are cut from whole phrases (pauses and punctuation), then split 3/2/1.
  const { maxDur = opts.keywordEdge ? 99 : 1.4, gap = opts.keywordEdge ? 0.35 : 0.6 } = opts;
  const phraseWords = opts.keywordEdge ? 999 : maxWords;
  const censor = new Set((Array.isArray(opts.censor) ? opts.censor : String(opts.censor || '').split(/[,;\n]/)).map((w) => cleanWord(w).toLowerCase()).filter(Boolean));
  const shown = (w) => {
    let t = String(w);
    if (opts.stripPunct) t = t.replace(PUNCT, '');
    if (censor.size) t = censorWord(t, censor);
    return applyCase(t, opts.textCase);
  };
  const chunks = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    chunks.push(cur);
    cur = [];
  };
  for (const raw of words) {
    const w = { ...raw, w: shown(raw.w), end: /[.!?…,;:]$/.test(raw.w) };
    if (!w.w) continue;
    const prev = cur[cur.length - 1];
    const tooLong = !opts.keywordEdge && maxChars && linesFor([...cur, w].map((x) => x.w), maxChars) > maxLines;
    if (prev && (cur.length >= phraseWords || w.e - cur[0].s > maxDur || w.s - prev.e > gap || tooLong)) flush();
    cur.push(w);
    if (w.end) flush();
  }
  flush();
  const blocks = opts.keywordEdge ? chunks.flatMap((ch) => keywordSplit(ch, maxChars || 16, maxWords)) : chunks;
  return blocks.map((ws) => {
    const list = ws.map(({ w, s, e }) => ({ w, s, e }));
    return { text: list.map((w) => w.w).join(' '), start: list[0].s, end: list[list.length - 1].e, words: list };
  });
}

/**
 * Felipe's block rule: take 3, 2 or 1 words so that the keyword is at an edge of the block, the
 * base words fit one line of `maxChars` and the block is spoken within 0.75 s.
 */
function keywordSplit(ch, maxChars, maxWords = 3) {
  const out = [];
  let i = 0;
  while (i < ch.length) {
    let n = Math.min(maxWords, ch.length - i);
    for (; n > 1; n--) {
      const ws = ch.slice(i, i + n);
      const kw = pickKeyword(ws.map((w) => w.w));
      if (kw > 0 && kw < n - 1) continue;
      const base = ws.filter((_, j) => j !== kw).map((w) => w.w).join(' ');
      if (base.length > maxChars) continue;
      if (ws[n - 1].s - ws[0].s > 0.75) continue;
      break;
    }
    out.push(ch.slice(i, i + n));
    i += n;
  }
  return out;
}

/**
 * Caption clips for one timeline clip: the source words inside [in, out] moved onto the
 * timeline, grouped, each chunk a text clip whose `words` are relative to the chunk start.
 * Keyword styles (Felipe, Marta) bring their own grouping (maxWords, maxChars, keyword at an edge).
 */
function captionClipsFor(clip, words, opts = {}) {
  const style = opts.style || 'elite';
  const em = STYLES[style]?.emphasis;
  const speed = Math.max(0.25, Math.min(4, clip.speed ?? 1));
  const inside = words.filter((w) => w.s >= clip.in - 0.05 && w.e <= clip.out + 0.05);
  const moved = inside.map((w) => ({ w: w.w, s: clip.start + (w.s - clip.in) / speed, e: clip.start + (w.e - clip.in) / speed }));
  const group = { ...opts, maxWords: opts.maxWords ?? em?.maxWords ?? 3 };
  if (em) {
    // The style's own limits apply only when the Gui did not choose a number of words.
    const chosen = opts.maxWords !== undefined && (!opts.density || opts.density === 'custom');
    if (!chosen) group.maxWords = Math.min(group.maxWords, em.maxWords ?? 3);
    if (!opts.maxChars && (!opts.density || opts.density === 'custom')) group.maxChars = chosen ? Math.max(em.maxChars ?? 16, group.maxWords * 9) : em.maxChars;
    group.keywordEdge = em.mode === 'rows';
  }
  return groupWords(moved, group).map((ch, i, all) => {
    const next = all[i + 1];
    const end = next ? Math.min(next.start, ch.end + 0.35) : ch.end + 0.35;
    const r = (n) => Math.round(n * 1000) / 1000;
    return {
      text: ch.text,
      style,
      start: r(ch.start),
      in: 0,
      out: r(Math.max(0.2, end - ch.start)),
      words: ch.words.map((w) => ({ w: w.w, s: r(w.s - ch.start), e: r(w.e - ch.start) })),
    };
  });
}

module.exports = { transcribe, groupWords, captionClipsFor, keywordSplit, DENSITY, MODELS };
