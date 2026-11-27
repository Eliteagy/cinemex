// Best moments -> batch of shorts (from VideoCraft, docs/engenharia-reversa/videocraft.md §5.6, §5.9):
// the AI picks moments in a long video's transcript (electron/llm.cjs, no tools), the editor checks
// them against the real words (src/lib/aivideo.js), then each chosen moment becomes its own Cinemex
// project (9:16, captions, hook and closing cards) saved as .ecproj and exported as MP4, with a
// publish note per short and an index.
const fs = require('node:fs');
const path = require('node:path');
const { askJson } = require('./llm.cjs');
const { captionClipsFor } = require('./captions.cjs');
const capmodels = require('../src/lib/capmodels.js');
const polish = require('../src/lib/polish.js');
const { musicClips, moodFromText } = polish;
const brollLib = require('../src/lib/broll.js');
const { runExport } = require('./render.cjs');
const ai = require('../src/lib/aivideo.js');

const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 9)}`;
const r3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Finds the best moments of a transcript.
 * @param {{w:string,s:number,e:number}[]} words source words (seconds)
 * @param {{count?:number,min?:number,max?:number,chapters?:{start:number}[],context?:string,model?:string,ask?:Function,onProgress?:Function,signal?:AbortSignal}} o
 */
async function findHotclips(words, o = {}) {
  if (!Array.isArray(words) || words.length < 20) throw new Error('Este vídeo ainda não tem transcrição (faz as legendas automáticas primeiro).');
  const count = Math.max(1, Math.min(20, Math.round(o.count ?? ai.HOTCLIP_DEFAULTS.count)));
  const min = Math.max(5, Number(o.min ?? ai.HOTCLIP_DEFAULTS.min));
  const max = Math.max(min + 5, Number(o.max ?? ai.HOTCLIP_DEFAULTS.max));
  const ask = o.ask || ((p) => askJson(p, { model: o.model || 'sonnet', signal: o.signal }));
  const windows = ai.hotclipWindows(words, { chapters: o.chapters, count });
  const found = [];
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    o.onProgress?.({ step: i + 1, of: windows.length });
    const lines = ai.transcriptLines(words, w.s, w.e);
    if (!lines.trim()) continue;
    const json = await ask(ai.hotclipsPrompt(lines, { count: w.count, min, max, context: o.context }));
    found.push(...(Array.isArray(json?.clips) ? json.clips : Array.isArray(json) ? json : []));
  }
  return ai.parseHotclips(found, words, { min, max, count });
}

// Hook/closing cards: high in the frame, above the speaker's head in a 9:16 crop (0.22 covered the face)
// and still below the top bar of Reels/TikTok.
const CARD_Y = 0.11;
const shortSize = (preset) => ({ '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '16:9': [1920, 1080] })[preset] || [1080, 1920];

/**
 * "Legendas atrás" (real-estate look) through a caption model (src/lib/capmodels.js): big words
 * behind the person (cut out by a person "front" mask), small words on a track marked `front`.
 * face: { y, h } of the speaker's face in the short (fractions of its height), from the reframe.
 */
function behindCaptions(video, words, W, H, face, model = capmodels.BUILTIN_MODELS.vitor, keywords) {
  const groups = captionClipsFor(video, words, capmodels.groupingFor(model));
  const { back, front } = capmodels.modelCaptions(model, groups, W, H, face, { keywords });
  const withId = (x) => ({ id: uid('c'), auto: true, ...x });
  return { back: back.map(withId), front: front.map(withId) };
}

/** Following the face only makes sense when the source is wider than the short (16:9 -> 9:16, 1:1, 4:5). */
function canFollowFace(media, preset) {
  const [w, h] = shortSize(preset || '9:16');
  return media?.width > 0 && media?.height > 0 && media.width / media.height > (w / h) * 1.05;
}

/**
 * One short as a Cinemex project.
 * @param {{path:string,name?:string,duration?:number,width?:number,height?:number,fps?:number,hasAudio?:boolean,transcript:object[]}} media
 * @param {{start:number,end:number,hook?:string,outro?:string,title?:string}} c
 * @param {{style?:string,reframe?:'cover'|'fit'|'face',cards?:boolean,preset?:string,framed?:{path:string,width:number,height:number},layout?:'atras',model?:object,face?:{y:number,h:number},personMatte?:string}} o
 *   layout 'atras' = big main word behind the person, small words in front (needs personMatte, the
 *   grey matte video of the clip's source range)
 *   framed = the segment already cropped to follow the speaker (electron/reframe.cjs): the short then
 *   plays that file from 0 and its transcript is moved to the segment's own time.
 */
function shortProject(media, c, o = {}) {
  const preset = o.preset || '9:16';
  const size = shortSize(preset);
  const mediaId = uid('m');
  const len = r3(c.end - c.start);
  const video = { id: uid('c'), mediaId, start: 0, in: r3(c.start), out: r3(c.end), fit: o.reframe === 'fit' ? 'fit' : 'fill', volume: 1, speed: 1 };
  const words = media.transcript || [];
  const model = o.model || (o.layout === 'atras' ? capmodels.BUILTIN_MODELS.vitor : null);
  const behind = model && o.personMatte ? behindCaptions(video, words, size[0], size[1], o.face, model, o.keywords) : null;
  const caps = behind ? behind.back : captionClipsFor(video, words, { style: o.style || 'felipe', stripPunct: true }).map((x) => ({ id: uid('c'), auto: true, ...x }));
  let mediaEntry = { id: mediaId, path: media.path, name: media.name || path.basename(media.path), kind: 'video', duration: media.duration || c.end, width: media.width, height: media.height, fps: media.fps || 30, hasAudio: media.hasAudio !== false, thumb: null, transcript: words };
  if (o.framed?.path) {
    // Captions were placed from the source window above; the clip now plays the cropped file from 0.
    video.in = 0;
    video.out = len;
    video.fit = 'fill';
    const moved = words.filter((w) => w.s >= c.start - 0.05 && w.e <= c.end + 0.05).map((w) => ({ ...w, s: r3(Math.max(0, w.s - c.start)), e: r3(Math.max(0, w.e - c.start)) }));
    mediaEntry = { ...mediaEntry, path: o.framed.path, name: path.basename(o.framed.path), duration: len, width: o.framed.width, height: o.framed.height, fps: 30, transcript: moved };
  }
  if (behind) {
    // The person (everyone in the shot) drawn again over the big words.
    video.masks = [{ id: uid('mk'), shape: 'person', matte: { file: o.personMatte, in: video.in, out: video.out, px: -1, py: -1 }, x: 0.5, y: 0.5, w: 1, h: 1, feather: 0, invert: false, mode: 'front', amount: 1 }];
  }
  const cards = [];
  // With the big words behind the head the top is taken: the cards go low, over the legs.
  const cardY = behind ? 0.8 : CARD_Y;
  // Edited-short touches (src/lib/polish.js): punches and sound effects on the big words, progress
  // bar, call to action at the end (it replaces the closing card).
  const cta = o.cta ? polish.ctaClip(o.cta, len, { y: behind ? 0.8 : 0.82 }) : null;
  const beats = polish.beatsFromCaptions(caps, { duration: len, tail: cta ? 2.5 : 0.8 });
  if (o.punch) video.keyframes = { zoom: polish.punchKeyframes(beats, video, { amount: typeof o.punch === 'number' ? o.punch : 0.12 }) };
  const sfxClips = [];
  const sfxMedia = [];
  if (o.sfx && Array.isArray(o.sfxList)) {
    for (const s of polish.sfxPlan(beats, { every: 2, volume: 0.12 })) {
      const fx = o.sfxList.find((x) => x.id === s.id);
      if (!fx) continue;
      let m = sfxMedia.find((x) => x.path === fx.path);
      if (!m) sfxMedia.push((m = { id: uid('m'), path: fx.path, name: fx.label, kind: 'audio', duration: fx.duration, hasAudio: true, thumb: null }));
      const lead = s.id === 'whoosh' || s.id === 'swoosh' ? fx.duration / 2 : 0;
      sfxClips.push({ id: uid('c'), mediaId: m.id, start: r3(Math.max(0, s.at - lead)), in: 0, out: fx.duration, volume: s.volume, speed: 1 });
    }
  }
  const musicMedia = [];
  let musicPieces = [];
  if (o.musicTrack?.path) {
    const mid = uid('m');
    musicMedia.push({ id: mid, path: o.musicTrack.path, name: o.musicTrack.name || path.basename(o.musicTrack.path), kind: 'audio', duration: o.musicTrack.duration || len, hasAudio: true, thumb: null });
    musicPieces = musicClips(o.musicTrack, len, { mediaId: mid, volume: 0.16 }).map((x) => ({ id: uid('c'), ...x }));
  }
  if (o.progress) cards.push({ id: uid('c'), ...polish.progressClip(len) });
  if (cta) cards.push({ id: uid('c'), ...cta });
  if (o.cards !== false && c.hook) cards.push({ id: uid('c'), start: 0, in: 0, out: Math.min(2.6, len / 3), text: c.hook, graphic: { kind: 'title', title: c.hook, y: cardY } });
  if (o.cards !== false && !cta && c.outro && len > 8) cards.push({ id: uid('c'), start: r3(Math.max(0, len - 2.6)), in: 0, out: 2.6, text: c.outro, graphic: { kind: 'title', title: c.outro, y: cardY } });
  // B-roll cut-aways (o.brolls, short time): their own track over V1; V1 is split around them so
  // the person mask is not drawn over the B-roll.
  const brMedia = [];
  const brClips = [];
  for (const b of o.brolls || []) {
    const mid = uid('m');
    brMedia.push({ id: mid, path: b.path, name: b.name || path.basename(b.path), kind: 'video', duration: b.duration || b.len, width: b.width, height: b.height, fps: 30, hasAudio: false, thumb: null });
    const d = Math.max(0.5, Math.min(b.len, (b.duration || b.len) - 0.1));
    const inn = r3(Math.min(0.4, Math.max(0, (b.duration || d) - d)));
    brClips.push({ id: uid('c'), mediaId: mid, start: r3(b.at), in: inn, out: r3(inn + d), fit: 'fill', volume: 0, speed: 1 });
  }
  const v1 = brClips.length && video.masks?.length ? brollLib.splitAround(video, brClips.map((x) => ({ start: x.start, end: x.start + (x.out - x.in) }))).map((x) => ({ id: uid('c'), ...x })) : [video];
  return {
    version: 1,
    name: c.title || c.hook || 'Short',
    canvas: { w: size[0], h: size[1], fps: 30, preset },
    audio: { normalize: true, ...(musicPieces.length ? { duck: true } : {}) },
    media: [mediaEntry, ...sfxMedia, ...musicMedia, ...brMedia],
    tracks: [
      { id: 'v1', kind: 'video', name: 'V1', clips: v1 },
      ...(brClips.length ? [{ id: 'br', kind: 'video', name: 'B-roll', clips: brClips }] : []),
      { id: 'v2', kind: 'video', name: 'V2', clips: [] },
      { id: 'tx', kind: 'text', name: behind ? 'Legendas atrás' : 'Legendas', clips: caps },
      ...(behind && behind.front.length ? [{ id: 'tf', kind: 'text', name: 'Legendas à frente', front: true, clips: behind.front }] : []),
      { id: 'gx', kind: 'text', name: 'Grafismos', front: behind ? true : undefined, clips: cards },
      { id: 'a1', kind: 'audio', name: 'Música', clips: musicPieces },
      ...(sfxClips.length ? [{ id: 'sx', kind: 'audio', name: 'Efeitos', clips: sfxClips }] : []),
    ],
  };
}

/**
 * B-roll for the range [from, to] of the source (seconds): the AI proposes inserts, each one is
 * matched to the folder library or searched on Pexels. Returns inserts in clip time (0 = from).
 */
async function planBroll(words, from, to, o, onStatus = () => {}) {
  const lib = await o.brollSrc.library({ onStatus });
  const lines = ai.transcriptLines(words, from, to).replace(/\[(\d+):(\d+):(\d+)\]/g, (_, h, m, s) => `[${Number(h) * 3600 + Number(m) * 60 + Number(s)}]`);
  const json = await o.ask(brollLib.brollPrompt(lines, { max: Math.min(4, Math.max(1, Math.round((to - from) / 15))), library: lib.map((l) => `${l.name}${l.desc ? ` (${l.desc})` : ''}`) }), 'haiku');
  const inserts = brollLib.parseInserts(json, { from, to });
  const used = new Set();
  const out = [];
  for (const ins of inserts) {
    let src = brollLib.matchLibrary(ins, lib, { used });
    if (!src && o.brollSrc.hasPexels()) src = await o.brollSrc.pexels(ins.en || ins.pt).catch(() => null);
    if (!src) continue;
    used.add(src.path);
    // The lines carry whole seconds: start on the nearest word.
    const w = words.filter((x) => x.s >= from && x.s <= to).reduce((b, x) => (Math.abs(x.s - ins.at) < Math.abs((b?.s ?? Infinity) - ins.at) ? x : b), null);
    if (w && Math.abs(w.s - ins.at) <= 1.2) ins.at = w.s;
    out.push({ at: Math.round((ins.at - from) * 1000) / 1000, len: ins.len, path: src.path, name: src.name, duration: src.duration, width: src.width, height: src.height, source: src.source });
  }
  return out;
}

/**
 * Builds and exports every chosen moment. Files: <outDir>/clip_NN_<slug>.mp4, .md and
 * Projetos Cinemex/clip_NN_<slug>.ecproj, plus index.md.
 */
async function buildShorts(media, clips, outDir, o = {}) {
  if (!media?.path || !fs.existsSync(media.path)) throw new Error('O vídeo original já não está no disco');
  if (!Array.isArray(clips) || !clips.length) throw new Error('Escolhe pelo menos um momento');
  fs.mkdirSync(path.join(outDir, 'Projetos Cinemex'), { recursive: true });
  const done = [];
  for (let i = 0; i < clips.length; i++) {
    if (o.signal?.aborted) throw new Error('Cancelado');
    const c = clips[i];
    const base = `clip_${String(i + 1).padStart(2, '0')}_${ai.slug(c.title || c.hook)}`;
    let framed = null;
    let face = null;
    if (o.reframe === 'face' && o.reframer && canFollowFace(media, o.preset)) {
      const [outW, outH] = shortSize(o.preset || '9:16');
      const r = await o.reframer.reframe(
        { file: media.path, tin: c.start, tout: c.end, srcW: media.width, srcH: media.height, outW, outH, encoder: o.encoder || 'libx264' },
        { signal: o.signal, onStatus: (status) => o.onProgress?.({ index: i, of: clips.length, progress: 0, name: base, status }), onProgress: (p) => o.onProgress?.({ index: i, of: clips.length, progress: p * 0.5, name: base, status: 'A seguir a cara…' }) },
      );
      framed = { path: r.file, width: outW, height: outH };
      if (r.faceY) face = { y: r.faceY, h: r.faceH };
    }
    let personMatte = null;
    if ((o.model || o.layout === 'atras') && o.matter) {
      const len = c.end - c.start;
      personMatte = await o.matter.matte(
        { file: framed ? framed.path : media.path, tin: framed ? 0 : c.start, tout: framed ? len : c.end, x: null, y: null },
        { signal: o.signal, onStatus: (status) => o.onProgress?.({ index: i, of: clips.length, progress: 0.5, name: base, status }), onProgress: (p) => o.onProgress?.({ index: i, of: clips.length, progress: 0.5 + p * 0.2, name: base, status: 'A recortar a pessoa…' }) },
      );
    }
    // AI passes (Claude, no tools): fix what Whisper heard wrong in this clip, then pick the strongest
    // word of each caption block for the big words behind the person.
    let clipMedia = media;
    let fixed = [];
    let keywords;
    if (o.ask && o.review !== false) {
      try {
        const lines = ai.transcriptLines(media.transcript || [], c.start, c.end);
        // The Gui's own past fixes first (always), then what the AI finds.
        const fixes = [...(o.learned?.words || []).map((w) => ({ wrong: w.from, right: w.to })), ...ai.parseSpellFixes(await o.ask(ai.spellPrompt(lines, { context: c.title || c.hook, learned: o.learned?.words }), 'sonnet'))];
        if (fixes.length) {
          const r = ai.applySpellFixes(media.transcript || [], fixes);
          fixed = r.applied.filter((x) => x.s >= c.start - 0.5 && x.s <= c.end + 0.5);
          clipMedia = { ...media, transcript: r.words };
        }
      } catch {
        /* review is a bonus: the short is made with the plain transcript */
      }
    }
    const model = o.model || (o.layout === 'atras' ? capmodels.BUILTIN_MODELS.vitor : null);
    if (o.ask && model?.kind === 'atras-frente' && o.keywordAI !== false) {
      try {
        const win = { start: 0, in: c.start, out: c.end, speed: 1 };
        const blocks = captionClipsFor(win, clipMedia.transcript || [], capmodels.groupingFor(model)).map((g) => (g.words || []).map((w) => w.w));
        keywords = ai.parseKeywordPicks(await o.ask(ai.keywordPrompt(blocks, { learned: o.learned?.keywords }), 'sonnet'), blocks);
      } catch {
        keywords = undefined;
      }
    }
    // Music: the Gui's folder first (mood from what is said, or the pack's), ElevenLabs once per mood.
    let musicTrack = null;
    let musicNote = null;
    if (o.music && o.musicLib) {
      try {
        const mood = o.music === 'auto' ? moodFromText(ai.textBetween(clipMedia.transcript || [], c.start, c.end)) : o.music;
        musicTrack = await o.musicLib.pick(mood, { seed: base, onStatus: (status) => o.onProgress?.({ index: i, of: clips.length, progress: 0.7, name: base, status }) });
      } catch (e) {
        musicNote = String(e?.message || e);
      }
    }
    // B-roll: Claude picks 2-4 concrete moments, each matched to the Gui's folder or Pexels.
    let brolls = [];
    if (o.broll && o.brollSrc && o.ask) {
      try {
        brolls = await planBroll(clipMedia.transcript || [], c.start, c.end, o, (status) => o.onProgress?.({ index: i, of: clips.length, progress: 0.75, name: base, status }));
      } catch {
        brolls = [];
      }
    }
    const project = shortProject(clipMedia, c, { ...o, framed, face, personMatte, keywords, musicTrack, brolls });
    const proj = path.join(outDir, 'Projetos Cinemex', `${base}.ecproj`);
    fs.writeFileSync(proj, JSON.stringify(project, null, 1), 'utf8');
    const mp4 = path.join(outDir, `${base}.mp4`);
    await runExport(project, mp4, {
      encoder: o.encoder || 'libx264',
      quality: o.quality || 'alta',
      signal: o.signal,
      onProgress: (p) => o.onProgress?.({ index: i, of: clips.length, progress: personMatte ? 0.7 + p * 0.3 : framed ? 0.5 + p * 0.5 : p, name: base }),
    });
    fs.writeFileSync(path.join(outDir, `${base}.md`), ai.publishText(c), 'utf8');
    done.push({ ...c, file: mp4, project: proj, name: base, fixed, music: musicTrack?.name ?? null, musicNote, broll: brolls.map((b) => b.name) });
  }
  const index = ['# Shorts', '', '| # | Ficheiro | Duração | Pontuação | Gancho |', '|---|---|---|---|---|', ...done.map((d, i) => `| ${i + 1} | ${d.name}.mp4 | ${Math.round(d.duration)} s | ${d.score}/10 | ${String(d.hook).replace(/\|/g, '/')} |`), ''].join('\n');
  fs.writeFileSync(path.join(outDir, 'index.md'), index, 'utf8');
  return done;
}

module.exports = { planBroll, findHotclips, shortProject, buildShorts, canFollowFace, shortSize, behindCaptions };
