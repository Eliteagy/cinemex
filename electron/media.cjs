// Media: ffprobe metadata, a thumbnail per file, and the audio waveform-free basics the editor needs.
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');

const FFPROBE = process.env.ELITE_FFPROBE || 'ffprobe';
const FFMPEG = process.env.ELITE_FFMPEG || 'ffmpeg';
const VIDEO = /\.(mp4|mov|m4v|mkv|webm|avi|mts|m2ts|mxf)$/i;
const AUDIO = /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i;
const IMAGE = /\.(png|jpe?g|webp|bmp|gif|heic|tiff?)$/i;

function run(cmd, args, { encoding = 'utf8', timeout = 60_000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding, timeout, maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(err.code === 'ENOENT' ? `${cmd} não encontrado` : String(stderr || err.message).slice(-400)));
      else resolve(stdout);
    });
  });
}

function kindOf(file) {
  if (VIDEO.test(file)) return 'video';
  if (AUDIO.test(file)) return 'audio';
  if (IMAGE.test(file)) return 'image';
  return null;
}

async function probe(file) {
  const kind = kindOf(file);
  if (!kind) throw new Error(`Formato não suportado: ${path.basename(file)}`);
  const out = JSON.parse(await run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
  const v = (out.streams || []).find((s) => s.codec_type === 'video');
  const a = (out.streams || []).find((s) => s.codec_type === 'audio');
  const duration = kind === 'image' ? 5 : Number(out.format?.duration || v?.duration || a?.duration || 0);
  let fps = 30;
  if (v?.avg_frame_rate && v.avg_frame_rate.includes('/')) {
    const [n, d] = v.avg_frame_rate.split('/').map(Number);
    if (n && d) fps = Math.round((n / d) * 100) / 100;
  }
  return {
    id: 'm_' + crypto.createHash('sha1').update(file).digest('hex').slice(0, 10),
    path: file,
    name: path.basename(file),
    kind,
    duration: Math.round(duration * 1000) / 1000,
    width: v?.width || 0,
    height: v?.height || 0,
    fps,
    hasAudio: Boolean(a),
  };
}

/** Small JPEG thumbnail as a data URL (frame at 10% of the clip, max 1 s in). */
async function thumbnail(m) {
  if (m.kind === 'audio') return null;
  const at = m.kind === 'image' ? 0 : Math.min(1, m.duration * 0.1);
  const buf = await run(FFMPEG, ['-v', 'error', '-ss', String(at), '-i', m.path, '-frames:v', '1', '-vf', 'scale=320:-2', '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '5', 'pipe:1'], { encoding: 'buffer' });
  return 'data:image/jpeg;base64,' + Buffer.from(buf).toString('base64');
}

/**
 * Audio peaks for the waveform: mono 8 kHz decoded by ffmpeg, the loudest sample of every
 * 10 ms as one byte (0-255), base64. 100 values per second.
 */
function peaks(file, duration = 0) {
  const { spawn } = require('node:child_process');
  const rate = duration > 3600 ? 2000 : 8000;
  const per = rate / 100;
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1'], { windowsHide: true });
    const out = [];
    let max = 0;
    let n = 0;
    let carry = null;
    p.stdout.on('data', (chunk) => {
      let buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      const even = buf.length - (buf.length % 2);
      carry = even < buf.length ? buf.subarray(even) : null;
      for (let i = 0; i < even; i += 2) {
        const v = Math.abs(buf.readInt16LE(i));
        if (v > max) max = v;
        if (++n >= per) {
          out.push(Math.min(255, Math.round((max / 32768) * 255 * 1.4)));
          max = 0;
          n = 0;
        }
      }
    });
    p.on('error', () => resolve(null));
    p.on('close', () => resolve(out.length ? Buffer.from(out).toString('base64') : null));
  });
}

async function importFile(file) {
  const m = await probe(file);
  try {
    m.thumb = await thumbnail(m);
  } catch {
    m.thumb = null;
  }
  if (m.hasAudio) m.peaks = await peaks(file, m.duration);
  return m;
}

/** Freeze frame: one frame of a video at `time` (s) written as a PNG in `dir`. Resolves with its path. */
function freezeFrame(file, time, dir) {
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${path.parse(file).name}-${Math.round(time * 1000)}ms-${Date.now().toString(36)}.png`);
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-v', 'error', '-y', '-ss', String(Math.max(0, time)), '-i', file, '-frames:v', '1', out], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 && fs.existsSync(out) ? resolve(out) : reject(new Error(`Não consegui tirar a imagem: ${err.trim().split('\n').pop() || code}`))));
  });
}

module.exports = { probe, thumbnail, importFile, kindOf, peaks, freezeFrame };
