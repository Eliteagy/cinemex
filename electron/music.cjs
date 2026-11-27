// Background music for edited shorts. Library = the Gui's folder Música\Cinemex (any mp3/wav/m4a/
// ogg/flac; the mood comes from the file or folder name: calma / media / forte, or words like lofi,
// chill, piano -> calma; epic, trap, energia -> forte). When the folder has nothing for the mood,
// ElevenLabs makes one track per mood ONCE (ELEVENLABS_API_KEY, like electron/dub.cjs) and keeps it
// in userData/music, so later shorts reuse it and spend no credits.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { probe } = require('./media.cjs');
const { musicClips, moodFromText } = require('../src/lib/polish.js');

const MOODS = ['calma', 'media', 'forte'];
const EXT = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;
const WORDS = {
  calma: ['calma', 'calm', 'chill', 'lofi', 'lo-fi', 'piano', 'soft', 'suave', 'ambient', 'relax', 'acoustic'],
  forte: ['forte', 'epic', 'épico', 'epico', 'trap', 'energia', 'energy', 'hype', 'drums', 'power', 'rock', 'phonk'],
  media: ['media', 'média', 'medium', 'pop', 'corporate', 'upbeat', 'groove', 'house'],
};
/** ElevenLabs prompts per mood: instrumental beds that sit under a voice. */
const PROMPTS = {
  calma: 'Instrumental background music for a short real estate / personal development video, calm and warm, soft piano and light pads, slow 80 bpm, no vocals, sits under a voice, seamless and steady',
  media: 'Instrumental background music for a motivational short video, modern and confident, light drums, bass and synth plucks, 105 bpm, no vocals, sits under a voice, steady groove',
  forte: 'Instrumental background music for an energetic viral short, epic cinematic hybrid with punchy drums and deep bass, 125 bpm, no vocals, leaves room for a voice, strong but not busy',
};

/** Mood of a file from its name and folder (null = any). */
function moodOf(file) {
  const s = file.toLowerCase();
  for (const m of ['calma', 'forte', 'media']) if (WORDS[m].some((w) => s.includes(w))) return m;
  return null;
}

function createMusic({ folder, cacheDir, env = process.env, fetchFn = fetch }) {
  const indexFile = path.join(cacheDir, 'music-index.json');
  const readIndex = () => {
    try {
      return JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    } catch {
      return {};
    }
  };

  /** Every track in the folder (recursive, 3 levels) with its mood and duration. */
  async function library() {
    fs.mkdirSync(folder, { recursive: true });
    const files = [];
    const walk = (dir, depth) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory() && depth < 3) walk(f, depth + 1);
        else if (e.isFile() && EXT.test(e.name)) files.push(f);
      }
    };
    walk(folder, 0);
    const idx = readIndex();
    const out = [];
    for (const f of files) {
      const st = fs.statSync(f);
      const key = `${f}|${st.size}|${st.mtimeMs}`;
      if (!idx[key]) {
        try {
          const p = await probe(f);
          idx[key] = { duration: p.duration || 0 };
        } catch {
          continue;
        }
      }
      out.push({ path: f, name: path.basename(f), mood: moodOf(path.relative(folder, f)), duration: idx[key].duration, source: 'pasta' });
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(indexFile, JSON.stringify(idx));
    for (const m of MOODS) {
      const g = path.join(cacheDir, `elevenlabs-${m}.mp3`);
      if (fs.existsSync(g)) out.push({ path: g, name: `ElevenLabs ${m}`, mood: m, duration: (await probe(g).catch(() => ({ duration: 0 }))).duration, source: 'elevenlabs' });
    }
    return out;
  }

  /** One track for the mood: the folder first (stable choice per `seed`), then ElevenLabs once. */
  async function pick(mood, { seed = '', generate = true, onStatus = () => {} } = {}) {
    const m = MOODS.includes(mood) ? mood : 'media';
    const lib = await library();
    const mine = lib.filter((x) => x.source === 'pasta');
    const fit = mine.filter((x) => x.mood === m);
    const pool = fit.length ? fit : mine.filter((x) => !x.mood);
    if (pool.length) {
      const h = crypto.createHash('sha1').update(seed).digest().readUInt32BE(0);
      return pool[h % pool.length];
    }
    const made = lib.find((x) => x.source === 'elevenlabs' && x.mood === m);
    if (made) return made;
    // Nothing for this mood: ElevenLabs once; without it, any track of the folder is better than none.
    const anyMine = () => (mine.length ? mine[crypto.createHash('sha1').update(seed).digest().readUInt32BE(0) % mine.length] : null);
    if (!generate) return anyMine();
    try {
      return await generateTrack(m, { onStatus });
    } catch (e) {
      const any = anyMine();
      if (any) return any;
      throw e;
    }
  }

  /** ElevenLabs music (once per mood, 60 s; longer shorts repeat it). */
  async function generateTrack(mood, { onStatus = () => {} } = {}) {
    const key = env.ELEVENLABS_API_KEY;
    if (!key) throw new Error('Sem música na pasta Música\\Cinemex e sem ELEVENLABS_API_KEY para gerar uma');
    onStatus(`A gerar música (${mood}) no ElevenLabs, só desta vez…`);
    const r = await fetchFn('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128', {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: PROMPTS[mood], music_length_ms: 60_000, model_id: 'music_v1', force_instrumental: true }),
    });
    if (r.status === 402) throw new Error('Sem músicas em Música\\Cinemex, e a conta ElevenLabs grátis não gera música (só planos pagos). Mete lá umas músicas (no nome: calma, media ou forte).');
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`ElevenLabs música ${r.status}: ${t.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 10_000) throw new Error('O ElevenLabs devolveu um ficheiro vazio');
    fs.mkdirSync(cacheDir, { recursive: true });
    const file = path.join(cacheDir, `elevenlabs-${mood}.mp3`);
    fs.writeFileSync(file + '.part', buf);
    fs.renameSync(file + '.part', file);
    const p = await probe(file).catch(() => ({ duration: 120 }));
    return { path: file, name: `ElevenLabs ${mood}`, mood, duration: p.duration || 120, source: 'elevenlabs' };
  }

  return { library, pick, generateTrack, folder };
}

module.exports = { createMusic, musicClips, moodOf, moodFromText, MOODS, PROMPTS };
