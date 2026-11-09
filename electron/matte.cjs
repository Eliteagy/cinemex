// Person mattes ("Pessoa" mask, captions behind the person): engine/matte.py runs Robust Video
// Matting (ONNX) in its own Python venv in userData, on the GPU through DirectML when there is one.
// First use sets the venv up and downloads the model (~15 MB). Mattes are cached by clip range and
// click point, so asking again is instant.
const { spawn, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MODEL_URL = 'https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx';
const MODEL_BYTES = 14975696;
const SCRIPT = path.join(__dirname, '..', 'engine', 'matte.py');
const PY_PACKAGES = ['onnxruntime-directml', 'numpy', 'opencv-python-headless'];

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 20 * 60_000, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(cmd)}: ${String(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`));
      else resolve(stdout);
    });
  });
}

function createMatteEngine(userData, { python = process.env.ELITE_PYTHON || 'python' } = {}) {
  const venv = path.join(userData, 'matte-venv');
  const venvPy = path.join(venv, 'Scripts', 'python.exe');
  const model = path.join(userData, 'models', 'rvm_mobilenetv3_fp32.onnx');
  const dir = path.join(userData, 'mattes');
  let setup = null;

  /** Venv + packages + model, once. `say` reports what is happening. */
  function ensure(say) {
    setup ??= (async () => {
      if (!fs.existsSync(venvPy)) {
        say('A preparar o recorte de pessoas (só da primeira vez)…');
        await run(python, ['-m', 'venv', venv]);
      }
      try {
        await run(venvPy, ['-c', 'import onnxruntime, numpy, cv2']);
      } catch {
        say('A instalar o motor de recorte (só da primeira vez, ~1 min)…');
        await run(venvPy, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', ...PY_PACKAGES]);
      }
      if (!fs.existsSync(model) || fs.statSync(model).size !== MODEL_BYTES) {
        say('A descarregar o modelo de recorte (15 MB)…');
        fs.mkdirSync(path.dirname(model), { recursive: true });
        const r = await fetch(MODEL_URL);
        if (!r.ok) throw new Error(`Não consegui descarregar o modelo (${r.status})`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length !== MODEL_BYTES) throw new Error('O modelo descarregado não tem o tamanho certo');
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
   * Matte for `file` between `tin` and `tout` (source seconds). x/y (0..1): keep only the person
   * under that point. onProgress(0..1). Resolves with the matte file path.
   */
  async function matte({ file, tin, tout, x, y }, { onProgress = () => {}, onStatus = () => {}, signal } = {}) {
    await ensure(onStatus);
    fs.mkdirSync(dir, { recursive: true });
    const key = crypto.createHash('sha1').update(JSON.stringify([path.resolve(file), fs.statSync(file).size, +tin.toFixed(3), +tout.toFixed(3), x == null ? null : +x.toFixed(3), y == null ? null : +y.toFixed(3), 1])).digest('hex').slice(0, 16);
    const dest = path.join(dir, `${key}.mp4`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
    const tmp = path.join(dir, `${key}.part.mp4`);
    const args = [SCRIPT, file, String(tin), String(tout), tmp, '--model', model];
    if (x != null && y != null) args.push('--x', String(x), '--y', String(y));
    onStatus('A recortar a pessoa…');
    await new Promise((resolve, reject) => {
      const p = spawn(venvPy, args, { windowsHide: true });
      let err = '';
      let buf = '';
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
          } catch {
            /* not a progress line */
          }
        }
      });
      p.stderr.on('data', (d) => (err = (err + String(d)).slice(-2000)));
      p.on('error', reject);
      p.on('close', (code) => {
        signal?.removeEventListener('abort', abort);
        if (code === 0 && fs.existsSync(tmp)) resolve();
        else reject(new Error(signal?.aborted ? 'Recorte cancelado' : `O recorte falhou: ${err.trim().split('\n').slice(-2).join(' ') || `código ${code}`}`));
      });
    });
    fs.renameSync(tmp, dest);
    return dest;
  }

  return { ensure, matte, dir };
}

module.exports = { createMatteEngine };
