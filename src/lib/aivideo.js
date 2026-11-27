// AI features taken from VideoCraft (dosmoon/VideoCraft, see docs/engenharia-reversa/videocraft.md):
// best moments ("hotclips"), titles + chapters, caption translation and caption checks.
// Pure functions (prompts in, JSON out, checks): the model call itself is electron/llm.cjs.
// Shared ESM: required by electron/*.cjs and imported by the UI.
//
// Anti-hallucination rule from VideoCraft: the model only returns times and short texts; every quote
// of what was said is cut from the real transcript afterwards, never written by the model.

const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));
const pad = (n) => String(Math.floor(n)).padStart(2, '0');

/** Seconds -> HH:MM:SS. */
export function hms(t) {
  const s = Math.max(0, Math.round(Number(t) || 0));
  return `${pad(s / 3600)}:${pad((s / 60) % 60)}:${pad(s % 60)}`;
}

/** HH:MM:SS(.ms) or MM:SS or seconds -> seconds (NaN when unreadable). */
export function parseHms(v) {
  if (typeof v === 'number') return v;
  const m = String(v || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:[.,]\d+)?)$/);
  if (!m) return Number.isFinite(Number(v)) ? Number(v) : NaN;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(String(m[3]).replace(',', '.'));
}

// Sentence regrouping (VideoCraft sentence_regroup.py, a port of stable-ts): terminal punctuation
// (not after abbreviations or numbers), then pauses >= 0.5 s, then a comma once the line is long,
// then a hard cap.
const ABBR = /^(sr|sra|dr|dra|eng|prof|av|n\.?º|mr|mrs|ms|st|vs|etc|p\.ex|ex)\.$/i;
const TERMINAL = /[.!?…]["»”']?$/;

/** Word[] ({w, s, e}) -> sentences [{text, s, e, from, to}] (from/to = word indexes, inclusive). */
export function sentences(words, { gap = 0.5, comma = 50, cap = 70 } = {}) {
  const out = [];
  let cur = null;
  const close = () => {
    if (cur) out.push(cur);
    cur = null;
  };
  (words || []).forEach((wd, i) => {
    const w = String(wd.w ?? '').trim();
    if (!w) return;
    if (cur && wd.s - cur.e >= gap) close();
    if (!cur) cur = { text: w, s: wd.s, e: wd.e, from: i, to: i };
    else {
      cur.text += ` ${w}`;
      cur.e = wd.e;
      cur.to = i;
    }
    const next = words[i + 1];
    const nextLower = next && /^[a-zà-ÿ]/.test(String(next.w ?? '').trim());
    if (TERMINAL.test(w) && !ABBR.test(w) && !(w.endsWith('...') && nextLower)) close();
    else if (cur && /,$/.test(w) && cur.text.length >= comma) close();
    else if (cur && cur.text.length >= cap) close();
  });
  close();
  return out;
}

/** Transcript as `[HH:MM:SS] sentence` lines between two times (what the model reads). */
export function transcriptLines(words, from = 0, to = Infinity) {
  return sentences(words)
    .filter((s) => s.e > from && s.s < to)
    .map((s) => `[${hms(s.s)}] ${s.text}`)
    .join('\n');
}

/** The real words said between s and e (the clip's text, never the model's). */
export function textBetween(words, s, e) {
  return (words || [])
    .filter((w) => w.s >= s - 0.05 && w.e <= e + 0.05)
    .map((w) => String(w.w).trim())
    .filter(Boolean)
    .join(' ');
}

const LANG = 'português europeu (de Portugal)';

// ------------------------------------------------------------------------------- best moments
export const HOTCLIP_DEFAULTS = { count: 8, min: 20, max: 60 };

/** Prompt for one transcript window (VideoCraft prompts.py subtitle.hotclips, in Portuguese). */
export function hotclipsPrompt(lines, { count = 8, min = 20, max = 60, language = LANG, context = '' } = {}) {
  return `# Melhores momentos para shorts

És editor de shorts (Reels, TikTok, YouTube Shorts). Lê a transcrição com tempos e escolhe até ${count} momentos com potencial para se tornarem virais.
Cada momento tem de:
- durar entre ${min} e ${max} segundos;
- fazer sentido sozinho (início e fim completos, sem depender do resto do vídeo);
- abrir forte: opinião contra a corrente, suspense, opinião forte, contraste de números ou muita emoção;
- começar no início de uma frase e acabar no fim de uma frase.

Para cada momento devolve:
- "start" e "end": HH:MM:SS, tirados dos tempos da transcrição;
- "hook": uma frase de gancho para o início (máx. 12 palavras);
- "outro": uma frase final ou chamada à ação ligada a ESTE momento (máx. 12 palavras), nada genérico como "segue para mais";
- "why_viral": numa frase, porque é que este momento resulta;
- "score": 1 a 10 (força do gancho, densidade de informação, emoção, ser completo);
- "title": título do short (máx. 12 palavras);
- "hashtags": 3 a 5, com #.

Escreve hook, outro, why_viral, title e hashtags em ${language}.
Não copies a transcrição para a resposta.
${context ? `\nContexto do vídeo:\n${context}\n` : ''}
Responde APENAS com JSON: {"clips":[{"start":"00:01:02","end":"00:01:40","hook":"...","outro":"...","why_viral":"...","score":8,"title":"...","hashtags":["#a","#b","#c"]}]}

Transcrição:
${lines}
`;
}

/** Windows of the transcript for long videos: chapters when given, else ~20 min blocks. */
export function hotclipWindows(words, { chapters = null, count = 8, block = 1200 } = {}) {
  const last = words?.length ? words[words.length - 1].e : 0;
  let spans;
  if (chapters?.length) spans = chapters.map((c, i) => ({ s: c.start, e: chapters[i + 1]?.start ?? last + 1 }));
  else if (last <= block * 1.5) spans = [{ s: 0, e: last + 1 }];
  else {
    spans = [];
    for (let s = 0; s < last; s += block) spans.push({ s, e: Math.min(last + 1, s + block) });
  }
  const per = spans.length > 1 ? Math.max(3, Math.floor(count / spans.length) + 1) : count;
  return spans.map((sp) => ({ ...sp, count: per }));
}

const SENTENCE_END = /[.!?…]["»”')]*$/;
/** Is there a sentence break between word i-1 and word i (final punctuation or a pause)? */
const breakBefore = (ws, i) => i <= 0 || SENTENCE_END.test(String(ws[i - 1].w).trim()) || ws[i].s - ws[i - 1].e >= 0.45;

/**
 * Moves a clip's first word back to the start of its sentence (at most `back` s earlier) and its
 * last word on to the end of the sentence (at most `fwd` s later), so a short never starts or ends
 * mid-sentence ("o dinheiro / Porquê" -> "Por isso é que as pessoas têm tanto problema com o
 * dinheiro."). Without a break in reach, the original word stays.
 */
export function snapToSentence(ws, from, to, { back = 4, fwd = 3 } = {}) {
  let a = from;
  if (!breakBefore(ws, from)) {
    let i = from;
    while (i > 0 && !breakBefore(ws, i) && ws[from].s - ws[i - 1].s <= back) i--;
    if (breakBefore(ws, i)) a = i;
  }
  let b = to;
  if (!SENTENCE_END.test(String(ws[to].w).trim()) && to + 1 < ws.length && !breakBefore(ws, to + 1)) {
    let i = to;
    while (i + 1 < ws.length && !SENTENCE_END.test(String(ws[i].w).trim()) && !breakBefore(ws, i + 1) && ws[i + 1].e - ws[to].e <= fwd) i++;
    if (SENTENCE_END.test(String(ws[i].w).trim()) || i + 1 >= ws.length || breakBefore(ws, i + 1)) b = i;
  }
  return { from: a, to: b };
}

/**
 * Cleans the model's moments: times parsed and snapped to the real words (start of the first
 * sentence word, end of the last), length kept in [min*0.75, max*1.25], overlaps dropped (higher
 * score wins), text cut from the transcript. Sorted by score, best first.
 */
export function parseHotclips(json, words, { min = 20, max = 60, count = 8 } = {}) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.clips) ? json.clips : [];
  const ws = words || [];
  const out = [];
  for (const c of list) {
    let s = parseHms(c?.start);
    let e = parseHms(c?.end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    const first = ws.find((w) => w.e > s + 0.05);
    const lastIdx = ws.findLastIndex ? ws.findLastIndex((w) => w.s < e - 0.05) : ws.length - 1 - [...ws].reverse().findIndex((w) => w.s < e - 0.05);
    if (!first || lastIdx < 0) continue;
    const snap = snapToSentence(ws, ws.indexOf(first), lastIdx);
    s = Math.max(0, ws[snap.from].s - 0.15);
    e = ws[snap.to].e + 0.25;
    const d = e - s;
    if (d < min * 0.75 || d > max * 1.25) continue;
    const text = textBetween(ws, s, e);
    if (!text) continue;
    const tags = (Array.isArray(c.hashtags) ? c.hashtags : [])
      .map((h) => String(h).trim().replace(/\s+/g, ''))
      .filter(Boolean)
      .map((h) => (h.startsWith('#') ? h : `#${h}`))
      .slice(0, 5);
    out.push({
      start: Math.round(s * 100) / 100,
      end: Math.round(e * 100) / 100,
      duration: Math.round(d * 10) / 10,
      score: clamp(Math.round(Number(c.score) || 0), 1, 10),
      hook: String(c.hook || '').trim().slice(0, 140),
      outro: String(c.outro || '').trim().slice(0, 140),
      why: String(c.why_viral || c.why || '').trim().slice(0, 240),
      title: String(c.title || c.suggested_title || '').trim().slice(0, 140),
      hashtags: tags,
      text,
    });
  }
  out.sort((a, b) => b.score - a.score || a.start - b.start);
  const kept = [];
  for (const c of out) if (!kept.some((k) => c.start < k.end && c.end > k.start)) kept.push(c);
  return kept.slice(0, count);
}

/** Publish text for one short (title, what is said, hashtags, outro). */
export function publishText(c) {
  const posts = publishPosts(c);
  return [`# ${c.title || c.hook}`, '', `Duração: ${Math.round(c.duration)} s · pontuação ${c.score}/10`, '', `**Gancho:** ${c.hook}`, `**Final:** ${c.outro}`, `**Porque resulta:** ${c.why}`, '', '## Legenda para publicar', '', `${c.title}`, '', c.text, '', c.hashtags.join(' '), ''].join('\n') + ['', '## Instagram', '', posts.instagram, '', '## TikTok', '', posts.tiktok, '', '## YouTube Shorts', '', `**Título:** ${posts.youtube.title}`, '', posts.youtube.description, '', ...(posts.warnings.length ? ['## Atenção', '', ...posts.warnings.map((w) => `- ${w}`), ''] : [])].join('\n');
}

/** File-name-safe slug (accents kept off, max 40 chars). */
export function slug(s) {
  return (
    String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .toLowerCase() || 'clip'
  );
}

// ------------------------------------------------------------------------------- titles + chapters
export function chaptersPrompt(lines, { language = LANG } = {}) {
  return `# Títulos e capítulos

A partir da transcrição com tempos, devolve:
1. "titles": 1 a 3 títulos para o vídeo, com o foco principal.
2. "chapters": capítulos ao estilo do YouTube, cortados nas mudanças naturais de assunto (nem demasiado curtos nem demasiado longos). O primeiro começa em 00:00:00. Para cada um: "start" (HH:MM:SS), "title" curto, "summary" (máx. 60 palavras, denso, sem repetir o texto) e "points" (factos, números, conclusões ditas nesse capítulo, cada um com máx. 12 palavras; [] se não houver).
Escreve tudo em ${language}.
Responde APENAS com JSON: {"titles":["..."],"chapters":[{"start":"00:00:00","title":"...","summary":"...","points":["..."]}]}

Transcrição:
${lines}
`;
}

export function parseChapters(json, duration = Infinity) {
  const titles = (Array.isArray(json?.titles) ? json.titles : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 3);
  const chapters = (Array.isArray(json?.chapters) ? json.chapters : [])
    .map((c) => ({ start: parseHms(c?.start), title: String(c?.title || '').trim(), summary: String(c?.summary || '').trim(), points: (Array.isArray(c?.points) ? c.points : []).map(String).slice(0, 8) }))
    .filter((c) => Number.isFinite(c.start) && c.start >= 0 && c.start < duration && c.title)
    .sort((a, b) => a.start - b.start)
    .filter((c, i, a) => i === 0 || c.start - a[i - 1].start >= 10);
  if (chapters.length) chapters[0].start = 0;
  return { titles, chapters };
}

/** YouTube description block: "00:00 Title" lines (YouTube needs the first at 00:00 and >= 3 chapters). */
export function youtubeChapters(chapters) {
  return chapters
    .map((c) => {
      const t = Math.round(c.start);
      const h = Math.floor(t / 3600);
      const mm = `${h ? `${h}:` : ''}${String(Math.floor(t / 60) % 60).padStart(h ? 2 : 1, '0')}:${pad(t % 60)}`;
      return `${mm} ${c.title}`;
    })
    .join('\n');
}

// ------------------------------------------------------------------------------- translation
export const TRANSLATE_BATCH = 100;

/** Prompt for one batch of caption texts ({i, text}) -> {"items":[{"i":n,"text":"..."}]}. */
export function translatePrompt(items, language) {
  return `# Tradução de legendas

Traduz cada legenda para ${language}. Mantém o sentido, o tom falado e frases curtas como numa legenda; não juntes nem dividas legendas; nomes próprios ficam iguais.
Devolve exatamente ${items.length} itens com o mesmo "i".
Responde APENAS com JSON: {"items":[{"i":0,"text":"..."}]}

Legendas:
${items.map((it) => `【${it.i}】${it.text}`).join('\n')}
`;
}

/** Matches answers by index (missing ones stay null) and strips format leftovers. */
export function parseTranslation(json, items) {
  const got = new Map();
  for (const r of Array.isArray(json?.items) ? json.items : Array.isArray(json) ? json : []) {
    const i = Number(r?.i);
    if (Number.isInteger(i)) got.set(i, cleanResidue(String(r?.text ?? '')));
  }
  return items.map((it) => (got.has(it.i) ? got.get(it.i) : null));
}

// ------------------------------------------------------------------------------- caption checks
/** LLM / format leftovers (VideoCraft subtitle_check.py clean_residue). */
export function cleanResidue(t) {
  return String(t || '')
    .replace(/【\d+】/g, '')
    .replace(/<\|[^|]*\|>/g, '')
    .replace(/^\s*(assistant|assistente)\s*:\s*/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Caption problems: cues = [{id, start, end, text}] in timeline seconds.
 * kinds: empty, timing (end <= start), overlap (> 0.2 s), residue, duplicate (same text 3+ times in a row), long (> 20 chars/s).
 */
export function checkCaptions(cues) {
  const issues = [];
  const list = [...(cues || [])].sort((a, b) => a.start - b.start);
  list.forEach((c, i) => {
    const t = String(c.text || '').trim();
    if (!t) issues.push({ id: c.id, kind: 'empty', fix: true, msg: 'Legenda vazia' });
    if (!(c.end > c.start)) issues.push({ id: c.id, kind: 'timing', fix: false, msg: 'Fim antes do início' });
    const n = list[i + 1];
    if (n && c.end - n.start > 0.2) issues.push({ id: c.id, kind: 'overlap', fix: true, msg: `Sobrepõe-se à seguinte em ${(c.end - n.start).toFixed(2)} s` });
    if (t && cleanResidue(t) !== t) issues.push({ id: c.id, kind: 'residue', fix: true, msg: 'Restos de formatação' });
    const cps = t.length / Math.max(0.1, c.end - c.start);
    if (cps > 20) issues.push({ id: c.id, kind: 'long', fix: false, msg: `Rápida de mais para ler (${Math.round(cps)} caracteres/s)` });
    if (i >= 2 && t && t === String(list[i - 1].text).trim() && t === String(list[i - 2].text).trim()) issues.push({ id: c.id, kind: 'duplicate', fix: true, msg: 'Repetida 3 vezes seguidas' });
  });
  return issues;
}

/** Automatic fixes: residue cleaned, overlaps trimmed, empty and repeated cues removed. Returns new cues. */
export function fixCaptions(cues) {
  const list = [...(cues || [])].sort((a, b) => a.start - b.start).map((c) => ({ ...c, text: cleanResidue(c.text) }));
  const out = [];
  for (const c of list) {
    if (!c.text) continue;
    const p = out[out.length - 1];
    const pp = out[out.length - 2];
    if (p && pp && c.text === p.text && c.text === pp.text) continue;
    if (p && p.end > c.start) p.end = Math.max(p.start + 0.1, c.start);
    out.push(c);
  }
  return out;
}

// ------------------------------------------------------------------ transcript review (Whisper mistakes)
const normTok = (t) => String(t).toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}-]/gu, '');

