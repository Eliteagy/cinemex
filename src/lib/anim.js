// Keyframe animation like After Effects, shared by the preview (JS values) and the export (ffmpeg
// expressions built from the same numbers), so both move the same way.
//
// Interpolation of the segment that starts at a keyframe (keyframe.ease):
//   smooth    ease in-out (smoothstep, Elite Cinema's default)
//   linear    constant speed
//   hold      keeps the value until the next keyframe (AE "Toggle Hold Keyframe")
//   easy      AE "Easy Ease" (cubic bezier 0.333,0 0.667,1)
//   easy_in   AE "Easy Ease In" (arrives slowly: 0,0 0.667,1)
//   easy_out  AE "Easy Ease Out" (leaves slowly: 0.333,0 1,1)
//   bezier    own speed curve keyframe.bz = [x1, y1, x2, y2] (CSS cubic-bezier, AE graph editor)
//
// Modifiers per property (clip.mods[prop]), like the usual AE expressions:
//   wiggle    { freq (per s), amp, seed }   wiggle(freq, amp): smooth pseudo-random wobble
//   loop      { mode: 'cycle' | 'pingpong' } loopOut(): repeats the keyframes until the clip ends
//   overshoot { amp, freq, decay }           inertial bounce after every keyframe

export const EASES = ['smooth', 'linear', 'hold', 'easy', 'easy_in', 'easy_out', 'bezier'];
export const EASE_LABELS = { smooth: 'Suave', linear: 'Linear', hold: 'Hold', easy: 'Easy ease', easy_in: 'Easy ease in', easy_out: 'Easy ease out', bezier: 'Curva' };
const CURVES = { easy: [0.333, 0, 0.667, 1], easy_in: [0, 0, 0.667, 1], easy_out: [0.333, 0, 1, 1] };
/** Newton iterations solving x(s) = u; fixed so the ffmpeg expression does exactly the same. */
export const NEWTON = 6;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smooth = (u) => u * u * (3 - 2 * u);

/** Bezier control points of a keyframe's segment, or null for smooth/linear/hold. */
export function curveOf(k) {
  const e = k?.ease;
  if (e === 'bezier' && Array.isArray(k.bz) && k.bz.length === 4) return k.bz.map((v, i) => (i % 2 === 0 ? clamp01(Number(v) || 0) : Number(v) || 0));
  return CURVES[e] || null;
}

/** y of a cubic bezier (0,0)-(x1,y1)-(x2,y2)-(1,1) at x = u. */
export function bezierAt(c, u) {
  const [x1, y1, x2, y2] = c;
  const bx = (s) => 3 * x1 * s * (1 - s) * (1 - s) + 3 * x2 * s * s * (1 - s) + s * s * s;
  const dx = (s) => 3 * x1 * (1 - s) * (1 - s) + 6 * (x2 - x1) * s * (1 - s) + 3 * (1 - x2) * s * s;
  let s = u;
  for (let i = 0; i < NEWTON; i++) s = clamp01(s - (bx(s) - u) / Math.max(1e-6, dx(s)));
  return 3 * y1 * s * (1 - s) * (1 - s) + 3 * y2 * s * s * (1 - s) + s * s * s;
}

/** Eased progress 0..1 of a segment starting at keyframe k. */
export function easeAt(k, u) {
  u = clamp01(u);
  const e = k?.ease || 'smooth';
  if (e === 'linear') return u;
  if (e === 'hold') return u >= 1 ? 1 : 0;
  const c = curveOf(k);
  return c ? bezierAt(c, u) : smooth(u);
}

const sorted = (list) => (list || []).filter((k) => Number.isFinite(k.t) && Number.isFinite(k.v)).sort((a, b) => a.t - b.t);

/** Value of a keyframe list at local time t (no modifiers). */
export function kfAt(list, t, def) {
  const k = sorted(list);
  if (!k.length) return def;
  if (t <= k[0].t) return k[0].v;
  for (let i = 1; i < k.length; i++) {
    const a = k[i - 1];
    const b = k[i];
    if (t < b.t) return a.v + (b.v - a.v) * easeAt(a, (t - a.t) / Math.max(1e-6, b.t - a.t));
  }
  return k[k.length - 1].v;
}

// ------------------------------------------------------------------ modifiers

/** Deterministic phases for a wiggle seed. */
function phases(seed) {
  let s = 0;
  for (const ch of String(seed ?? 'w')) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  const r = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 4294967296) * Math.PI * 2;
  };
  return [r(), r(), r()];
}
/** Wiggle shape: three sines at unrelated frequencies, normalised to about ±1. */
const W_F = [1, 1.93, 3.11];
const W_A = [0.55, 0.3, 0.15];

/** Local time after a loop modifier (keyframes repeat after the last one). */
export function loopTime(list, t, mod) {
  const k = sorted(list);
  if (!mod || mod.type !== 'loop' || k.length < 2) return t;
  const a = k[0].t;
  const L = k[k.length - 1].t - a;
  if (L <= 1e-6 || t <= a + L) return t;
  const x = t - a;
  if (mod.mode === 'pingpong') {
    const m = x % (2 * L);
    return a + (m <= L ? m : 2 * L - m);
  }
  return a + (x % L);
}

