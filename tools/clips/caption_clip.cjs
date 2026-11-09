// Burn Cinemex captions onto a reframed 9:16 clip, using the app's own export engine.
// Usage: node caption_clip.cjs <reframed.mp4> <words.json> <srcStart> <srcEnd> <style> <out.mp4> [fixes.json]
const path = require('node:path');
const fs = require('node:fs');
const APP = path.resolve(__dirname, '..', '..');
const { runExport } = require(path.join(APP, 'electron/render.cjs'));
const { captionClipsFor } = require(path.join(APP, 'electron/captions.cjs'));

const [file, wordsFile, s0, s1, style, out, fixesFile] = process.argv.slice(2);
const start = Number(s0);
const end = Number(s1);
const dur = end - start;
const all = JSON.parse(fs.readFileSync(wordsFile, 'utf8')).words;
// Word fixes: {"wrong": "right"} applied to single words (case kept for the first letter).
const fixes = fixesFile && fs.existsSync(fixesFile) ? JSON.parse(fs.readFileSync(fixesFile, 'utf8')) : {};
const fix = (w) => {
  const bare = w.replace(/[.,!?;:…]+$/, '');
  const tail = w.slice(bare.length);
  const hit = fixes[bare] ?? fixes[bare.toLowerCase()];
  return hit ? hit + tail : w;
};
// Words of this segment, re-timed to the clip (0 = segment start).
const raw = all
  .filter((w) => w.s >= start - 0.05 && w.e <= end + 0.05)
  .map((w) => ({ w: w.w, s: Math.max(0, w.s - start), e: Math.min(dur, w.e - start) }));
// Whisper splits clitics ("pôr" + "-vos", "deixar" + "-te"): glue them back so words never break.
const words = [];
for (const w of raw) {
  if (/^-\p{L}/u.test(w.w) && words.length) {
    const p = words[words.length - 1];
    p.w = p.w.replace(/[.,;:…]+$/, '') + w.w;
    p.e = w.e;
  } else words.push({ ...w });
}
// Spelling fixes now; punctuation is removed by the grouping (stripPunct) after it used it to find phrases.
for (const w of words) w.w = fix(w.w);

const video = { id: 'v', mediaId: 'm', start: 0, in: 0, out: dur, fit: 'fill', volume: 1 };
const caps = captionClipsFor({ start: 0, in: 0, out: dur }, words, { style, stripPunct: true }).map((c, i) => ({ id: `t${i}`, ...c }));
const project = {
  name: path.basename(out),
  canvas: { w: 1080, h: 1920, fps: 30, preset: '9:16' },
  audio: { normalize: true },
  media: [{ id: 'm', path: file, kind: 'video', duration: dur, hasAudio: true }],
  tracks: [
    { id: 'v1', kind: 'video', clips: [video] },
    { id: 'tx', kind: 'text', clips: caps },
  ],
};
runExport(project, out, { encoder: 'h264_nvenc', quality: 'alta' })
  .then(() => console.log(`ok ${caps.length} legendas -> ${out}`))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
