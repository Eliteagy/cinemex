// Free transform, picture-in-picture and parenting (After Effects layer Transform + Parent + Null object),
// time remap (AE Time Remapping) and motion blur (AE shutter angle). Shared by the preview and the export.
//
// Transform of a clip, applied after its content rotation, in this order (same as the export):
//   rotate (whole frame, axis-aligned crop) -> scale (around the centre) -> move by (px * W, py * H).
// A clip can have a parent (another clip or a null object): it inherits the parent's position, scale and
// rotation, evaluated at the same moment of the timeline.
import { kfAt, propAt, propExpr, animates } from './anim.js';

export const XF_PROPS = ['scale', 'px', 'py'];
const fx = (n) => String(Math.round(n * 10000) / 10000);

const ownRot = (c, t) => (animates(c, 'rotate') ? propAt(c, 'rotate', t, 0) : 0);

/**
 * Total transform of a clip at its local time t: scale s, offset (x, y) in pixels of a W x H frame,
 * rotation r (degrees) of its own content plus every parent's, and pr = the parents' part of r.
 */
export function xformAt(clip, t, byId, W, H, depth = 0) {
  const s = propAt(clip, 'scale', t, 1);
  const x = propAt(clip, 'px', t, 0) * W;
  const y = propAt(clip, 'py', t, 0) * H;
  const r = ownRot(clip, t);
  const p = clip.parent && depth < 8 ? byId.get(clip.parent) : null;
  if (!p || p.id === clip.id) return { s, x, y, r, pr: 0 };
  const P = xformAt(p, t + clip.start - p.start, byId, W, H, depth + 1);
  const a = (P.r * Math.PI) / 180;
  return { s: P.s * s, x: P.x + P.s * (Math.cos(a) * x - Math.sin(a) * y), y: P.y + P.s * (Math.sin(a) * x + Math.cos(a) * y), r: P.r + r, pr: P.r };
}

/** True when a clip moves/scales (itself or through a parent). */
export function transformed(clip, byId, depth = 0) {
  if (!clip) return false;
  if (XF_PROPS.some((k) => animates(clip, k))) return true;
  const p = clip.parent && depth < 8 ? byId.get(clip.parent) : null;
  return Boolean(p && p.id !== clip.id && (transformed(p, byId, depth + 1) || animates(p, 'rotate')));
}

/** Same as xformAt, as ffmpeg expressions of the local-time expression T. */
export function xformExpr(clip, T, byId, W, H, depth = 0) {
  const s = animates(clip, 'scale') ? propExpr(clip, 'scale', 1, T) : '1';
  const x = animates(clip, 'px') ? `(${propExpr(clip, 'px', 0, T)})*${W}` : '0';
  const y = animates(clip, 'py') ? `(${propExpr(clip, 'py', 0, T)})*${H}` : '0';
  const r = animates(clip, 'rotate') ? propExpr(clip, 'rotate', 0, T) : '0';
  const p = clip.parent && depth < 8 ? byId.get(clip.parent) : null;
  if (!p || p.id === clip.id) return { s, x, y, r, pr: '0' };
  const P = xformExpr(p, `(${T}+${fx(clip.start - p.start)})`, byId, W, H, depth + 1);
  const a = `((${P.r})*PI/180)`;
  return {
    s: `(${P.s})*(${s})`,
    x: `(${P.x})+(${P.s})*(cos(${a})*(${x})-sin(${a})*(${y}))`,
    y: `(${P.y})+(${P.s})*(sin(${a})*(${x})+cos(${a})*(${y}))`,
    r: `(${P.r})+(${r})`,
    pr: P.r,
  };
}

// ------------------------------------------------------------------ time remap

/** Time remap keys of a clip (t = local timeline seconds, v = source seconds), or null. */
export const remapOf = (c) => (Array.isArray(c?.remap) && c.remap.length >= 2 ? [...c.remap].sort((a, b) => a.t - b.t) : null);
/** Timeline length of a remapped clip. */
export const remapDur = (c) => {
  const r = remapOf(c);
  return r ? Math.max(0, r[r.length - 1].t) : null;
};
/** Source time of a remapped clip at local time t. */
export const remapAt = (c, t) => kfAt(remapOf(c), t, c.in);
/** Playback rate at local time t (preview). */
export function remapRate(c, t) {
  const r = remapOf(c);
  if (!r) return 1;
  const h = 1 / 60;
  return Math.max(0.0625, Math.min(16, (kfAt(r, t + h, c.in) - kfAt(r, t, c.in)) / h));
}
/** Source range read by a remapped clip. */
export function remapRange(c) {
  const r = remapOf(c);
  if (!r) return null;
  let lo = Infinity;
  let hi = -Infinity;
  const end = r[r.length - 1].t;
  for (let i = 0; i <= 200; i++) {
    const v = kfAt(r, (end * i) / 200, c.in);
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return { lo: Math.max(0, lo), hi };
}

/**
 * setpts expression for a remapped clip: for an input frame at source time (lo + PTS*TB) find the local
 * time t with remap(t) = that source time (bisection, 30 steps; remap must only go forward).
 */
export function remapSetpts(c) {
  const r = remapOf(c);
  const { lo } = remapRange(c);
  const dur = r[r.length - 1].t;
  const curve = propExpr({ id: c.id, keyframes: { zoom: r } }, 'zoom', c.in, 'ld(5)');
  return `st(6,${fx(lo)}+(PTS-STARTPTS)*TB);st(3,0);st(4,${fx(dur)});st(7,0);while(lt(ld(7),30),st(5,(ld(3)+ld(4))/2);if(lt(${curve},ld(6)),st(3,ld(5)),st(4,ld(5)));st(7,ld(7)+1));(ld(3)+ld(4))/2/TB`;
}

/** Remap presets over a clip whose current source range is [a, a + S] and timeline length D. */
export function remapPreset(name, a, S, D) {
  const k = (t, v, ease = 'linear') => ({ t: Math.round(t * 1000) / 1000, v: Math.round(v * 1000) / 1000, ease });
  switch (name) {
    case 'ramp': // fast -> slow -> fast (AE speed ramp)
      return [k(0, a, 'easy_out'), k(D * 0.3, a + S * 0.42, 'linear'), k(D * 0.7, a + S * 0.58, 'easy_in'), k(D, a + S)];
    case 'slow_end': // runs fast, lands in slow motion
      return [k(0, a, 'easy_out'), k(D * 0.4, a + S * 0.7, 'easy_in'), k(D, a + S)];
    case 'fast_end': // starts in slow motion, speeds out
      return [k(0, a, 'easy_out'), k(D * 0.6, a + S * 0.3, 'easy_in'), k(D, a + S)];
    default:
      return [k(0, a), k(D, a + S)];
  }
}

// ------------------------------------------------------------------ motion blur

/** Samples per output frame and frames averaged for a shutter angle (AE: 180 degrees = half a frame). */
export function blurSamples(mb) {
  const N = Math.max(2, Math.min(16, Math.round(Number(mb?.samples) || 8)));
  const K = Math.max(1, Math.min(N, Math.round((N * Math.max(0, Math.min(720, Number(mb?.shutter) || 180))) / 360)));
  return { N, K };
}