/** Value of a clip property at local time t with its modifiers. */
export function propAt(clip, prop, t, def) {
  const list = clip?.keyframes?.[prop];
  const mod = clip?.mods?.[prop];
  let v = kfAt(list, loopTime(list, t, mod), def);
  if (mod?.type === 'wiggle' && mod.amp) {
    const ph = phases(mod.seed ?? clip.id);
    const f = Math.max(0.01, Number(mod.freq) || 1);
    let w = 0;
    for (let i = 0; i < 3; i++) w += W_A[i] * Math.sin(2 * Math.PI * f * W_F[i] * t + ph[i]);
    v += mod.amp * w;
  }
  if (mod?.type === 'overshoot') {
    const k = sorted(list);
    const f = Math.max(0.1, Number(mod.freq) || 3);
    const dk = Math.max(0, Number(mod.decay) || 6);
    const amp = Number(mod.amp) || 0.25;
    for (let i = 1; i < k.length; i++) {
      const dt = t - k[i].t;
      if (dt > 0) v += (k[i].v - k[i - 1].v) * amp * Math.sin(2 * Math.PI * f * dt) * Math.exp(-dk * dt);
    }
  }
  return v;
}

// ------------------------------------------------------------------ ffmpeg expressions

const fx = (n) => String(Math.round(n * 10000) / 10000);

/** ffmpeg expression of the eased progress for segment start k, with u held in variable `uv`. */
function easeExpr(k, uv) {
  const u = `ld(${uv})`;
  const e = k?.ease || 'smooth';
  if (e === 'linear') return u;
  if (e === 'hold') return `gte(${u},1)`;
  const c = curveOf(k);
  if (!c) return `${u}*${u}*(3-2*${u})`;
  const [x1, y1, x2, y2] = c.map(fx);
  const s = `ld(${uv + 1})`;
  const bx = `(3*${x1}*${s}*(1-${s})*(1-${s})+3*${x2}*${s}*${s}*(1-${s})+${s}*${s}*${s})`;
  const dx = `(3*${x1}*(1-${s})*(1-${s})+6*(${x2}-${x1})*${s}*(1-${s})+3*(1-${x2})*${s}*${s})`;
  let out = `st(${uv + 1},${u})`;
  for (let i = 0; i < NEWTON; i++) out += `;st(${uv + 1},clip(${s}-(${bx}-${u})/max(0.000001,${dx}),0,1))`;
  return `(${out};3*${y1}*${s}*(1-${s})*(1-${s})+3*${y2}*${s}*${s}*(1-${s})+${s}*${s}*${s})`;
}

/** Keyframe list as an expression of time expression `T` (constant before the first, after the last). */
export function kfExpr(list, def, T = 'T') {
  const k = sorted(list);
  if (!k.length) return fx(def);
  if (k.length === 1) return fx(k[0].v);
  // st(0) = time, st(1) = u of the segment, st(2) = bezier parameter
  let e = fx(k[k.length - 1].v);
  for (let i = k.length - 1; i >= 1; i--) {
    const a = k[i - 1];
    const b = k[i];
    const span = Math.max(1e-6, b.t - a.t);
    const seg = `(st(1,clip((ld(0)-${fx(a.t)})/${fx(span)},0,1));${fx(a.v)}+(${fx(b.v - a.v)})*${easeExpr(a, 1)})`;
    e = `if(lt(ld(0),${fx(b.t)}),${seg},${e})`;
  }
  return `(st(0,${T});if(lt(ld(0),${fx(k[0].t)}),${fx(k[0].v)},${e}))`;
}

/** A clip property (keyframes + modifiers) as an ffmpeg expression of time `T`. */
export function propExpr(clip, prop, def, T = 'T') {
  const list = clip?.keyframes?.[prop];
  const mod = clip?.mods?.[prop];
  let Tl = T;
  const k = sorted(list);
  if (mod?.type === 'loop' && k.length >= 2) {
    const a = k[0].t;
    const L = k[k.length - 1].t - a;
    if (L > 1e-6) {
      const x = `(${T}-${fx(a)})`;
      Tl = mod.mode === 'pingpong'
        ? `if(lte(${T},${fx(a + L)}),${T},${fx(a)}+if(lte(mod(${x},${fx(2 * L)}),${fx(L)}),mod(${x},${fx(2 * L)}),${fx(2 * L)}-mod(${x},${fx(2 * L)})))`
        : `if(lte(${T},${fx(a + L)}),${T},${fx(a)}+mod(${x},${fx(L)}))`;
    }
  }
  let e = kfExpr(list, def, Tl);
  if (mod?.type === 'wiggle' && mod.amp) {
    const ph = phases(mod.seed ?? clip.id);
    const f = Math.max(0.01, Number(mod.freq) || 1);
    const w = [0, 1, 2].map((i) => `${fx(W_A[i])}*sin(${fx(2 * Math.PI * f * W_F[i])}*${T}+${fx(ph[i])})`).join('+');
    e = `(${e}+${fx(mod.amp)}*(${w}))`;
  }
  if (mod?.type === 'overshoot') {
    const f = Math.max(0.1, Number(mod.freq) || 3);
    const dk = Math.max(0, Number(mod.decay) || 6);
    const amp = Number(mod.amp) || 0.25;
    const parts = [];
    for (let i = 1; i < k.length; i++) {
      const d = k[i].v - k[i - 1].v;
      if (Math.abs(d) < 1e-9) continue;
      const dt = `(${T}-${fx(k[i].t)})`;
      parts.push(`if(gt(${dt},0),${fx(d * amp)}*sin(${fx(2 * Math.PI * f)}*${dt})*exp(-${fx(dk)}*${dt}),0)`);
    }
    if (parts.length) e = `(${e}+${parts.join('+')})`;
  }
  return e;
}

/** True when a property animates (keyframes or a modifier that moves it). */
export function animates(clip, prop) {
  const l = clip?.keyframes?.[prop];
  const m = clip?.mods?.[prop];
  return Boolean((l && l.length) || (m && (m.type === 'wiggle' ? m.amp : m.type)));
}
