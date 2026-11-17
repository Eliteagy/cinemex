// Best moments -> batch of shorts (from VideoCraft, docs/engenharia-reversa/videocraft.md §5.6, §5.9):
// the AI picks moments in a long video's transcript (electron/llm.cjs, no tools), the editor checks
// them against the real words (src/lib/aivideo.js), then each chosen moment becomes its own Cinemex
// project (9:16, captions, hook and closing cards) saved as .ecproj and exported as MP4, with a
// publish note per short and an index.
const fs = require('node:fs');
const path = require('node:path');
const { askJson } = require('./llm.cjs');
const { captionClipsFor } = require('./captions.cjs');
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

/**
 * One short as a Cinemex project.
 * @param {{path:string,name?:string,duration?:number,width?:number,height?:number,fps?:number,hasAudio?:boolean,transcript:object[]}} media
 * @param {{start:number,end:number,hook?:string,outro?:string,title?:string}} c
 * @param {{style?:string,reframe?:'cover'|'fit',cards?:boolean,preset?:string}} o
 */
function shortProject(media, c, o = {}) {
  const preset = o.preset || '9:16';
  const size = { '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '16:9': [1920, 1080] }[preset] || [1080, 1920];
  const mediaId = uid('m');
  const len = r3(c.end - c.start);
  const video = { id: uid('c'), mediaId, start: 0, in: r3(c.start), out: r3(c.end), fit: o.reframe === 'fit' ? 'fit' : 'fill', volume: 1, speed: 1 };
  const words = media.transcript || [];
  const caps = captionClipsFor(video, words, { style: o.style || 'felipe', stripPunct: true }).map((x) => ({ id: uid('c'), auto: true, ...x }));
  const cards = [];
  if (o.cards !== false && c.hook) cards.push({ id: uid('c'), start: 0, in: 0, out: Math.min(2.6, len / 3), text: c.hook, graphic: { kind: 'title', title: c.hook, y: 0.22 } });
  if (o.cards !== false && c.outro && len > 8) cards.push({ id: uid('c'), start: r3(Math.max(0, len - 2.6)), in: 0, out: 2.6, text: c.outro, graphic: { kind: 'title', title: c.outro, y: 0.22 } });
  return {
    version: 1,
    name: c.title || c.hook || 'Short',
    canvas: { w: size[0], h: size[1], fps: 30, preset },
    audio: { normalize: true },
    media: [{ id: mediaId, path: media.path, name: media.name || path.basename(media.path), kind: 'video', duration: media.duration || c.end, width: media.width, height: media.height, fps: media.fps || 30, hasAudio: media.hasAudio !== false, thumb: null, transcript: words }],
    tracks: [
      { id: 'v1', kind: 'video', name: 'V1', clips: [video] },
      { id: 'v2', kind: 'video', name: 'V2', clips: [] },
      { id: 'tx', kind: 'text', name: 'Legendas', clips: caps },
      { id: 'gx', kind: 'text', name: 'Grafismos', clips: cards },
      { id: 'a1', kind: 'audio', name: 'Música', clips: [] },
    ],
  };
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
    const project = shortProject(media, c, o);
    const proj = path.join(outDir, 'Projetos Cinemex', `${base}.ecproj`);
    fs.writeFileSync(proj, JSON.stringify(project, null, 1), 'utf8');
    const mp4 = path.join(outDir, `${base}.mp4`);
    await runExport(project, mp4, {
      encoder: o.encoder || 'libx264',
      quality: o.quality || 'alta',
      signal: o.signal,
      onProgress: (p) => o.onProgress?.({ index: i, of: clips.length, progress: p, name: base }),
    });
    fs.writeFileSync(path.join(outDir, `${base}.md`), ai.publishText(c), 'utf8');
    done.push({ ...c, file: mp4, project: proj, name: base });
  }
  const index = ['# Shorts', '', '| # | Ficheiro | Duração | Pontuação | Gancho |', '|---|---|---|---|---|', ...done.map((d, i) => `| ${i + 1} | ${d.name}.mp4 | ${Math.round(d.duration)} s | ${d.score}/10 | ${String(d.hook).replace(/\|/g, '/')} |`), ''].join('\n');
  fs.writeFileSync(path.join(outDir, 'index.md'), index, 'utf8');
  return done;
}

module.exports = { findHotclips, shortProject, buildShorts };
