// Face-following reframe for shorts ("Seguir a cara"): engine/reframe.py finds the speaker with
// YuNet (OpenCV) and renders the segment already cropped to the short's aspect, with the crop
// following the face. It runs in the same Python venv as the person mattes (matte-venv: numpy +
// opencv). First use sets the venv up and downloads the YuNet model (230 KB, checked by SHA-256).
// Results are cached by source file + range + size, so making the same short again is instant.
const { spawn, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PYTHON, FFMPEG, venvPython } = require('./bin.cjs');

const MODEL_URL = 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx';
const MODEL_SHA256 = '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4';
const SCRIPT = path.join(__dirname, '..', 'engine', 'reframe.py');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 20 * 60_000, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(cmd)}: ${String(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`));
      else resolve(stdout);
    });
  });
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function createReframeEngine(userData, { python = PYTHON, ffmpeg = FFMPEG } = {}) {
  const venv = path.join(userData, 'matte-venv');
  const venvPy = venvPython(venv);
  const model = path.join(userData, 'models', 'face_detection_yunet_2023mar.onnx');
  const dir = path.join(userData, 'reframes');
  let setup = null;

  function ensure(say = () => {}) {
    setup ??= (async () => {
      if (!fs.existsSync(venvPy)) {
        say('A preparar o seguimento de caras (só da primeira vez)…');
        await run(python, ['-m', 'venv', venv]);
      }
      try {
        await run(venvPy, ['-c', 'import numpy, cv2; cv2.FaceDetectorYN; cv2.HOGDescriptor']);
      } catch {
        // OpenCV 5 dropped HOGDescriptor (the "person turned away" fallback); 4.x keeps it and still
        // has everything the person mattes use, so the shared venv is pinned below 5.
        say('A instalar o OpenCV (só da primeira vez, ~1 min)…');
        await run(venvPy, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', 'numpy', 'opencv-python-headless>=4.8,<5']);
      }
      if (!fs.existsSync(model) || sha256(fs.readFileSync(model)) !== MODEL_SHA256) {
        say('A descarregar o detetor de caras (230 KB)…');
        fs.mkdirSync(path.dirname(model), { recursive: true });
        const r = await fetch(MODEL_URL);
        if (!r.ok) throw new Error(`Não consegui descarregar o detetor de caras (${r.status})`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (sha256(buf) !== MODEL_SHA256) throw new Error('O detetor de caras descarregado não é o esperado');
        fs.writeFileSync(model + '.part', buf);
        fs.renameSync(model + '.part', model);
      }
    })().catch((e) => {
      setup = null;
      throw e;
    });
    return setup;
  }

  /**
   * Renders `file` between `tin` and `tout` (source seconds) cropped to outW x outH, following the
   * speaker. srcW/srcH = source size. Resolves with { file, found, samples }.
   */
  async function reframe({ file, tin, tout, srcW, srcH, outW, outH, encoder = 'libx264' }, { onProgress = () => {}, onStatus = () => {}, signal } = {}) {
    if (!(srcW > 0 && srcH > 0)) throw new Error('Não sei o tamanho do vídeo original');
    await ensure(onStatus);
    fs.mkdirSync(dir, { recursive: true });
    const key = crypto
      .createHash('sha1')
      .update(JSON.stringify([path.resolve(file), fs.statSync(file).size, +tin.toFixed(3), +tout.toFixed(3), outW, outH, 1]))
      .digest('hex')
      .slice(0, 16);
    const dest = path.join(dir, `${key}.mp4`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return { file: dest, cached: true };
    const tmp = path.join(dir, `${key}.part.mp4`);
    const args = [SCRIPT, file, String(tin), String(tout), tmp, '--model', model, '--size', `${srcW}x${srcH}`, '--out-size', `${outW}x${outH}`, '--ffmpeg', ffmpeg, '--encoder', encoder];
    onStatus('A seguir a cara de quem fala…');
    const result = await new Promise((resolve, reject) => {
      const p = spawn(venvPy, ['-I', ...args], { windowsHide: true });
      let err = '';
      let buf = '';
      let last = {};
      const abort = () => p.kill();
      signal?.addEventListener('abort', abort);
      p.stdout.on('data', (d) => {
        buf += String(d);
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          try {
            const m = JSON.parse(line);
            if (typeof m.progress === 'number') onProgress(m.progress);
            if (m.done) last = m;
          } catch {
            /* not a JSON line */
          }
        }
      });
      p.stderr.on('data', (d) => (err = (err + String(d)).slice(-2000)));
      p.on('error', reject);
      p.on('close', (code) => {
        signal?.removeEventListener('abort', abort);
        try {
          fs.rmSync(tmp + '.cmd', { force: true });
        } catch {
          /* ignore */
        }
        if (code === 0 && fs.existsSync(tmp)) resolve(last);
        else {
          try {
            fs.rmSync(tmp, { force: true });
          } catch {
            /* ignore */
          }
          reject(new Error(signal?.aborted ? 'Cancelado' : `O seguimento de cara falhou: ${err.trim().split('\n').slice(-2).join(' ') || `código ${code}`}`));
        }
      });
    });
    fs.renameSync(tmp, dest);
    return { file: dest, found: result.found, samples: result.samples };
  }

  return { ensure, reframe, dir };
}

module.exports = { createReframeEngine, MODEL_SHA256 };
