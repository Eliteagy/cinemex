// Photoshop layer tools shared by the preview and the export (docs/engenharia-reversa/photocraft.md):
//
//   Blend If (§3.5, PhotoCraft crates/doc/src/blend_if.rs): the layer's alpha is multiplied by a soft
//   luma range of the layer itself ("Esta camada") and of what is under it ("Camada subjacente").
//   Each range is [blackLo, blackHi, whiteLo, whiteHi] on 0..255:
//     w(v) = ramp(blackLo, blackHi, v) · ramp(255 − whiteHi, 255 − whiteLo, 255 − v)
//   Grey = the composite channel (Rec.601 luma, 0.299/0.587/0.114, like Photoshop's Gray).
//
//   Color to Alpha (§3.6, crates/algo/src/color_to_alpha.rs): removes a colour C and keeps the rest
//   exactly (composited back over C it gives the original pixel):
//     a_i = (P−C)/(1−C) if P > C, (C−P)/C if P < C;  a = max a_i;  Q = C + (P−C)/a
//   threshold t (0..1): a' = clamp((a − t)/(1 − t)) (PhotoCraft's transparency threshold; opacity threshold 1).
//
// Forms: js (reference, tests), glsl (src/engine/glblend.ts), ff (render.cjs / layerfx.js).

const clamp = (v, a, b) => Math.max(a, Math.min(b, Number.isFinite(Number(v)) ? Number(v) : a));
const fx = (n) => String(Math.round(n * 1e6) / 1e6);

export const BLENDIF_OFF = Object.freeze([0, 0, 255, 255]);
export const LUMA601 = [0.299, 0.587, 0.114];

/** A range clamped and ordered, or the "off" range. */
function cleanRange(r) {
  if (!Array.isArray(r) || r.length !== 4) return [...BLENDIF_OFF];
  const [a, b, c, d] = r.map((v) => Math.round(clamp(v, 0, 255)));
  const bl = Math.min(a, b);
  const bh = Math.max(a, b);
  const wl = Math.max(bh, Math.min(c, d));
  const wh = Math.max(wl, Math.max(c, d));
  return [bl, bh, wl, wh];
}
const rangeOn = (r) => r[0] > 0 || r[1] > 0 || r[2] < 255 || r[3] < 255;

/** { this, under } clamped; null when both are off. */
export function cleanBlendIf(b) {
  if (!b || typeof b !== 'object') return null;
  const t = cleanRange(b.this);
  const u = cleanRange(b.under);
  return rangeOn(t) || rangeOn(u) ? { this: t, under: u } : null;
}
export const blendIfActive = (b) => cleanBlendIf(b) !== null;

const ramp = (a, b, x) => (b <= a ? (x >= a ? 1 : 0) : Math.max(0, Math.min(1, (x - a) / (b - a))));
/** Weight 0..1 of a grey value v (0..255) for one range. */
export const blendIfWeight = (r, v) => ramp(r[0], r[1], v) * ramp(255 - r[3], 255 - r[2], 255 - v);

/** ffmpeg expression of the weight for one range, on the value `v` (0..255). */
export function blendIfFF(r, v) {
  const rp = (a, b, x) => (b <= a ? `gte(${x},${a})` : `clip((${x}-${a})/${b - a},0,1)`);
  return `${rp(r[0], r[1], v)}*${rp(255 - r[3], 255 - r[2], `(255-${v})`)}`;
}

/** GLSL: weight of grey g (0..1) for a range r (vec4 on 0..255). */
export const BLENDIF_GLSL = `
float bifRamp(float a, float b, float x) { return b <= a ? step(a, x) : clamp((x - a) / (b - a), 0.0, 1.0); }
float bifW(vec4 r, float g) { float v = g * 255.0; return bifRamp(r.x, r.y, v) * bifRamp(255.0 - r.w, 255.0 - r.z, 255.0 - v); }
float bifLuma(vec3 c) { return dot(c, vec3(${LUMA601.join(', ')})); }`;

