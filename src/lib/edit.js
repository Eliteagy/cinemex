// Edit operations like DaVinci Resolve's Edit page: ripple / roll / slip / slide trims and the
// insert, overwrite, replace, fit to fill, place on top and append edits, plus ripple delete of a
// range. Pure functions: they change the project they are given (the store calls them inside one
// commit, so each edit is one undo step, and links.js then keeps every clip's sound in step).
//
// Locked tracks (track.locked) are never changed. Times are timeline seconds, rounded like the rest
// of the app (r3). A clip's length on the timeline is (out - in) / speed.

export const MIN_LEN = 0.1;
const r3 = (n) => Math.round(n * 1000) / 1000;
const speedOf = (c) => Math.max(0.25, Math.min(4, c.speed ?? 1));
export const clipDur = (c) => Math.max(0, (c.out - c.in) / speedOf(c));
export const clipEnd = (c) => c.start + clipDur(c);
const newId = () => `c_${Math.random().toString(36).slice(2, 9)}`;
const hasSource = (c) => Boolean(c.mediaId);

function find(p, id) {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === id);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return null;
}
const media = (p, c) => (c.mediaId ? p.media?.find((m) => m.id === c.mediaId) : null);
/** Longest source time a clip can use (images and texts: no limit worth speaking of). */
const sourceMax = (p, c) => {
  const m = media(p, c);
  return m && m.kind !== 'image' ? m.duration : 3600;
};
const sorted = (track) => track.clips.sort((a, b) => a.start - b.start);
const unlocked = (p) => p.tracks.filter((t) => !t.locked);
function assertFree(track) {
  if (track.locked) throw new Error(`A pista ${track.name} está bloqueada`);
}

/**
 * Cuts one clip at a timeline time. Returns the new right half, already on the track, or null when
 * the time is not inside the clip. The store passes its own cutter (keeps keyframes, words, Fusion).
 */
export function simpleSplit(track, c, time) {
  if (time <= c.start + 0.001 || time >= clipEnd(c) - 0.001) return null;
  const right = structuredClone(c);
  right.id = newId();
  right.start = r3(time);
  if (hasSource(c)) {
    const cut = r3(c.in + (time - c.start) * speedOf(c));
    right.in = cut;
    c.out = cut;
  } else {
    right.in = 0;
    right.out = r3(clipEnd(c) - time);
    c.out = r3(c.in + (time - c.start));
  }
  right.transitionIn = null;
  c.transitionOut = null;
  track.clips.push(right);
  return right;
}

/** Splits every clip of these tracks that crosses `time`. */
function splitTracks(tracks, time, split) {
  for (const t of tracks) {
    for (const c of [...t.clips]) split(t, c, time);
    sorted(t);
  }
}

/** Removes [a, b) from a track: clips across the edges are cut, the ones inside go. */
function clearRange(track, a, b, split) {
  for (const c of [...track.clips]) split(track, c, a);
  for (const c of [...track.clips]) split(track, c, b);
  track.clips = track.clips.filter((c) => !(c.start >= a - 0.001 && clipEnd(c) <= b + 0.001));
  sorted(track);
}

/** The sound tracks that belong to a video track (its picture's sound goes there). */
const soundTracks = (p, track) => p.tracks.filter((t) => t.kind === 'audio' && t.of === track.id && !t.locked);

// ----------------------------------------------------------------- trims

/**
 * Ripple trim (Resolve's Trim tool on a clip edge): the edge moves by `delta` seconds and every
 * later clip on the same track follows, so no gap opens and nothing is covered.
 */
