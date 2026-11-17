// Voice dub from the captions (VideoCraft tts_dubbing.py, docs/engenharia-reversa/videocraft.md §5.8):
// each caption is spoken by ElevenLabs, measured, and sped up (up to maxSpeed, atempo keeps the pitch)
// only when it does not fit before the next caption starts; it never gets cut. The lines are then
// placed at their caption times in one audio file the length of the timeline.
//
// The ElevenLabs key comes from the ELEVENLABS_API_KEY environment variable (never stored by the app).
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { FFMPEG, FFPROBE } = require('./bin.cjs');

const API = 'https://api.elevenlabs.io/v1';
/** ElevenLabs premade multilingual voice used when none is chosen. */
const DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb';
const MODEL = 'eleven_multilingual_v2';
const VOICE_ID = /^[A-Za-z0-9]{10,40}$/;

function apiKey(env = process.env) {
  const k = env.ELEVENLABS_API_KEY;
  if (!k) throw new Error('Falta a chave da ElevenLabs (variável ELEVENLABS_API_KEY).');
  return k;
}

async function listVoices(env) {
  const r = await fetch(`${API}/voices`, { headers: { 'xi-api-key': apiKey(env) } });
  if (!r.ok) throw new Error(`ElevenLabs: ${r.status}`);
  const j = await r.json();
  return (j.voices || []).map((v) => ({ id: v.voice_id, name: v.name, labels: v.labels || {} }));
}

async function speak(text, { voiceId = DEFAULT_VOICE, env, signal } = {}) {
  if (!VOICE_ID.test(voiceId)) throw new Error('Voz inválida');
  const r = await fetch(`${API}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey(env), 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({ text: String(text).slice(0, 2000), model_id: MODEL }),
    signal,
  });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}

const probeDur = (file) =>
  new Promise((res, rej) =>
    execFile(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { windowsHide: true }, (e, out) => (e ? rej(e) : res(Number(String(out).trim()) || 0))),
  );

const ff = (args, cwd) =>
  new Promise((res, rej) => {
    const p = spawn(FFMPEG, ['-v', 'error', '-y', ...args], { cwd, windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', rej);
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(err.slice(0, 400) || `ffmpeg ${c}`))));
  });

/** atempo chain for a speed factor (each atempo stage is limited to 0.5..2). */
function atempo(speed) {
  const out = [];
  let s = speed;
  while (s > 2) {
    out.push('atempo=2');
    s /= 2;
  }
  out.push(`atempo=${s.toFixed(4)}`);
  return out.join(',');
}

/**
 * Plan for the lines: speed = natural / budget when it does not fit (capped), overflow when even
 * maxSpeed is not enough. budget = time until the next caption starts (not just the caption's end).
 */
function fitPlan(cues, durations, { maxSpeed = 1.5, total } = {}) {
  return cues.map((c, i) => {
    const next = cues[i + 1]?.start ?? total ?? c.end + 2;
    const budget = Math.max(0.2, next - c.start);
    const natural = durations[i];
    const speed = natural > budget ? Math.min(maxSpeed, natural / budget) : 1;
    return { start: c.start, natural, speed: Math.round(speed * 1000) / 1000, placed: natural / speed, overflow: natural / speed > budget + 0.05 };
  });
}

/**
 * Dub: cues [{start, end, text}] in timeline seconds -> one WAV at outFile, total seconds long.
 * Returns the plan per line.
 */
async function dub(cues, { outFile, total, voiceId, maxSpeed = 1.5, env, signal, onProgress, workDir }) {
  const list = (cues || []).filter((c) => String(c.text || '').trim() && c.end > c.start).sort((a, b) => a.start - b.start);
  if (!list.length) throw new Error('Não há legendas com texto para dobrar');
  const dir = fs.mkdtempSync(path.join(workDir, 'dub-'));
  try {
    const files = [];
    for (let i = 0; i < list.length; i++) {
      if (signal?.aborted) throw new Error('Cancelado');
      onProgress?.({ step: i + 1, of: list.length });
      const f = path.join(dir, `l${i}.mp3`);
      fs.writeFileSync(f, await speak(list[i].text, { voiceId, env, signal }));
      files.push(f);
    }
    const durs = [];
    for (const f of files) durs.push(await probeDur(f));
    const plan = fitPlan(list, durs, { maxSpeed, total });
    // Mix in groups of 40 inputs (command length), then mix the groups.
    const parts = [];
    for (let g = 0; g < files.length; g += 40) {
      const idx = files.slice(g, g + 40).map((_, k) => g + k);
      const args = [];
      idx.forEach((i) => args.push('-i', path.basename(files[i])));
      const chains = idx.map((i, k) => `[${k}:a]aresample=48000,${atempo(plan[i].speed)},adelay=${Math.round(plan[i].start * 1000)}:all=1[a${k}]`);
      const mix = `${idx.map((_, k) => `[a${k}]`).join('')}amix=inputs=${idx.length}:normalize=0:dropout_transition=0,apad=whole_dur=${(total || 0).toFixed(3)}[out]`;
      fs.writeFileSync(path.join(dir, `g${g}.txt`), `${chains.join(';')};${mix}`);
      const part = `part${g}.wav`;
      await ff([...args, '-/filter_complex', `g${g}.txt`, '-map', '[out]', '-ac', '2', '-ar', '48000', part], dir);
      parts.push(part);
    }
    if (parts.length === 1) fs.copyFileSync(path.join(dir, parts[0]), outFile);
    else {
      const args = [];
      parts.forEach((p) => args.push('-i', p));
      await ff([...args, '-filter_complex', `${parts.map((_, k) => `[${k}:a]`).join('')}amix=inputs=${parts.length}:normalize=0[out]`, '-map', '[out]', path.resolve(outFile)], dir);
    }
    return plan;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { dub, fitPlan, atempo, listVoices, speak, DEFAULT_VOICE };
