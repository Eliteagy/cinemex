// Live collaboration: what changed between two versions of a project, and how to apply that change
// on the other computer. Shared by the editor UI (sends and applies changes) and the main process
// (translates file paths), and tested in Node.
//
// A change ("op") lists, per collection, the items added or changed (`up`), the ids removed (`del`)
// and the new order (`order`), so two people editing different clips never overwrite each other.
// Editing the same clip at the same moment: the last change to arrive wins for that clip.
//
// Paths: a file inside the shared Google Drive folder travels as "@shared/<path inside it>" and each
// computer turns it back into its own full path (G:\My Drive\Cinemex\... on Windows,
// ~/Library/CloudStorage/GoogleDrive-.../My Drive/Cinemex/... on a Mac). Saved .ecproj files use
// the same form, so a project in the shared folder opens on both.

export const OP_VERSION = 1;
export const SHARED = '@shared/';

/** Top-level project fields that are not collections; each is replaced whole when it changes. */
const FIELDS = ['version', 'name', 'canvas', 'captionStyle', 'styles', 'audio', 'markers'];

const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const byId = (list) => new Map((list || []).map((x) => [x.id, x]));
const ids = (list) => (list || []).map((x) => x.id);

/** Items added or changed, ids removed, and the order (null when nothing changed). */
function diffList(prev, next, strip = (x) => x) {
  const before = byId(prev);
  const after = byId(next);
  const up = [];
  for (const [id, item] of after) {
    const old = before.get(id);
    if (!old || !same(strip(old), strip(item))) up.push(clone(strip(item)));
  }
  const del = [...before.keys()].filter((id) => !after.has(id));
  const order = ids(next);
  const reordered = !same(ids(prev), order);
  if (!up.length && !del.length && !reordered) return null;
  return { up, del, order };
}

/** Apply a list change: remove, add or replace, then put items in the sender's order. */
function applyList(list, change, merge = (_old, item) => item) {
  if (!change) return list;
  const map = byId(list);
  for (const id of change.del || []) map.delete(id);
  for (const item of change.up || []) map.set(item.id, merge(map.get(item.id), item));
  const order = Array.isArray(change.order) ? change.order : [];
  const seen = new Set();
  const out = [];
  for (const id of order) {
    const item = map.get(id);
    if (item && !seen.has(id)) {
      out.push(item);
      seen.add(id);
    }
  }
  // Items this computer has that the sender did not know about yet stay, at the end.
  for (const [id, item] of map) if (!seen.has(id)) out.push(item);
  return out;
}

const trackHead = (t) => {
  const { clips: _clips, ...rest } = t;
  return rest;
};

/**
 * The change from `prev` to `next`, or null when they are the same.
 * @returns {{ v: number, set?: Record<string, unknown>, unset?: string[], media?: object, tracks?: object, clips?: Record<string, object> } | null}
 */
export function diffProject(prev, next) {
  const op = { v: OP_VERSION };
  let empty = true;
  for (const k of FIELDS) {
    if (same(prev?.[k], next?.[k])) continue;
    if (next?.[k] === undefined) (op.unset ??= []).push(k);
    else (op.set ??= {})[k] = clone(next[k]);
    empty = false;
  }
  const media = diffList(prev?.media, next?.media);
  if (media) {
    op.media = media;
    empty = false;
  }
  const tracks = diffList(prev?.tracks, next?.tracks, trackHead);
  if (tracks) {
    op.tracks = tracks;
    empty = false;
  }
  const prevTracks = byId(prev?.tracks);
  for (const t of next?.tracks || []) {
    const c = diffList(prevTracks.get(t.id)?.clips, t.clips);
    if (c) {
      (op.clips ??= {})[t.id] = c;
      empty = false;
    }
  }
  return empty ? null : op;
}

/** A new project with `op` applied to `project` (the input is not changed). */
export function applyOp(project, op) {
  if (!op || op.v !== OP_VERSION) throw new Error('Alteração de uma versão do Cinemex diferente: atualiza os dois computadores');
  const p = clone(project);
  for (const [k, v] of Object.entries(op.set || {})) if (FIELDS.includes(k)) p[k] = clone(v);
  for (const k of op.unset || []) if (FIELDS.includes(k)) delete p[k];
  p.media = applyList(p.media || [], op.media);
  // A track's own fields change without touching its clips (those travel in op.clips).
  p.tracks = applyList(p.tracks || [], op.tracks, (old, head) => ({ ...clone(head), clips: old?.clips ?? [] }));
  for (const t of p.tracks) if (op.clips?.[t.id]) t.clips = applyList(t.clips || [], op.clips[t.id]);
  return p;
}

/** Calls `fn` on every file path a project or an op carries (media files and LUTs) and stores the result. */
export function mapPaths(value, fn) {
  const out = clone(value);
  if (!out || typeof out !== 'object') return out;
  const media = [...(out.media?.up ? out.media.up : []), ...(Array.isArray(out.media) ? out.media : [])];
  for (const m of media) if (m && typeof m.path === 'string') m.path = fn(m.path);
  const clipLists = [
    ...(Array.isArray(out.tracks) ? out.tracks.map((t) => t.clips || []) : []),
    ...Object.values(out.clips || {}).map((c) => c.up || []),
  ];
  for (const list of clipLists) for (const c of list) if (c?.color && typeof c.color.lut === 'string') c.color.lut = fn(c.color.lut);
  return out;
}

const slash = (s) => s.replace(/\\/g, '/');

/**
 * "@shared/<inside>" when `file` is inside `root` (the shared folder), else the file unchanged.
 * Compared without case on Windows paths (the drive letter and folder names).
 */
export function toShared(file, root) {
  if (!root || typeof file !== 'string' || file.startsWith(SHARED)) return file;
  const f = slash(file);
  const r = slash(root).replace(/\/+$/, '');
  const win = /^[a-zA-Z]:\//.test(r);
  const head = f.slice(0, r.length);
  if ((win ? head.toLowerCase() === r.toLowerCase() : head === r) && f[r.length] === '/') {
    const inside = f.slice(r.length + 1);
    if (inside.split('/').some((part) => part === '..')) return file;
    return SHARED + inside;
  }
  return file;
}

/** The full path on this computer for "@shared/<inside>"; other paths unchanged. */
export function fromShared(file, root, sep = '/') {
  if (typeof file !== 'string' || !file.startsWith(SHARED)) return file;
  const inside = file.slice(SHARED.length);
  if (!root || inside.split(/[\\/]/).some((part) => part === '..' || part === '')) return file;
  return root.replace(/[\\/]+$/, '') + sep + inside.split('/').join(sep);
}