/** Prompt: find words Whisper heard wrong in these lines (PT-PT talk), using the context. */
export function spellPrompt(lines, { context = '', learned = [] } = {}) {
  const known = learned.length ? `\nCorreções que o editor já fez antes (aplica sempre que aparecerem):\n${learned.map((l) => `- "${l.from}" -> "${l.to}"`).join('\n')}\n` : '';
  return `Esta transcrição automática (Whisper) de um vídeo em português de Portugal tem erros de reconhecimento: palavras parecidas no som mas erradas no sentido (ex.: "os teus tios para ninguém" quando a pessoa disse "os teus planos"), nomes próprios e estrangeirismos mal escritos (ex.: "tivone" = "T-bone"), clíticos separados.${context ? `\nContexto: ${String(context).slice(0, 300)}` : ''}
${known}
Linhas:
${lines}

Devolve só as correções de que tens a certeza pelo contexto. NÃO reescrevas o estilo, NÃO corrijas gramática falada, NÃO mudes palavras certas.
"wrong" = as palavras EXATAMENTE como estão na transcrição (1 a 4 palavras seguidas, sem a pontuação), "right" = como devia estar.
Responde APENAS com JSON: {"fixes":[{"wrong":"os teus tios","right":"os teus planos","sure":true}]}`;
}