// ---------------------------------------------------------------------------------------------
// Color to Alpha

const hexRgb = (h) => {
  const s = String(h || '#000000').replace('#', '').padEnd(6, '0');
  return [0, 2, 4].map((i) => (parseInt(s.slice(i, i + 2), 16) || 0) / 255);
};

/** { color: [r, g, b] 0..1, threshold } or null. */
export function cleanColorToAlpha(c) {
  if (!c || typeof c !== 'object' || !/^#[0-9a-fA-F]{6}$/.test(String(c.color || ''))) return null;
  return { color: hexRgb(c.color), threshold: clamp(c.threshold ?? 0, 0, 0.99) };
}

/** Reference: pixel (0..1) -> [r, g, b, alpha factor]. */
export function colorToAlphaJS(p, C, t = 0) {
  const ai = p.map((v, i) => (v > C[i] ? (v - C[i]) / Math.max(1e-6, 1 - C[i]) : v < C[i] ? (C[i] - v) / Math.max(1e-6, C[i]) : 0));
  const a = Math.max(...ai);
  const q = a > 1e-6 ? p.map((v, i) => Math.max(0, Math.min(1, C[i] + (v - C[i]) / a))) : [...C];
  return [...q, Math.max(0, Math.min(1, (a - t) / (1 - t)))];
}

/** geq expressions (rgba / gbrap, 8-bit) for Color to Alpha; the layer's own alpha is kept (multiplied). */
export function colorToAlphaGeq(C, t = 0) {
  const P = ['r(X,Y)/255', 'g(X,Y)/255', 'b(X,Y)/255'];
  const ai = (i) => `if(gt(${P[i]},${fx(C[i])}),(${P[i]}-${fx(C[i])})/${fx(Math.max(1e-6, 1 - C[i]))},if(lt(${P[i]},${fx(C[i])}),(${fx(C[i])}-${P[i]})/${fx(Math.max(1e-6, C[i]))},0))`;
  const A = `st(0,max(max(${ai(0)},${ai(1)}),${ai(2)}))`;
  const ch = (i) => `${A};255*if(gt(ld(0),0.000001),clip(${fx(C[i])}+(${P[i]}-${fx(C[i])})/ld(0),0,1),${fx(C[i])})`;
  return { r: ch(0), g: ch(1), b: ch(2), a: `${A};alpha(X,Y)*clip((ld(0)-${fx(t)})/${fx(1 - t)},0,1)` };
}

/** GLSL: straight colour -> (Q, alpha factor). */
export const CTA_GLSL = `
vec4 colorToAlpha(vec3 p, vec3 C, float t) {
  vec3 hi = (p - C) / max(vec3(1e-6), 1.0 - C);
  vec3 lo = (C - p) / max(vec3(1e-6), C);
  vec3 ai = mix(mix(vec3(0.0), lo, step(p, C - 1e-7)), hi, step(C + 1e-7, p));
  float a = max(ai.r, max(ai.g, ai.b));
  vec3 q = a > 1e-6 ? clamp(C + (p - C) / a, 0.0, 1.0) : C;
  return vec4(q, clamp((a - t) / (1.0 - t), 0.0, 1.0));
}`;

// ---------------------------------------------------------------------------------------------
// Layer styles maths shared by layerfx.js (export) and src/engine/layerfx.ts (preview).

/** Stroke edge: the alpha blurred with σ = size/2 is cut where a hard edge is `size` away. */
export const STROKE_T = 0.0228;
export const STROKE_SOFT = 0.03;
export const strokeMask = (g) => Math.max(0, Math.min(1, (g - STROKE_T) / STROKE_SOFT));
/** Glow spread 0..1 -> number of stacked copies (alpha 1 − (1 − g)^n). */
export const spreadN = (s) => 1 + Math.round(clamp(s, 0, 1) * 4);