export function rippleTrim(p, id, edge, delta) {
  const f = find(p, id);
  if (!f) throw new Error('Clip não encontrado');
  assertFree(f.track);
  const c = f.clip;
  const sp = speedOf(c);
  const oldEnd = clipEnd(c);
  const max = sourceMax(p, c);
  if (edge === 'right') {
    const out = hasSource(c) ? Math.max(c.in + MIN_LEN, Math.min(max, c.out + delta * sp)) : Math.max(c.in + MIN_LEN, c.out + delta);
    c.out = r3(out);
  } else {
    // Left edge: the clip keeps its start and the source in moves; later clips move by the change.
    const nin = hasSource(c) ? Math.max(0, Math.min(c.out - MIN_LEN, c.in + delta * sp)) : c.in;
    if (hasSource(c)) c.in = r3(nin);
    else c.out = r3(Math.max(MIN_LEN, c.out - delta));
  }
  const shift = clipEnd(c) - oldEnd;
  for (const o of f.track.clips) if (o !== c && o.start >= oldEnd - 0.001) o.start = r3(Math.max(0, o.start + shift));
  sorted(f.track);
  return r3(shift);
}

/**
 * Roll edit: the cut between two touching clips moves by `delta`; the left clip gets longer and the
 * right one shorter (or the other way), nothing else moves.
 */
export function roll(p, leftId, rightId, delta) {
  const L = find(p, leftId);
  const R = find(p, rightId);
  if (!L || !R || L.track !== R.track) throw new Error('O roll precisa de dois clips seguidos na mesma pista');
  assertFree(L.track);
  const a = L.clip;
  const b = R.clip;
  if (Math.abs(clipEnd(a) - b.start) > 0.01) throw new Error('Os clips não estão encostados');
  const sa = speedOf(a);
  const sb = speedOf(b);
  // How far the cut may go: the left clip's source end, the right clip's source start, a minimum length each.
  let lo = -(clipDur(a) - MIN_LEN);
  let hi = clipDur(b) - MIN_LEN;
  if (hasSource(a)) hi = Math.min(hi, (sourceMax(p, a) - a.out) / sa);
  if (hasSource(b)) lo = Math.max(lo, -b.in / sb);
  const d = Math.max(lo, Math.min(hi, delta));
  a.out = r3(a.out + (hasSource(a) ? d * sa : d));
  if (hasSource(b)) b.in = r3(b.in + d * sb);
  else b.out = r3(b.out - d);
  b.start = r3(b.start + d);
  return r3(d);
}

/** Slip: the clip stays where it is and shows an earlier or later part of its source. */
export function slip(p, id, delta) {
  const f = find(p, id);
  if (!f) throw new Error('Clip não encontrado');
  assertFree(f.track);
  const c = f.clip;
  if (!hasSource(c)) return 0;
  const sp = speedOf(c);
  const max = sourceMax(p, c);
  const d = Math.max(-c.in, Math.min(max - c.out, delta * sp));
  c.in = r3(c.in + d);
  c.out = r3(c.out + d);
  return r3(d / sp);
}

/**
 * Slide: the clip moves between its neighbours, keeping its content; the clip before gets longer or
 * shorter at its end and the clip after at its start, so the total length stays the same.
 */
export function slide(p, id, delta) {
  const f = find(p, id);
  if (!f) throw new Error('Clip não encontrado');
  assertFree(f.track);
  const c = f.clip;
  const list = sorted(f.track);
  const i = list.indexOf(c);
  const prev = list[i - 1] && Math.abs(clipEnd(list[i - 1]) - c.start) < 0.01 ? list[i - 1] : null;
  const next = list[i + 1] && Math.abs(list[i + 1].start - clipEnd(c)) < 0.01 ? list[i + 1] : null;
  let lo = prev ? -(clipDur(prev) - MIN_LEN) : -c.start;
  let hi = next ? clipDur(next) - MIN_LEN : Infinity;
  if (!prev) lo = Math.max(lo, -c.start);
  if (prev && hasSource(prev)) hi = Math.min(hi, (sourceMax(p, prev) - prev.out) / speedOf(prev));
  if (next && hasSource(next)) lo = Math.max(lo, -next.in / speedOf(next));
  // Without a neighbour on a side, the clip cannot run into the clip beyond the gap.
  if (!next && list[i + 1]) hi = Math.min(hi, list[i + 1].start - clipEnd(c));
  if (!prev && list[i - 1]) lo = Math.max(lo, clipEnd(list[i - 1]) - c.start);
  const d = Math.max(lo, Math.min(hi, delta));
  c.start = r3(c.start + d);
  if (prev) prev.out = r3(prev.out + (hasSource(prev) ? d * speedOf(prev) : d));
  if (next) {
    if (hasSource(next)) next.in = r3(next.in + d * speedOf(next));
    else next.out = r3(next.out - d);
    next.start = r3(next.start + d);
  }
  return r3(d);
}

