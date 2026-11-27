// Shorts from a whole folder ("Pasta inteira"): every video is transcribed (one at a time, GPU),
// the AI finds its best moments, and all the moments come back in one list, best first. The state
// lives in <folder>\.cinemex-lote.json (+ the transcripts in .cinemex-lote\), so closing the app in
// the middle loses nothing: the next scan goes on from where it stopped.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EXT = /\.(mp4|mov|m4v|mkv|webm)$/i;

function createBatch({ transcribe, findHotclips, probe }) {
  const stateFile = (folder) => path.join(folder, '.cinemex-lote.json');
  const wordsFile = (folder, video) => path.join(folder, '.cinemex-lote', `${crypto.createHash('sha1').update(path.basename(video)).digest('hex').slice(0, 12)}.words.json`);
  const readState = (folder) => {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile(folder), 'utf8'));
      return s && typeof s === 'object' && s.videos && typeof s.videos === 'object' ? s : { version: 1, videos: {} };
    } catch {
      return { version: 1, videos: {} };
    }
  };
  const writeState = (folder, s) => fs.writeFileSync(stateFile(folder), JSON.stringify(s, null, 1), 'utf8');

  /** Videos of the folder (not subfolders; shorts made by Cinemex are skipped). */
  const videos = (folder) =>
    fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((e) => e.isFile() && EXT.test(e.name) && !/^clip_\d\d_/.test(e.name))
      .map((e) => path.join(folder, e.name))
      .sort();

  /**
   * Transcribes and searches every video not done yet. Resolves with every moment:
   * [{ video, name, ...hotclip }], best score first. onProgress({ step, of, video, phase }).
   */
  async function scan(folder, { count = 5, min = 20, max = 60, context, onProgress = () => {}, signal } = {}) {
    const list = videos(folder);
    if (!list.length) throw new Error('Esta pasta não tem vídeos (mp4, mov, mkv)');
    fs.mkdirSync(path.join(folder, '.cinemex-lote'), { recursive: true });
    const state = readState(folder);
    for (const [i, v] of list.entries()) {
      if (signal?.aborted) throw new Error('Cancelado');
      const key = path.basename(v);
      const st = fs.statSync(v);
      let entry = state.videos[key];
      if (entry && entry.size !== st.size) entry = null; // file changed: start that one again
      entry ??= { size: st.size, status: 'pending', clips: [] };
      state.videos[key] = entry;
      const wf = wordsFile(folder, v);
      if (entry.status === 'pending' || !fs.existsSync(wf)) {
        onProgress({ step: i + 1, of: list.length, video: key, phase: 'A transcrever' });
        const r = await transcribe(v);
        fs.writeFileSync(wf, JSON.stringify(r.words || []), 'utf8');
        entry.status = 'transcribed';
        writeState(folder, state);
      }
      if (entry.status === 'transcribed') {
        onProgress({ step: i + 1, of: list.length, video: key, phase: 'A procurar momentos' });
        const words = JSON.parse(fs.readFileSync(wf, 'utf8'));
        entry.clips = words.length >= 20 ? await findHotclips(words, { count, min, max, context, signal }) : [];
        entry.status = 'found';
        writeState(folder, state);
      }
    }
    return list
      .flatMap((v) => (state.videos[path.basename(v)]?.clips || []).map((c) => ({ ...c, video: v, name: path.basename(v) })))
      .sort((a, b) => b.score - a.score || a.start - b.start);
  }

  /** The media object buildShorts needs for one video of the folder (with its saved transcript). */
  async function mediaFor(folder, video) {
    const p = await probe(video);
    const words = JSON.parse(fs.readFileSync(wordsFile(folder, video), 'utf8'));
    return { path: video, name: path.basename(video), duration: p.duration, width: p.width, height: p.height, fps: p.fps || 30, hasAudio: p.hasAudio !== false, transcript: words };
  }

  return { scan, mediaFor, videos, readState };
}

module.exports = { createBatch };
