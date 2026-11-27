// B-roll sources (src/lib/broll.js has the planning maths):
//   folder  Vídeos\B-roll of the Gui (any mp4/mov/m4v/webm, subfolders too). Each file is indexed
//           once: duration + a short description of a middle frame by Gemini (OmniRoute, like the
//           effects generator); without Gemini the file name is enough. Cache userData/broll-index.json.
//   Pexels  free stock videos; key in %APPDATA%\Cinemex\pexels.key or PEXELS_API_KEY (never in the
//           repo). Portrait files preferred, downloaded once to userData/broll.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { probe } = require('./media.cjs');
const { FFMPEG } = require('./bin.cjs');
const { askGemini } = require('./effectgen.cjs');

const EXT = /\.(mp4|mov|m4v|webm|mkv)$/i;

function frameJpeg(file, at) {
  const out = path.join(os.tmpdir(), `cmx-broll-${process.pid}-${Date.now()}.jpg`);
  return new Promise((resolve) => {
    execFile(FFMPEG, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', '-y', out], { windowsHide: true, timeout: 30_000 }, (err) => {
      if (err || !fs.existsSync(out)) return resolve(null);
      const b = fs.readFileSync(out);
      fs.rmSync(out, { force: true });
      resolve(b);
    });
  });
}

function createBroll({ folder, cacheDir, keyFile, env = process.env, fetchFn = fetch, describe }) {
  const indexFile = path.join(cacheDir, 'broll-index.json');
  const readIndex = () => {
    try {
      return JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    } catch {
      return {};
    }
  };
  /** Gemini (vision) description of one frame, or '' when Gemini is not there. */
  const describeFrame =
    describe ||
    (async (jpeg) => {
      try {
        const r = await askGemini(
          'Descreve esta imagem de um vídeo de B-roll em 4 a 8 palavras em português (o que se vê: objetos, lugar, ação). Responde só com JSON: {"desc":"..."}',
          { image: jpeg },
        );
        return String(r?.desc || '').slice(0, 80);
      } catch {
        return '';
      }
    });

  async function library({ onStatus = () => {} } = {}) {
    fs.mkdirSync(folder, { recursive: true });
    const files = [];
    const walk = (dir, depth) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory() && depth < 3) walk(f, depth + 1);
        else if (e.isFile() && EXT.test(e.name) && files.length < 400) files.push(f);
      }
    };
    walk(folder, 0);
    const idx = readIndex();
    const out = [];
    let n = 0;
    for (const f of files) {
      const st = fs.statSync(f);
      const key = `${f}|${st.size}|${st.mtimeMs}`;
      if (!idx[key]) {
        n++;
        onStatus(`A ver os teus planos de B-roll (${n})…`);
        try {
          const p = await probe(f);
          const jpeg = await frameJpeg(f, Math.max(0, (p.duration || 2) * 0.4));
          idx[key] = { duration: p.duration || 0, width: p.width, height: p.height, desc: jpeg ? await describeFrame(jpeg) : '' };
        } catch {
          continue;
        }
      }
      out.push({ path: f, name: path.relative(folder, f), ...idx[key], source: 'pasta' });
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(indexFile, JSON.stringify(idx));
    return out;
  }

  const pexelsKey = () => {
    if (env.PEXELS_API_KEY) return env.PEXELS_API_KEY.trim();
    try {
      return fs.readFileSync(keyFile, 'utf8').trim() || null;
    } catch {
      return null;
    }
  };

  /** One Pexels video for the query (portrait preferred), downloaded once. null when none / no key. */
  async function pexels(query, { portrait = true } = {}) {
    const key = pexelsKey();
    if (!key || !query) return null;
    const u = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=8&size=medium${portrait ? '&orientation=portrait' : ''}`;
    const r = await fetchFn(u, { headers: { authorization: key } });
    if (!r.ok) throw new Error(`Pexels ${r.status}`);
    const body = await r.json();
    for (const v of body.videos || []) {
      const files = (v.video_files || []).filter((f) => f.file_type === 'video/mp4' && f.link && /^https:\/\//.test(f.link));
      const want = files.filter((f) => (portrait ? f.height > f.width : f.width >= f.height) && Math.max(f.width, f.height) >= 1280).sort((a, b) => a.width * a.height - b.width * b.height)[0] || files.sort((a, b) => b.width * b.height - a.width * a.height)[0];
      if (!want) continue;
      const dest = path.join(cacheDir, 'broll', `pexels-${Number(v.id) || Date.now()}.mp4`);
      if (!fs.existsSync(dest)) {
        const d = await fetchFn(want.link);
        if (!d.ok) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest + '.part', Buffer.from(await d.arrayBuffer()));
        fs.renameSync(dest + '.part', dest);
      }
      return { path: dest, name: `Pexels: ${query}`, duration: Number(v.duration) || 5, width: want.width, height: want.height, source: 'pexels', credit: v.user?.name ? `${v.user.name} / Pexels` : 'Pexels' };
    }
    return null;
  }

  return { library, pexels, folder, hasPexels: () => Boolean(pexelsKey()) };
}

module.exports = { createBroll };
