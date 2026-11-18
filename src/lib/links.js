// Sound on its own track, like Resolve and Premiere: a video clip that has sound is two clips, the
// picture on a video track and the sound on an audio track, tied by the same `link` id. The picture
// clip is `silent` (its sound is the linked clip). Linked clips move, trim, split and get deleted
// together; with linked selection off each one is edited on its own.
//
// Everything here works on the project after an edit (syncLinks), so every way of editing the
// timeline (the mouse, the Inspector, Claude through the MCP) keeps the two in step without knowing
// about links.

const r3 = (n) => Math.round(n * 1000) / 1000;
const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 9)}`;
const speedOf = (c) => c.speed ?? 1;
const MIN_LEN = 0.1;
const byStart = (a, b) => a.c.start - b.c.start;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function groups(p) {
  const g = new Map();
  for (const t of p.tracks) {
    if (t.kind === 'text') continue;
    for (const c of t.clips) {
      if (!c.link) continue;
      let e = g.get(c.link);
      if (!e) g.set(c.link, (e = { v: [], a: [] }));
      (t.kind === 'video' ? e.v : e.a).push({ c, t });
    }
  }
  for (const e of g.values()) {
    e.v.sort(byStart);
    e.a.sort(byStart);
  }
  return g;
}

const sig = ({ c, t }) => JSON.stringify([c.id, t.id, c.start, c.in, c.out, speedOf(c), c.remap ?? null, c.transitionIn?.d ?? 0, c.transitionOut?.d ?? 0]);
const sideSig = (list) => list.map(sig).join('|');

/** The audio track that holds the sound of a video track (made when missing): V1 -> A1, V2 -> A2… */
export function audioTrackFor(p, videoTrack) {
  let t = p.tracks.find((x) => x.kind === 'audio' && x.of === videoTrack.id);
  if (t) return t;
  const num = /^V\s*(\d+)$/i.exec(String(videoTrack.name ?? '').trim());
  const name = num ? `A${num[1]}` : `${videoTrack.name ?? 'Vídeo'} (som)`;
  t = p.tracks.find((x) => x.kind === 'audio' && !x.of && !x.clips.length && String(x.name).trim().toLowerCase() === name.toLowerCase());
  if (t) {
    t.of = videoTrack.id;
    return t;
  }
  let n = 1;
  while (p.tracks.some((x) => x.id === `as${n}`)) n++;
  t = { id: `as${n}`, kind: 'audio', name, of: videoTrack.id, clips: [], ...(videoTrack.muted ? { muted: true } : {}) };
  // Sound tracks first (in the order of their video tracks), then music and effects.
  const order = (x) => p.tracks.filter((y) => y.kind === 'video').findIndex((y) => y.id === x.of);
  const mine = order(t);
  let at = p.tracks.findIndex((x) => x.kind === 'audio' && (!x.of || order(x) > mine));
  if (at < 0) {
    const last = p.tracks.map((x) => x.kind).lastIndexOf('audio');
    at = last >= 0 ? last + 1 : p.tracks.length;
  }
  p.tracks.splice(at, 0, t);
  return t;
}

/**
 * Texts (titles, captions, graphics) are clips on video tracks, like in Resolve. Projects made when
 * they had a track type of their own: those tracks become video tracks, on top, in the same order.
 */
export function textToVideo(p) {
  const texts = p.tracks.filter((t) => t.kind === 'text');
  if (!texts.length) return 0;
  const rest = p.tracks.filter((t) => t.kind !== 'text');
  for (const t of texts) t.kind = 'video';
  // Video tracks are listed top layer first: the first text track stays on top.
  rest.splice(rest.map((t) => t.kind).lastIndexOf('video') + 1, 0, ...texts.reverse());
  p.tracks = rest;
  return texts.length;
}

/** The sound follows the picture's transitions with a fade of the same length. */
function fades(a, v) {
  for (const k of ['transitionIn', 'transitionOut']) {
    const d = v[k]?.d ?? 0;
    if (d > 0) a[k] = { type: 'fade', d };
    else delete a[k];
  }
}

function copyTiming(to, from) {
  to.start = from.start;
  to.in = from.in;
  to.out = from.out;
  if (from.speed === undefined) delete to.speed;
  else to.speed = from.speed;
  if (from.remap === undefined) delete to.remap;
  else to.remap = structuredClone(from.remap);
}

/**
 * Every video clip with sound gets its sound as a linked clip on an audio track (projects made
 * before this, clips added by any tool). Returns how many were separated.
 */
export function separateAudio(p) {
  const media = new Map((p.media ?? []).map((m) => [m.id, m]));
  let n = 0;
  for (const vt of p.tracks.filter((t) => t.kind === 'video')) {
    for (const c of vt.clips) {
      const m = media.get(c.mediaId);
      if (!m || m.kind !== 'video' || !m.hasAudio || c.silent) continue;
      const at = audioTrackFor(p, vt);
      const link = c.link ?? uid('l');
      const a = { id: uid('c'), mediaId: c.mediaId, start: c.start, in: c.in, out: c.out, volume: c.volume ?? 1, link };
      copyTiming(a, c);
      fades(a, c);
      c.silent = true;
      c.link = link;
      at.clips.push(a);
      at.clips.sort((x, y) => x.start - y.start);
      n++;
    }
  }
  return n;
}

/** A link with only one clip left is no link. */
function tidy(p) {
  for (const [, e] of groups(p)) {
    if (e.v.length && e.a.length) continue;
    for (const x of [...e.v, ...e.a]) delete x.c.link;
  }
}

function remove(x) {
  const i = x.t.clips.indexOf(x.c);
  if (i >= 0) x.t.clips.splice(i, 1);
}

/** The other side made again from the pieces of the side that was edited (a cut, pauses removed…). */
function rebuild(p, link, drivers, followers, template, toVideo) {
  const track = p.tracks.find((t) => t.id === template.t.id) ?? (toVideo ? p.tracks.find((t) => t.kind === 'video') : audioTrackFor(p, drivers[0].t));
  if (!track) return;
  for (const f of followers) remove(f);
  drivers.forEach((d, i) => {
    const id = i === 0 ? link : uid('l');
    const n = structuredClone(template.c);
    n.id = followers[i]?.c.id ?? uid('c');
    copyTiming(n, d.c);
    n.link = id;
    delete n.words;
    if (!toVideo) fades(n, d.c);
    d.c.link = id;
    track.clips.push(n);
  });
}

function follow(before, after) {
  const gb = groups(before);
  const ga = groups(after);
  const none = { v: [], a: [] };
  const inAfter = new Map();
  for (const t of after.tracks) for (const c of t.clips) inAfter.set(c.id, { c, t });

  for (const link of new Set([...gb.keys(), ...ga.keys()])) {
    const b = gb.get(link);
    if (!b || !b.v.length || !b.a.length) continue; // a link made by this very edit, or half a link
    const a = ga.get(link) ?? none;
    const vChanged = sideSig(b.v) !== sideSig(a.v);
    const aChanged = sideSig(b.a) !== sideSig(a.a);
    if (!vChanged && !aChanged) continue;

    if (vChanged && aChanged) {
      // Both edited by the same action (a cut through every track): pair the pieces again.
      if (a.v.length === a.a.length) {
        a.v.forEach((x, i) => {
          const id = i === 0 ? link : uid('l');
          x.c.link = id;
          a.a[i].c.link = id;
        });
      } else if (a.v.length && a.a.length) rebuild(after, link, a.v, a.a, a.a[0], false);
      continue;
    }

    const toVideo = aChanged; // the side that follows
    const drv = toVideo ? a.a : a.v;
    const drvBefore = toVideo ? b.a : b.v;
    const fol = toVideo ? a.v : a.a;
    if (!drv.length) {
      // Deleted: its other half goes too.
      for (const f of fol) remove(f);
      continue;
    }
    const sameIds = drv.length === drvBefore.length && drvBefore.every((x) => drv.some((y) => y.c.id === x.c.id));
    if (!sameIds) {
      if (fol.length) rebuild(after, link, drv, fol, fol[0], toVideo);
      continue;
    }
    // Moved, trimmed or re-timed: the other half moves by the same amount (an offset between them stays).
    const folBefore = toVideo ? b.v : b.a;
    drvBefore.forEach((d0, i) => {
      const d1 = inAfter.get(d0.c.id);
      const f0 = folBefore[folBefore.length === drvBefore.length ? i : 0];
      const f1 = f0 && inAfter.get(f0.c.id);
      if (!d1 || !f1 || !fol.some((x) => x.c.id === f1.c.id)) return;
      const f = f1.c;
      f.start = r3(Math.max(0, f.start + (d1.c.start - d0.c.start)));
      f.in = r3(Math.max(0, f.in + (d1.c.in - d0.c.in)));
      f.out = r3(Math.max(f.in + MIN_LEN, f.out + (d1.c.out - d0.c.out)));
      if (speedOf(d1.c) !== speedOf(d0.c)) {
        if (d1.c.speed === undefined) delete f.speed;
        else f.speed = d1.c.speed;
      }
      if (!same(d1.c.remap, d0.c.remap)) {
        if (d1.c.remap === undefined) delete f.remap;
        else f.remap = structuredClone(d1.c.remap);
      }
      if (!toVideo) {
        if ((d1.c.transitionIn?.d ?? 0) !== (d0.c.transitionIn?.d ?? 0) || (d1.c.transitionOut?.d ?? 0) !== (d0.c.transitionOut?.d ?? 0)) fades(f, d1.c);
        // The picture went to another video track: its sound goes to that track's sound track.
        if (d1.t.id !== d0.t.id && f1.t.of === d0.t.id) {
          const to = audioTrackFor(after, d1.t);
          if (to !== f1.t) {
            remove(f1);
            to.clips.push(f);
          }
        }
      }
    });
  }

  // Volume: the sound clip is the one that plays; the picture clip shows the same number.
  const wasIn = new Map();
  for (const t of before.tracks) for (const c of t.clips) wasIn.set(c.id, c);
  for (const [, e] of groups(after)) {
    if (!e.v.length || !e.a.length) continue;
    e.v.forEach((v, i) => {
      const a = e.a[e.a.length === e.v.length ? i : 0];
      const v0 = wasIn.get(v.c.id);
      const a0 = wasIn.get(a.c.id);
      if (a0 && (a.c.volume ?? 1) !== (a0.volume ?? 1)) v.c.volume = a.c.volume ?? 1;
      else if (v0 && (v.c.volume ?? 1) !== (v0.volume ?? 1)) a.c.volume = v.c.volume ?? 1;
    });
  }
}

/**
 * Run after every edit: `before` is the project as it was, `after` the edited one (changed in place).
 * linked=false is "linked selection off": the two halves are edited on their own.
 */
export function syncLinks(before, after, opts = {}) {
  textToVideo(after);
  if (before && opts.linked !== false) follow(before, after);
  separateAudio(after);
  tidy(after);
  for (const t of after.tracks) t.clips.sort((a, b) => a.start - b.start);
  return after;
}

/** The other half (or halves) of a linked clip. */
export function partnersOf(p, clipId) {
  let link;
  for (const t of p.tracks) for (const c of t.clips) if (c.id === clipId) link = c.link;
  if (!link) return [];
  const out = [];
  for (const t of p.tracks) for (const c of t.clips) if (c.link === link && c.id !== clipId) out.push(c);
  return out;
}

/** Break the link: picture and sound become two independent clips. */
export function unlink(p, clipId) {
  const others = partnersOf(p, clipId);
  for (const t of p.tracks) for (const c of t.clips) if (c.id === clipId) delete c.link;
  for (const c of others) delete c.link;
  return others.length;
}