// ----------------------------------------------------------------- edits from the media

/**
 * Builds the clip an edit puts on the timeline. Three-point editing like Resolve: the source is the
 * whole media (or srcIn..srcOut); when the timeline has In and Out marks, the clip fills that range
 * (shorter source: what there is).
 */
function sourceClip(p, src) {
  const m = p.media?.find((x) => x.id === src.mediaId);
  if (!m) throw new Error('Escolhe primeiro um ficheiro na Média');
  const max = m.kind === 'image' ? 3600 : m.duration;
  const cin = Math.max(0, Math.min(src.in ?? 0, max - MIN_LEN));
  let cout = Math.min(max, src.out ?? (m.kind === 'image' ? 5 : max));
  if (src.length !== undefined) cout = Math.min(cout, cin + src.length);
  cout = Math.max(cin + MIN_LEN, cout);
  return { m, clip: { id: newId(), mediaId: m.id, start: 0, in: r3(cin), out: r3(cout), volume: 1, fit: 'fill' } };
}

function targetTrack(p, m, trackId) {
  const kind = m.kind === 'audio' ? 'audio' : 'video';
  const t = (trackId && p.tracks.find((x) => x.id === trackId && x.kind === kind && !x.locked)) || p.tracks.find((x) => x.kind === kind && !x.locked && !(kind === 'audio' && x.of));
  if (!t) throw new Error(kind === 'audio' ? 'Não há pista de áudio livre' : 'Não há pista de vídeo livre');
  return t;
}

/**
 * Insert (F9): everything from `at` on every unlocked track moves right by the clip's length and
 * the clip goes into the gap.
 */
export function insertEdit(p, src, at, opts = {}) {
  const split = opts.split ?? simpleSplit;
  const { m, clip } = sourceClip(p, src);
  const track = targetTrack(p, m, opts.trackId);
  const len = clipDur(clip);
  at = r3(Math.max(0, at));
  const tracks = unlocked(p);
  splitTracks(tracks, at, split);
  for (const t of tracks) for (const c of t.clips) if (c.start >= at - 0.001) c.start = r3(c.start + len);
  clip.start = at;
  track.clips.push(clip);
  sorted(track);
  return clip.id;
}

/** Overwrite (F10): the clip covers whatever was on its track (and that track's sound) at that time. */
export function overwriteEdit(p, src, at, opts = {}) {
  const split = opts.split ?? simpleSplit;
  const { m, clip } = sourceClip(p, src);
  const track = targetTrack(p, m, opts.trackId);
  at = r3(Math.max(0, at));
  const len = clipDur(clip);
  for (const t of [track, ...soundTracks(p, track)]) clearRange(t, at, at + len, split);
  clip.start = at;
  track.clips.push(clip);
  sorted(track);
  return clip.id;
}

/**
 * Replace (F11): the clip under the playhead on the target track gets the new media, with the same
 * place and length; the source frame at the playhead lines up with the old one (Resolve's rule).
 */
export function replaceEdit(p, src, at, opts = {}) {
  const { m } = sourceClip(p, src);
  const track = targetTrack(p, m, opts.trackId);
  const old = track.clips.find((c) => at >= c.start - 0.001 && at < clipEnd(c) - 0.001);
  if (!old) throw new Error('Não há clip na cabeça de leitura para substituir');
  const len = clipDur(old);
  const max = m.kind === 'image' ? 3600 : m.duration;
  if (len > max + 0.001) throw new Error('O ficheiro novo é mais curto do que o clip');
  // Source in so that src.in (default 0) sits at the playhead, kept inside the media.
  let cin = (src.in ?? 0) - (at - old.start);
  cin = Math.max(0, Math.min(max - len, cin));
  old.mediaId = m.id;
  old.in = r3(cin);
  old.out = r3(cin + len);
  delete old.speed;
  delete old.remap;
  delete old.text;
  delete old.gen;
  return old.id;
}