/** Cleans the model's fixes: plain strings, short, different, no duplicates. */
export function parseSpellFixes(json) {
  const list = Array.isArray(json?.fixes) ? json.fixes : Array.isArray(json) ? json : [];
  const seen = new Set();
  const out = [];
  for (const f of list) {
    const wrong = String(f?.wrong ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const right = String(f?.right ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!wrong || !right || f?.sure === false) continue;
    if (wrong.split(' ').length > 6 || right.split(' ').length > 8) continue;
    if (normTok(wrong.replace(/ /g, '')) === normTok(right.replace(/ /g, ''))) continue;
    const k = wrong.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ wrong, right });
  }
  return out.slice(0, 60);
}

/**
 * Applies phrase fixes to timed words: every run of words matching `wrong` (ignoring case and
 * punctuation) becomes the words of `right`, timed across the old run; the last word keeps the
 * old trailing punctuation, and ALL-CAPS words stay in caps. Returns { words, applied }.
 */
export function applySpellFixes(words, fixes) {
  let ws = (words || []).map((w) => ({ ...w }));
  const applied = [];
  for (const f of fixes || []) {
    const pat = String(f.wrong).split(' ').map(normTok).filter(Boolean);
    const rep = String(f.right).split(' ').filter(Boolean);
    if (!pat.length || !rep.length) continue;
    const out = [];
    for (let i = 0; i < ws.length; ) {
      const hit = pat.every((p, k) => ws[i + k] && normTok(ws[i + k].w) === p);
      if (!hit) {
        out.push(ws[i++]);
        continue;
      }
      const run = ws.slice(i, i + pat.length);
      const s = run[0].s;
      const e = run[run.length - 1].e;
      const tail = (String(run[run.length - 1].w).match(/[.,!?;:…"»”)]+$/) || [''])[0];
      const lead = (String(run[0].w).match(/^["«“(¿¡]+/) || [''])[0];
      const caps = run.every((w) => /\p{L}/u.test(w.w) && String(w.w) === String(w.w).toUpperCase());
      const step = (e - s) / rep.length;
      rep.forEach((t, k) => {
        let w = caps ? t.toUpperCase() : t;
        if (k === 0) w = lead + w;
        if (k === rep.length - 1 && !/[.,!?;:…]$/.test(w)) w += tail;
        out.push({ ...run[Math.min(k, run.length - 1)], w, s: Math.round((s + k * step) * 1000) / 1000, e: Math.round((k === rep.length - 1 ? e : s + (k + 1) * step) * 1000) / 1000 });
      });
      applied.push({ wrong: run.map((w) => w.w).join(' '), right: f.right, s });
      i += pat.length;
    }
    ws = out;
  }
  return { words: ws, applied };
}

// ------------------------------------------------------------------ main word chosen by the AI
/** Prompt: in each numbered caption block, which word carries the meaning (the one to show big). */
export function keywordPrompt(blocks, { learned = [] } = {}) {
  const prefs = learned.length ? `\nEscolhas que o editor fez antes (segue o mesmo gosto):\n${learned.slice(-20).map((l) => `- "${l.block}" -> "${l.word}"`).join('\n')}\n` : '';
  return `Legendas de um vídeo curto (Reels/TikTok) em português. Em cada bloco, uma palavra vai aparecer GIGANTE atrás da pessoa: escolhe a palavra mais forte em sentido e emoção (substantivo, verbo forte, número, nome), nunca artigos, preposições ou "que", "é", "isso".${prefs}
${blocks.map((b, i) => `${i}: ${b.join(' ')}`).join('\n')}

Responde APENAS com JSON: {"pick":[índice da palavra no bloco 0, no bloco 1, ...]} (o índice começa em 0; -1 se o bloco não tiver nenhuma palavra forte).`;
}

/** The model's picks, one per block, checked against the block sizes (else null = automatic). */
export function parseKeywordPicks(json, blocks) {
  const raw = Array.isArray(json?.pick) ? json.pick : Array.isArray(json) ? json : [];
  return blocks.map((b, i) => {
    const v = Number(raw[i]);
    return Number.isInteger(v) && v >= -1 && v < b.length ? v : null;
  });
}

// ------------------------------------------------------------------ publishing pack
/** Where each network takes uploads (opened in the browser; the Gui posts himself). */
export const UPLOAD_URLS = {
  instagram: 'https://www.instagram.com/',
  tiktok: 'https://www.tiktok.com/tiktokstudio/upload',
  youtube: 'https://studio.youtube.com/',
};

/**
 * Ready-to-paste texts per network for one short: Instagram (title, hook line, 5 hashtags), TikTok
 * (short, hashtags), YouTube Shorts (title up to 100 characters + description with #shorts). Plus
 * warnings when the short is long for a network.
 */
export function publishPosts(c) {
  const title = String(c.title || c.hook || '').trim();
  const tags = (c.hashtags || []).slice(0, 5);
  const hook = String(c.hook || '').trim();
  const outro = String(c.outro || '').trim();
  const d = Number(c.duration) || 0;
  const warnings = [];
  if (d > 90) warnings.push(`${Math.round(d)} s: nos Reels e no TikTok os vídeos até 60-90 s costumam reter melhor`);
  if (d > 180) warnings.push('Mais de 3 minutos: o YouTube não o aceita como Short');
  return {
    instagram: [title, '', hook && hook !== title ? hook : null, outro || null, '', tags.join(' ')].filter((x) => x !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    tiktok: [title, tags.slice(0, 4).join(' ')].filter(Boolean).join(' ').slice(0, 2200),
    youtube: { title: (title.length > 95 ? `${title.slice(0, 94)}…` : title) || 'Short', description: [hook, outro, '', [...tags, '#shorts'].join(' ')].filter((x) => x !== undefined).join('\n').trim() },
    warnings,
  };
}
