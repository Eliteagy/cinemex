// CapCut drafts → Cinemex projects. CapCut (9.x) keeps each draft as readable JSON in
// %LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft\<draft>\draft_content.json
// (times in microseconds, positions from -1 to 1). We read it; we never write to CapCut's files.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// macOS keeps the same tree under ~/Movies/CapCut.
const CAPCUT_HOME = process.platform === 'darwin' ? path.join(os.homedir(), 'Movies') : process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const DRAFTS = path.join(CAPCUT_HOME, 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft');
const US = 1e6;
const r3 = (n) => Math.round(n * 1000) / 1000;

function listDrafts(dir = DRAFTS) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(dir, e.name, 'draft_content.json');
    if (!fs.existsSync(file)) continue;
    let name = e.name;
    let duration = 0;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'draft_meta_info.json'), 'utf8'));
      name = meta.draft_name || name;
      duration = (meta.tm_duration || 0) / US;
    } catch {
      /* no meta: folder name */
    }
    out.push({ name, file, modified: fs.statSync(file).mtimeMs, duration: r3(duration) });
  }
  return out.sort((a, b) => b.modified - a.modified);
}

/** A media file that moved: look for the same name in the usual folders (bounded walk). */
function findMoved(file) {
  const name = path.basename(file).toLowerCase();
  const roots = ['Videos', 'Movies', 'Desktop', 'Downloads', 'Documents'].map((d) => path.join(os.homedir(), d));
  let budget = 4000;
  const walk = (dir, depth) => {
    if (depth < 0 || budget <= 0) return null;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) if (e.isFile() && e.name.toLowerCase() === name) return path.join(dir, e.name);
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      budget--;
      const hit = walk(path.join(dir, e.name), depth - 1);
      if (hit) return hit;
    }
    return null;
  };
  for (const r of roots) {
    const hit = walk(r, 4);
    if (hit) return hit;
  }
  return null;
}

/** Text of a CapCut text material: `content` is JSON ({"text": ...}) in recent versions. */
function textOf(m) {
  if (!m) return '';
  if (typeof m.content === 'string') {
    try {
      const j = JSON.parse(m.content);
      if (typeof j.text === 'string') return j.text;
    } catch {
      return m.content.replace(/<[^>]+>/g, '');
    }
  }
  return m.base_content || m.recognize_text || '';
}

/**
 * Convert a draft. Returns the project skeleton plus the media files it needs; `importFile`
 * (from media.cjs) probes each file so the project gets real media entries.
 */
async function convertDraft(file, importFile) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const warnings = [];
  const W = j.canvas_config?.width || 1080;
  const H = j.canvas_config?.height || 1920;
  const preset = W > H ? '16:9' : W === H ? '1:1' : W / H > 0.7 ? '4:5' : '9:16';
  const mats = new Map();
  for (const kind of ['videos', 'audios', 'texts', 'speeds']) for (const m of j.materials?.[kind] || []) mats.set(m.id, { kind, m });

  const media = new Map(); // path -> Media
  async function mediaFor(p) {
    if (!p) return null;
    if (media.has(p)) return media.get(p);
    let real = p;
    if (!fs.existsSync(p)) {
      real = findMoved(p);
      if (!real) {
        warnings.push(`Ficheiro em falta: ${p}`);
        media.set(p, null);
        return null;
      }
      warnings.push(`${path.basename(p)} foi encontrado noutra pasta: ${real}`);
    }
    try {
      const m = await importFile(real);
      media.set(p, m);
      return m;
    } catch (e) {
      warnings.push(`${path.basename(p)}: ${e.message}`);
      media.set(p, null);
      return null;
    }
  }

  const tracks = [];
  let vN = 0;
  let aN = 0;
  const textTrack = { id: 'tx', kind: 'text', name: 'Legendas', clips: [] };
  let skipped = 0;
  let keyframed = 0;
  for (const t of j.tracks || []) {
    if (t.type === 'text') {
      for (const s of t.segments || []) {
        const mm = mats.get(s.material_id)?.m;
        const text = textOf(mm).trim();
        if (!text) continue;
        const tr = s.clip?.transform || { x: 0, y: 0 };
        textTrack.clips.push({
          id: `c_cc${textTrack.clips.length}`,
          start: r3(s.target_timerange.start / US),
          in: 0,
          out: r3(s.target_timerange.duration / US),
          text,
          style: 'clean',
          x: r3(Math.max(0.05, Math.min(0.95, 0.5 + (tr.x || 0) / 2))),
          y: r3(Math.max(0.05, Math.min(0.95, 0.5 - (tr.y || 0) / 2))),
        });
      }
      continue;
    }
    if (t.type !== 'video' && t.type !== 'audio') {
      skipped += (t.segments || []).length;
      continue;
    }
    const track = t.type === 'video' ? { id: `v${++vN}`, kind: 'video', name: `V${vN}`, clips: [] } : { id: `a${++aN}`, kind: 'audio', name: aN === 1 ? 'Música' : `Áudio ${aN}`, clips: [] };
    for (const s of t.segments || []) {
      const mm = mats.get(s.material_id)?.m;
      const m = await mediaFor(mm?.path);
      if (!m) continue;
      const speedRef = (s.extra_material_refs || []).map((id) => mats.get(id)).find((x) => x?.kind === 'speeds');
      const speed = Math.max(0.25, Math.min(4, s.speed || speedRef?.m?.speed || 1));
      const tgt = s.target_timerange;
      const src = s.source_timerange || { start: 0, duration: tgt.duration * speed };
      if ((s.common_keyframes || []).length || (s.keyframe_refs || []).length) keyframed++;
      const scale = s.clip?.scale?.x ?? 1;
      const clip = {
        id: `c_cc${vN}${aN}_${track.clips.length}`,
        mediaId: m.id,
        start: r3(tgt.start / US),
        in: r3(src.start / US),
        out: r3(m.kind === 'image' ? src.start / US + tgt.duration / US : (src.start + src.duration) / US),
        volume: r3(Math.max(0, Math.min(2, s.volume ?? 1))),
        fit: 'fill',
        ...(Math.abs(speed - 1) > 1e-3 ? { speed: r3(speed) } : {}),
      };
      if (scale > 1.001) clip.keyframes = { zoom: [{ t: 0, v: r3(Math.min(4, scale)) }] };
      track.clips.push(clip);
    }
    tracks.push(track);
  }
  if (!tracks.some((t) => t.kind === 'video')) tracks.unshift({ id: 'v1', kind: 'video', name: 'V1', clips: [] });
  if (!tracks.some((t) => t.kind === 'audio')) tracks.push({ id: 'a1', kind: 'audio', name: 'Música', clips: [] });
  const video = tracks.filter((t) => t.kind === 'video');
  const audio = tracks.filter((t) => t.kind === 'audio');
  if (skipped) warnings.push(`${skipped} elementos (efeitos, stickers, filtros) não têm equivalente e ficaram de fora`);
  if (keyframed) warnings.push(`${keyframed} clips tinham keyframes do CapCut: só o zoom fixo foi importado`);

  let name = path.basename(path.dirname(file));
  try {
    name = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'draft_meta_info.json'), 'utf8')).draft_name || name;
  } catch {
    /* keep folder name */
  }
  const project = {
    version: 1,
    name: `${name} (CapCut)`,
    canvas: { w: W, h: H, fps: Math.round(j.fps || 30), preset },
    media: [...media.values()].filter(Boolean),
    tracks: [...video, textTrack, ...audio],
  };
  return { project, warnings };
}

module.exports = { listDrafts, convertDraft, textOf, findMoved, DRAFTS };