/**
 * Fit to fill (Shift+F11): the source is sped up or slowed down to fill the timeline range
 * [from, to] exactly (speed kept in 0.25x-4x; outside that it fills as much as it can).
 */
export function fitToFillEdit(p, src, from, to, opts = {}) {
  const split = opts.split ?? simpleSplit;
  if (!(to > from + MIN_LEN)) throw new Error('Marca In e Out na timeline para o fit to fill');
  const { m, clip } = sourceClip(p, { ...src, length: undefined });
  const track = targetTrack(p, m, opts.trackId);
  const want = to - from;
  const speed = Math.max(0.25, Math.min(4, (clip.out - clip.in) / want));
  clip.out = r3(Math.min(clip.out, clip.in + want * speed));
  if (Math.abs(speed - 1) > 0.001) clip.speed = r3(speed);
  for (const t of [track, ...soundTracks(p, track)]) clearRange(t, from, from + clipDur(clip), split);
  clip.start = r3(from);
  track.clips.push(clip);
  sorted(track);
  return clip.id;
}

/** Place on top (F12): on the first video track above that is free for that time; a new one when none is. */
export function placeOnTopEdit(p, src, at, opts = {}) {
  const { m, clip } = sourceClip(p, src);
  if (m.kind === 'audio') return appendEdit(p, src, opts);
  at = r3(Math.max(0, at));
  const len = clipDur(clip);
  const vids = p.tracks.filter((t) => t.kind === 'video');
  const busy = (t) => t.clips.some((c) => c.start < at + len - 0.001 && clipEnd(c) > at + 0.001);
  const top = Math.max(-1, ...vids.map((t, i) => (busy(t) ? i : -1)));
  let track = vids.find((t, i) => i > top && !t.locked && !busy(t));
  if (!track) {
    let n = 1;
    while (p.tracks.some((t) => t.id === `v${n}`)) n++;
    let k = 1;
    while (p.tracks.some((t) => t.name.trim().toLowerCase() === `v${k}`)) k++;
    track = { id: `v${n}`, kind: 'video', name: `V${k}`, clips: [] };
    p.tracks.splice(p.tracks.map((t) => t.kind).lastIndexOf('video') + 1, 0, track);
  }
  clip.start = at;
  track.clips.push(clip);
  sorted(track);
  return clip.id;
}

/** Append (Shift+F12): at the end of the target track. */
export function appendEdit(p, src, opts = {}) {
  const { m, clip } = sourceClip(p, src);
  const track = targetTrack(p, m, opts.trackId);
  clip.start = r3(track.clips.reduce((e, c) => Math.max(e, clipEnd(c)), 0));
  track.clips.push(clip);
  sorted(track);
  return clip.id;
}

/** Ripple delete of [from, to] on every unlocked track: the range goes and what comes after closes up. */
export function rippleDeleteRange(p, from, to, opts = {}) {
  const split = opts.split ?? simpleSplit;
  if (!(to > from + 0.001)) throw new Error('Marca In e Out na timeline');
  const len = to - from;
  for (const t of unlocked(p)) {
    clearRange(t, from, to, split);
    for (const c of t.clips) if (c.start >= to - 0.001) c.start = r3(c.start - len);
    sorted(t);
  }
  return r3(len);
}

/** Two clips that touch at time t on a track (for roll), or null. */
export function cutAt(track, t, tolerance = 0.05) {
  const list = [...track.clips].sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < list.length; i++) {
    const e = clipEnd(list[i]);
    if (Math.abs(e - list[i + 1].start) < 0.01 && Math.abs(e - t) <= tolerance) return [list[i], list[i + 1]];
  }
  return null;
}

export const EDIT_MODES = ['insert', 'overwrite', 'replace', 'fit', 'top', 'append'];
