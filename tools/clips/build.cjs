// For each chosen clip: reframe 16:9 -> 9:16 (follows the speaker), write an Cinemex project
// (.ecproj, captions editable in the app) and export the MP4 with the app's own engine.
// Usage: CLIPS_SRC=<video> [CLIPS_YUNET=<yunet.onnx>] node build.cjs <outRoot> [rank,rank,...]
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const APP = path.resolve(__dirname, '..', '..');
const { runExport } = require(path.join(APP, 'electron/render.cjs'));
const { captionClipsFor } = require(path.join(APP, 'electron/captions.cjs'));

const HERE = __dirname;
// Source video and face model come from the environment (no personal paths in the repo).
const SRC = process.env.CLIPS_SRC;
if (!SRC) throw new Error('Define CLIPS_SRC com o caminho do vídeo longo');
const YUNET = process.env.CLIPS_YUNET || path.join(__dirname, 'models', 'yunet.onnx');
const STYLE = 'felipe';
const outRoot = process.argv[2];
const only = process.argv[3] ? new Set(process.argv[3].split(',').map(Number)) : null;
const clips = JSON.parse(fs.readFileSync(path.join(HERE, 'clips.json'), 'utf8'));
const fontes = path.join(outRoot, 'fontes');
const projDir = path.join(outRoot, 'Projetos Cinemex');
fs.mkdirSync(fontes, { recursive: true });
fs.mkdirSync(projDir, { recursive: true });
const safe = (s) => s.replace(/[<>:"/\\|?*]/g, '').trim();
const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 9)}`;

(async () => {
  for (const c of clips) {
    if (only && !only.has(c.rank)) continue;
    const name = `${String(c.rank).padStart(2, '0')} - ${safe(c.title)}`;
    const dur = Math.round((c.end - c.start) * 1000) / 1000;
    const framed = path.join(fontes, `${name} (9x16).mp4`);
    if (!fs.existsSync(framed)) {
      const r = execFileSync('python', ['-I', path.join(HERE, 'reframe.py'), SRC, String(c.start), String(c.end), framed, YUNET], { encoding: 'utf8' });
      console.log(name, r.trim());
    }
    const words = JSON.parse(fs.readFileSync(path.join(HERE, 'cw', `clip${String(c.rank).padStart(2, '0')}.words.json`), 'utf8')).words;
    const mediaId = uid('m');
    const video = { id: uid('c'), mediaId, start: 0, in: 0, out: dur, fit: 'fill', volume: 1, speed: 1 };
    const caps = captionClipsFor({ start: 0, in: 0, out: dur }, words, { style: STYLE, stripPunct: true }).map((x) => ({ id: uid('c'), ...x }));
    const project = {
      version: 1,
      name,
      canvas: { w: 1080, h: 1920, fps: 30, preset: '9:16' },
      audio: { normalize: true },
      media: [{ id: mediaId, path: framed, name: path.basename(framed), kind: 'video', duration: dur, width: 1080, height: 1920, fps: 30, hasAudio: true, thumb: null, transcript: words }],
      tracks: [
        { id: 'v1', kind: 'video', name: 'V1', clips: [video] },
        { id: 'v2', kind: 'video', name: 'V2', clips: [] },
        { id: 'tx', kind: 'text', name: 'Legendas', clips: caps },
        { id: 'a1', kind: 'audio', name: 'Música', clips: [] },
      ],
    };
    fs.writeFileSync(path.join(projDir, `${name}.ecproj`), JSON.stringify(project, null, 1), 'utf8');
    const out = path.join(outRoot, `${name}.mp4`);
    await runExport(project, out, { encoder: 'h264_nvenc', quality: 'alta' });
    console.log(`ok ${name}: ${caps.length} legendas, ${dur}s`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
