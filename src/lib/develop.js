// Develop: LightCraft's per-pixel colour pipeline (display-referred path), ported to plain JS so the
// preview and the export can bake the very same clip colour into one 3D LUT.
//
// Source: LightCraft crates color/{cct,perceptual,spline,transfer}.rs and pipeline/{finish,colorops,
// tone,curve,profiles,auto}.rs. Order of the per-pixel stage (finish.rs `finish_with`), for an 8-bit
// sRGB / Rec.709 source (LightCraft's "rendered" path: no raw, no camera curve):
//   legacy grade (old clip.color sliders, see below) → sRGB decode → linear Rec.709 → Rec.2020
//   → white balance (Bradford from Kim-cubic CCT + tint, luminance-normalised) → exposure (2^EV)
//   → Highlights / Shadows (global part, see below) → calibration → display tone map on luminance
//   (ratio-preserving, highlight desaturation) → OkLab colour ops (HSL mixer, vibrance with skin
//   protection, saturation, B&W mix, grading wheels) → gamut map to sRGB → sRGB encode
//   → tone curves (parametric ∘ point ∘ per channel) + Refine Saturation.
//
// Not here: vignette, grain, clarity/texture/dehaze/sharpening (spatial), masks, the clip's .cube
// (bakeLut composes it after), Point Color.
//
// Highlights / Shadows: in LightCraft they are spatial (finish.rs `local_tone_delta`, weighted by a
// guided-filter base of log luminance). Display sources have no separate global version, so this
// port uses the degenerate case "base = the pixel's own log luminance" (a radius-0 base): the same
// weights and gains, but as a global tone curve, without the local contrast preservation. When the
// spatial base comes later only `base` changes.
//
// Legacy sliders (clip.color.exposure/contrast/saturation/temperature, −1..1): not remapped onto the
// LightCraft sliders, but applied verbatim first, on the encoded values, with the same maths as
// gradeMath() today (export order: per-channel warm × brightness, contrast about 0.5, then the
// Rec.709-weighted saturate matrix the preview's CSS filter uses), so an old project keeps its look
// and the new sliders then work on top. vignette and lut are left to the caller.

const PI = Math.PI;
const TAU = 2 * Math.PI;

const num = (v, def, lo, hi) => {
  const n = Number(v);
  const x = v === undefined || v === null || v === '' || !Number.isFinite(n) ? def : n;
  return Math.max(lo, Math.min(hi, x));
};
const smooth = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const remE = (a, m) => ((a % m) + m) % m;
const wrap = (a) => remE(a + PI, TAU) - PI;

// ---------------------------------------------------------------------------------------------
// 3×3 matrices (row-major) and colour spaces (color/src/lib.rs)

const mmul = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
const mapply = (m, v) => [
  m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
  m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
  m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
];
function minv(m) {
  const d =
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (Math.abs(d) < 1e-300) return null;
  const i = 1 / d;
  return [
    [(m[1][1] * m[2][2] - m[1][2] * m[2][1]) * i, (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * i, (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * i],
    [(m[1][2] * m[2][0] - m[1][0] * m[2][2]) * i, (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * i, (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * i],
    [(m[1][0] * m[2][1] - m[1][1] * m[2][0]) * i, (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * i, (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * i],
  ];
}
const IDENT = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const diag = (a, b, c) => [[a, 0, 0], [0, b, 0], [0, 0, c]];

const xyToXyz = ([x, y]) => [x / y, 1, (1 - x - y) / y];
const xyFromXyz = (v) => {
  const s = v[0] + v[1] + v[2];
  return s <= 0 ? D65 : [v[0] / s, v[1] / s];
};
const D65 = [0.3127, 0.329];
const SRGB = { r: [0.64, 0.33], g: [0.3, 0.6], b: [0.15, 0.06], white: D65 };
const REC2020 = { r: [0.708, 0.292], g: [0.17, 0.797], b: [0.131, 0.046], white: D65 };

function toXyz(sp) {
  const p = [xyToXyz(sp.r), xyToXyz(sp.g), xyToXyz(sp.b)];
  const m = [[p[0][0], p[1][0], p[2][0]], [p[0][1], p[1][1], p[2][1]], [p[0][2], p[1][2], p[2][2]]];
  const inv = minv(m);
  const s = inv ? mapply(inv, xyToXyz(sp.white)) : [1, 1, 1];
  return mmul(m, diag(s[0], s[1], s[2]));
}
const BRADFORD = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
const BRADFORD_INV = minv(BRADFORD);
function bradford(src, dst) {
  if (src[0] === dst[0] && src[1] === dst[1]) return IDENT;
  const s = mapply(BRADFORD, xyToXyz(src));
  const d = mapply(BRADFORD, xyToXyz(dst));
  return mmul(mmul(BRADFORD_INV, diag(d[0] / s[0], d[1] / s[1], d[2] / s[2])), BRADFORD);
}
const X2020 = toXyz(REC2020);
const X2020_INV = minv(X2020);
const XSRGB = toXyz(SRGB);
/** Linear sRGB → linear Rec.2020, and back (same white: no adaptation). */
const S2W = mmul(X2020_INV, XSRGB);
const W2S = mmul(minv(XSRGB), X2020);
const SRGB_LUMA = XSRGB[1];
const L20 = [0.2627, 0.678, 0.0593];

// ---------------------------------------------------------------------------------------------
// Transfer (color/src/transfer.rs)

const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const linearToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

// ---------------------------------------------------------------------------------------------
// OkLab on linear Rec.2020 (color/src/perceptual.rs)

const XYZ_TO_LMS = [[0.8189330101, 0.3618667424, -0.1288597137], [0.0329845436, 0.9293118715, 0.0361456387], [0.0482003018, 0.2643662691, 0.633851707]];
const LMS_TO_LAB = [[0.2104542553, 0.793617785, -0.0040720468], [1.9779984951, -2.428592205, 0.4505937099], [0.0259040371, 0.7827717662, -0.808675766]];
const TO_LMS = mmul(XYZ_TO_LMS, X2020);
const FROM_LMS = minv(TO_LMS);
const LAB_FROM_LMS = minv(LMS_TO_LAB);
function oklabFrom2020(c) {
  const l = mapply(TO_LMS, c).map(Math.cbrt);
  return mapply(LMS_TO_LAB, l);
}
function oklabTo2020(lab) {
  const l = mapply(LAB_FROM_LMS, lab).map((v) => v * v * v);
  return mapply(FROM_LMS, l);
}
function hsvToRgb(h, s, v) {
  const c = v * s;
  const hp = remE(h, 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const k = Math.floor(hp);
  const [r, g, b] = k === 0 ? [c, x, 0] : k === 1 ? [x, c, 0] : k === 2 ? [0, c, x] : k === 3 ? [0, x, c] : k === 4 ? [x, 0, c] : [c, 0, x];
  const m = v - c;
  return [r + m, g + m, b + m];
}
/** OkLCh hue (radians) of the pure sRGB colour with HSV hue `deg` (colorops.rs oklch_hue_of_srgb_hue). */
function oklchHueOfSrgbHue(deg) {
  const lin = hsvToRgb(deg, 1, 1).map(srgbToLinear);
  const lab = oklabFrom2020(mapply(S2W, lin));
  return Math.atan2(lab[2], lab[1]);
}

// ---------------------------------------------------------------------------------------------
// Correlated colour temperature and tint (color/src/cct.rs)

const TINT_SCALE = 3000;
const MIN_K = 1667;
const MAX_K = 25000;
function kimXy(t0) {
  const t = Math.max(MIN_K, Math.min(MAX_K, t0));
  const t2 = t * t;
  const t3 = t2 * t;
  const x = t <= 4000 ? -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / t + 0.17991 : -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.24039;
  const x2 = x * x;
  const x3 = x2 * x;
  const y =
    t <= 2222
      ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
      : t <= 4000
        ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}
const xyToUv = ([x, y]) => {
  const d = -2 * x + 12 * y + 3;
  return [(4 * x) / d, (6 * y) / d];
};
const uvToXy = (u, v) => {
  const d = 2 * u - 8 * v + 4;
  return [(3 * u) / d, (2 * v) / d];
};
function locusUv(t0) {
  const t = Math.max(t0, 1000);
  if (t >= MIN_K && t <= MAX_K) return xyToUv(kimXy(t));
  const [a, b] = t < MIN_K ? [MIN_K, MIN_K + 50] : [MAX_K - 500, MAX_K];
  const [ua, va] = xyToUv(kimXy(a));
  const [ub, vb] = xyToUv(kimXy(b));
  const ma = 1e6 / a;
  const mb = 1e6 / b;
  const s = (1e6 / t - ma) / (mb - ma);
  return [ua + (ub - ua) * s, va + (vb - va) * s];
}
function locusNormal(t) {
  const m = 1e6 / t;
  const [u0, v0] = locusUv(1e6 / (m + 1));
  const [u1, v1] = locusUv(1e6 / Math.max(m - 1, 1));
  const du = u1 - u0;
  const dv = v1 - v0;
  const l = Math.max(Math.hypot(du, dv), 1e-12);
  const nx = -dv / l;
  const ny = du / l;
  return ny < 0 ? [-nx, -ny] : [nx, ny];
}
/** Source white (xy) for temperature `t` (K) and tint correction (positive = add magenta). */
export function tempTintToXy(t, tint) {
  const [u, v] = locusUv(t);
  const [nu, nv] = locusNormal(t);
  const duv = tint / TINT_SCALE;
  return uvToXy(u + nu * duv, v + nv * duv);
}
/** Inverse of tempTintToXy: nearest locus temperature (mired search) and tint. */
export function xyToTempTint(p) {
  const [u, v] = xyToUv(p);
  const dist = (m) => {
    const [lu, lv] = locusUv(1e6 / m);
    return (u - lu) ** 2 + (v - lv) ** 2;
  };
  let best = 20;
  let bd = Infinity;
  for (let m = 20; m <= 1000; m += 5) {
    const d = dist(m);
    if (d < bd) {
      bd = d;
      best = m;
    }
  }
  let a = Math.max(best - 5, 20);
  let b = Math.min(best + 5, 1000);
  const g = 0.61803398875;
  for (let i = 0; i < 60; i++) {
    const c = b - g * (b - a);
    const d = a + g * (b - a);
    if (dist(c) < dist(d)) b = d;
    else a = c;
  }
  const t = 1e6 / ((a + b) / 2);
  const [lu, lv] = locusUv(t);
  const [nu, nv] = locusNormal(t);
  return [t, ((u - lu) * nu + (v - lv) * nv) * TINT_SCALE];
}
const wbMatrix2020 = (src) => mmul(mmul(X2020_INV, bradford(src, D65)), X2020);
/** White balance from the as-shot white (6500 K / 0 for rendered sources) to temp/tint, neutral luminance kept (local.rs wb_matrix_for). */
function wbFor(temp, tint) {
  if (Math.abs(temp - 6500) < 1e-6 && Math.abs(tint) < 1e-6) return null;
  const set = wbMatrix2020(tempTintToXy(temp, tint));
  const shot = wbMatrix2020(tempTintToXy(6500, 0));
  const m = mmul(set, minv(shot) || IDENT);
  const g = mapply(m, [1, 1, 1]);
  const y = g[0] * 0.2627 + g[1] * 0.678 + g[2] * 0.0593;
  return mmul(m, diag(1 / y, 1 / y, 1 / y));
}

// ---------------------------------------------------------------------------------------------
// Monotone cubic curve and 1-D tables (color/src/spline.rs)

function monotoneCurve(points) {
  let p = points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)).sort((a, b) => a[0] - b[0]);
  p = p.filter((q, i) => i === 0 || Math.abs(q[0] - p[i - 1][0]) >= 1e-9);
  if (p.length < 2) p = [[0, 0], [1, 1]];
  const n = p.length;
  const xs = p.map((q) => q[0]);
  const ys = p.map((q) => q[1]);
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const ms = new Array(n).fill(0);
  ms[0] = d[0];
  ms[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) ms[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      ms[i] = 0;
      ms[i + 1] = 0;
      continue;
    }
    const a = ms[i] / d[i];
    const b = ms[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      ms[i] = t * a * d[i];
      ms[i + 1] = t * b * d[i];
    }
  }
  return (x) => {
    if (Number.isNaN(x)) return x;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && xs[i + 1] <= x) i++;
    if (xs[i] === x) return ys[i];
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * ms[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * ms[i + 1];
  };
}
const lutEval = (lut, x0) => {
  const n = lut.length;
  const f = (x0 < 0 ? 0 : x0 > 1 ? 1 : x0) * (n - 1);
  let i = f | 0;
  if (i > n - 2) i = n - 2;
  return lut[i] + (lut[i + 1] - lut[i]) * (f - i);
};
const curveToLut = (fn, n) => Float64Array.from({ length: n }, (_, i) => fn(i / (n - 1)));
const composeLut = (outer, inner) => inner.map((x) => lutEval(outer, x));

// ---------------------------------------------------------------------------------------------
// Settings

export const BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];
export const WHEELS = ['shadows', 'midtones', 'highlights', 'global'];
const MIXER_HUES = [0, 30, 60, 120, 180, 225, 270, 315];

/** Default develop settings (LightCraft UI units). */
export const DEV_DEFAULT = Object.freeze({
  temp: 6500,
  tint: 0,
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  vibrance: 0,
  saturation: 0,
  hsl: Object.fromEntries(BANDS.map((b) => [b, { h: 0, s: 0, l: 0 }])),
  wheels: Object.fromEntries(WHEELS.map((w) => [w, { hue: 0, sat: 0, lum: 0 }])),
  blending: 50,
  balance: 0,
  curve: { shadows: 0, darks: 0, lights: 0, highlights: 0, split: [25, 50, 75], master: [], r: [], g: [], b: [] },
  refineSat: 100,
  bw: false,
  bwMix: Object.fromEntries(BANDS.map((b) => [b, 0])),
  look: { id: '', amount: 100 },
  calibration: { shadowsTint: 0, redHue: 0, redSat: 0, greenHue: 0, greenSat: 0, blueHue: 0, blueSat: 0 },
});

const s100 = (v) => num(v, 0, -100, 100);
const cleanPts = (p) =>
  Array.isArray(p)
    ? p
        .map((q) => (Array.isArray(q) ? [Number(q[0]), Number(q[1])] : q && typeof q === 'object' ? [Number(q.x), Number(q.y)] : null))
        .filter((q) => q && Number.isFinite(q[0]) && Number.isFinite(q[1]))
        .map(([x, y]) => [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))])
    : [];

/** Every field present, clamped to its range (garbage → defaults). */
export function cleanDev(dev) {
  const d = dev && typeof dev === 'object' ? dev : {};
  const o = (v) => (v && typeof v === 'object' ? v : {});
  const hsl = o(d.hsl);
  const wh = o(d.wheels);
  const cv = o(d.curve);
  const split = Array.isArray(cv.split) ? cv.split : [];
  const bm = d.bwMix;
  const cal = o(d.calibration);
  const lk = o(d.look);
  return {
    temp: num(d.temp, 6500, 2000, 50000),
    tint: num(d.tint, 0, -150, 150),
    exposure: num(d.exposure, 0, -5, 5),
    contrast: s100(d.contrast),
    highlights: s100(d.highlights),
    shadows: s100(d.shadows),
    whites: s100(d.whites),
    blacks: s100(d.blacks),
    vibrance: s100(d.vibrance),
    saturation: s100(d.saturation),
    hsl: Object.fromEntries(BANDS.map((b) => [b, { h: s100(o(hsl[b]).h), s: s100(o(hsl[b]).s), l: s100(o(hsl[b]).l) }])),
    wheels: Object.fromEntries(WHEELS.map((w) => [w, { hue: remE(num(o(wh[w]).hue, 0, -1e6, 1e6), 360), sat: num(o(wh[w]).sat, 0, 0, 100), lum: s100(o(wh[w]).lum) }])),
    blending: num(d.blending, 50, 0, 100),
    balance: s100(d.balance),
    curve: {
      shadows: s100(cv.shadows),
      darks: s100(cv.darks),
      lights: s100(cv.lights),
      highlights: s100(cv.highlights),
      split: [num(split[0], 25, 0, 100), num(split[1], 50, 0, 100), num(split[2], 75, 0, 100)],
      master: cleanPts(cv.master),
      r: cleanPts(cv.r),
      g: cleanPts(cv.g),
      b: cleanPts(cv.b),
    },
    refineSat: num(d.refineSat, 100, 0, 100),
    bw: d.bw === true,
    bwMix: Object.fromEntries(BANDS.map((b, i) => [b, s100(Array.isArray(bm) ? bm[i] : o(bm)[b])])),
    look: { id: typeof lk.id === 'string' ? lk.id : '', amount: num(lk.amount, 100, 0, 200) },
    calibration: Object.fromEntries(Object.keys(DEV_DEFAULT.calibration).map((k) => [k, s100(cal[k])])),
  };
}

// ---------------------------------------------------------------------------------------------
// Looks (pipeline/src/profiles.rs): deltas × amount under the user's sliders.
// d: slider deltas; hsl / bwMix / curve: per-field deltas; wheels: [hue, sat, lum] added as colour
// vectors; fade: point-curve output [black, white] composed after the user's curve; bw: B&W treatment.
// clarity / texture are kept as data (LightCraft's spatial effects) but not rendered here.

export const LOOKS = [
  { id: 'lc.neutral', label: 'Neutro', group: 'Básico', d: { contrast: -18, saturation: -10, highlights: -10, shadows: 8 } },
  { id: 'lc.vivid', label: 'Vivo', group: 'Básico', d: { contrast: 16, saturation: 14, vibrance: 14, blacks: -6 } },
  { id: 'lc.landscape', label: 'Paisagem', group: 'Básico', d: { contrast: 10, vibrance: 10, clarity: 6 }, hsl: { green: { s: 14 }, aqua: { s: 10 }, blue: { s: 14, l: -6 } } },
  { id: 'lc.portrait', label: 'Retrato', group: 'Básico', d: { contrast: -6, texture: -6 }, hsl: { orange: { s: -8, l: 6 }, red: { s: -5 } } },
  { id: 'lc.mono', label: 'Monocromático', group: 'Básico', bw: true, d: { contrast: 8 } },
  { id: 'lc.film.warm-print', label: 'Cópia quente', group: 'Película', d: { contrast: 6, saturation: -4 }, hsl: { orange: { l: 4 } }, fade: { master: [0.04, 0.97] }, wheels: { highlights: [40, 18, 0], shadows: [25, 8, 0] } },
  { id: 'lc.film.cool-fade', label: 'Desvanecido frio', group: 'Película', d: { contrast: -8, saturation: -10 }, fade: { master: [0.07, 0.95] }, wheels: { shadows: [210, 16, 0], highlights: [190, 6, 0] } },
  { id: 'lc.film.golden-hour', label: 'Hora dourada', group: 'Película', d: { vibrance: 10 }, curve: { highlights: -8 }, hsl: { orange: { s: 8 }, yellow: { h: -6 } }, wheels: { global: [45, 10, 0], highlights: [35, 20, 0] } },
  { id: 'lc.film.faded-slide', label: 'Diapositivo desbotado', group: 'Película', d: { contrast: 14, vibrance: 8, saturation: 6 }, curve: { shadows: 10 }, fade: { b: [0.06, 1], r: [0, 0.97] } },
  { id: 'lc.cine.teal-amber', label: 'Azul-petróleo e âmbar', group: 'Cinema', d: { contrast: 10 }, hsl: { orange: { s: 6 }, green: { h: 20, s: -20 }, blue: { h: -8 } }, wheels: { shadows: [195, 30, 0], highlights: [38, 24, 0] } },
  { id: 'lc.cine.night-blue', label: 'Noite azul', group: 'Cinema', d: { contrast: 12, saturation: -12 }, curve: { darks: -8 }, wheels: { shadows: [220, 28, -4], midtones: [215, 10, 0] } },
  { id: 'lc.cine.desert-heat', label: 'Calor do deserto', group: 'Cinema', d: { contrast: 8 }, curve: { lights: 6 }, hsl: { blue: { s: -25 }, aqua: { s: -20 } }, wheels: { global: [32, 16, 0], highlights: [48, 12, 0] } },
  { id: 'lc.cine.neon-dusk', label: 'Crepúsculo néon', group: 'Cinema', d: { contrast: 10, vibrance: 18 }, hsl: { magenta: { s: 12 }, purple: { s: 12 } }, wheels: { shadows: [265, 22, 0], highlights: [330, 14, 0] } },
  { id: 'lc.muted.matte-soft', label: 'Mate suave', group: 'Suave', d: { contrast: -12, saturation: -14 }, curve: { highlights: -6 }, fade: { master: [0.08, 0.96] } },
  { id: 'lc.muted.bleached', label: 'Descorado', group: 'Suave', d: { contrast: 22, saturation: -38, clarity: 8 }, curve: { lights: 6 } },
  { id: 'lc.muted.pastel-haze', label: 'Névoa pastel', group: 'Suave', d: { contrast: -18, saturation: -20, vibrance: 12 }, fade: { master: [0.1, 1] }, wheels: { highlights: [330, 6, 0], shadows: [200, 6, 0] } },
  { id: 'lc.muted.quiet-green', label: 'Verde calmo', group: 'Suave', d: { contrast: -4, saturation: -8 }, hsl: { green: { s: -30, h: -10 }, yellow: { s: -18 }, aqua: { s: -15 } }, fade: { master: [0.04, 1] } },
  { id: 'lc.bw.mono-rich', label: 'P&B rico', group: 'Preto e branco', bw: true, d: { contrast: 18 }, curve: { darks: -8, lights: 6 }, bwMix: { red: 8, orange: 10, blue: -12 } },
  { id: 'lc.bw.red-filter', label: 'Filtro vermelho', group: 'Preto e branco', bw: true, d: { contrast: 12 }, bwMix: { red: 40, orange: 30, yellow: 10, green: -20, aqua: -30, blue: -45 } },
  { id: 'lc.bw.soft', label: 'P&B suave', group: 'Preto e branco', bw: true, d: { contrast: -14 }, bwMix: { orange: 12 }, fade: { master: [0.06, 0.97] } },
  { id: 'lc.bw.sepia', label: 'Sépia', group: 'Preto e branco', bw: true, d: { contrast: 6 }, fade: { master: [0.04, 0.98] }, wheels: { shadows: [28, 18, 0], highlights: [45, 14, 0] } },
];
const LOOK_BY_ID = Object.fromEntries(LOOKS.map((l) => [l.id, l]));

function addWheel(w, hue, sat, lum, k) {
  const r = PI / 180;
  const a = w.sat * Math.cos(w.hue * r) + sat * k * Math.cos(hue * r);
  const b = w.sat * Math.sin(w.hue * r) + sat * k * Math.sin(hue * r);
  const s = Math.hypot(a, b);
  if (s > 1e-9) w.hue = remE((Math.atan2(b, a) * 180) / PI, 360);
  else if (w.sat === 0) w.hue = hue;
  w.sat = Math.max(0, Math.min(100, s));
  w.lum = Math.max(-100, Math.min(100, w.lum + lum * k));
}
function fade(pts, black, white, k) {
  const b = Math.max(0, Math.min(0.45, black * k));
  const w = Math.max(0.55, Math.min(1, 1 - (1 - white) * k));
  const p = pts.length < 2 ? [[0, 0], [1, 1]] : pts;
  return p.map(([x, y]) => [x, b + Math.max(0, Math.min(1, y)) * (w - b)]);
}

/** The settings that render: the user's (cleaned) with the look × amount merged under them. */
export function resolveLook(dev) {
  const s = cleanDev(dev);
  const look = LOOK_BY_ID[s.look.id];
  const k = Math.max(0, Math.min(2, s.look.amount / 100));
  if (!look || k === 0) return s;
  const add = (v, d) => Math.max(-100, Math.min(100, v + (d ?? 0) * k));
  for (const [key, d] of Object.entries(look.d || {})) if (key in s && typeof s[key] === 'number') s[key] = add(s[key], d);
  for (const [band, d] of Object.entries(look.hsl || {})) for (const f of ['h', 's', 'l']) s.hsl[band][f] = add(s.hsl[band][f], d[f]);
  for (const [key, d] of Object.entries(look.curve || {})) s.curve[key] = add(s.curve[key], d);
  for (const [band, d] of Object.entries(look.bwMix || {})) s.bwMix[band] = add(s.bwMix[band], d);
  for (const [ch, [b, w]] of Object.entries(look.fade || {})) s.curve[ch] = fade(s.curve[ch], b, w, k);
  for (const [name, [hue, sat, lum]] of Object.entries(look.wheels || {})) addWheel(s.wheels[name], hue, sat, lum, k);
  if (look.bw) s.bw = true;
  return s;
}

// ---------------------------------------------------------------------------------------------
// Tone map for display-referred sources (tone.rs ToneMap::display_hdr, SDR)

const GREY = 0.18;
const LUT_MIN_EV = -14;
const LUT_MAX_EV = 10;
const LUT_N = 4096;
function displayTone(contrast, whites, blacks) {
  const c = contrast / 100;
  const w = whites / 100;
  const b = blacks / 100;
  if (c === 0 && w === 0 && b === 0) return null; // identity up to white (issue #1945)
  const m = Math.pow(GREY, 1 / 2.2);
  const lut = new Float64Array(LUT_N);
  for (let i = 0; i < LUT_N; i++) {
    const ev = LUT_MIN_EV + ((LUT_MAX_EV - LUT_MIN_EV) * i) / (LUT_N - 1);
    const y = GREY * Math.pow(2, ev);
    let p = Math.pow(y, 1 / 2.2);
    if (p <= 1) {
      p += c * 0.35 * (p - m) * (1 - (2 * p - 1) ** 2);
      const up = smooth(0.45, 1, p);
      p += w * 0.12 * up * (1 - p * 0.5);
      const lo = 1 - smooth(0, 0.45, p);
      p += b * 0.07 * lo * Math.min(p * 2, 1);
    } else {
      p += w * 0.12 * 0.5;
    }
    let o = Math.pow(Math.max(p, 0), 2.2);
    if (o > 0.95) {
      const d = Math.min(o - 0.95, 0.1);
      o = 0.95 + d - (d * d) / 0.2;
    }
    lut[i] = Math.max(0, Math.min(1, o));
  }
  return lut;
}

// ---------------------------------------------------------------------------------------------
// Parametric tone curve (curve.rs) and the composed per-channel tables (finish.rs curve_luts)

const PARAM_LUT = 1024;
function parametricLut(cv) {
  const s0 = cv.split[0] / 100;
  const s1 = Math.max(s0, Math.min(1, cv.split[1] / 100));
  const s2 = Math.max(s1, Math.min(1, cv.split[2] / 100));
  const regions = [[0, s0, cv.shadows], [s0, s1, cv.darks], [s1, s2, cv.lights], [s2, 1, cv.highlights]];
  const lut = new Float64Array(PARAM_LUT);
  let prev = 0;
  for (let i = 0; i < PARAM_LUT; i++) {
    const x = i / (PARAM_LUT - 1);
    let d = 0;
    for (const [a, b, amt] of regions) {
      if (amt === 0) continue;
      const ctr = (a + b) / 2;
      const half = (b - a) * 0.75 + 0.05;
      if (half <= 1e-7) continue;
      const t = Math.max(-1, Math.min(1, (x - ctr) / half));
      d += (amt / 100) * 0.22 * (0.5 + 0.5 * Math.cos(t * PI));
    }
    const y = Math.max(0, Math.min(1, x + d * 4 * x * (1 - x)));
    prev = Math.max(prev, y);
    lut[i] = prev;
  }
  return lut;
}
const ptsIdentity = (p) => p.length === 0 || p.every(([x, y]) => Math.abs(x - y) < 1e-9);
function curveLuts(cv) {
  const parametric = cv.highlights !== 0 || cv.lights !== 0 || cv.darks !== 0 || cv.shadows !== 0;
  const master = !ptsIdentity(cv.master);
  const chans = [cv.r, cv.g, cv.b].map((p) => !ptsIdentity(p));
  if (!parametric && !master && !chans.some(Boolean)) return null;
  let base = parametricLut(cv);
  if (master) base = composeLut(curveToLut(monotoneCurve(cv.master), 1024), base);
  return [cv.r, cv.g, cv.b].map((p, i) => (chans[i] ? composeLut(curveToLut(monotoneCurve(p), 1024), base) : base));
}

// ---------------------------------------------------------------------------------------------
// Colour ops (colorops.rs)

const BAND_HUES = MIXER_HUES.map(oklchHueOfSrgbHue);
const BAND_SPANS = BAND_HUES.map((a, i) => remE(wrap(BAND_HUES[(i + 1) % 8] - a), TAU));
const SKIN_HUE = oklchHueOfSrgbHue(25);
/** Partition-of-unity band weights of OkLCh hue `h` (two non-zero neighbours) → band index and share of the next. */
function bandOf(h) {
  for (let i = 0; i < 8; i++) {
    const d = remE(wrap(h - BAND_HUES[i]), TAU);
    if (d <= BAND_SPANS[i]) return i + (0.5 - 0.5 * Math.cos((d / BAND_SPANS[i]) * PI));
  }
  return 0;
}

/** Calibration primaries matrix (white-preserving) or null. */
function calibrationMatrix(cal) {
  const prim = [[cal.redHue, cal.redSat], [cal.greenHue, cal.greenSat], [cal.blueHue, cal.blueSat]];
  if (prim.every(([h, s]) => h === 0 && s === 0)) return null;
  const p = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  prim.forEach(([hue, sat], i) => {
    const e = [0, 0, 0];
    e[i] = 1;
    const lab = oklabFrom2020(e);
    const ch = Math.hypot(lab[1], lab[2]);
    const h2 = Math.atan2(lab[2], lab[1]) + (hue / 100) * 0.5;
    const c2 = ch * (1 + (sat / 100) * 0.6);
    const q = oklabTo2020([lab[0], c2 * Math.cos(h2), c2 * Math.sin(h2)]);
    for (let r = 0; r < 3; r++) p[r][i] = q[r];
  });
  const inv = minv(p);
  if (!inv) return null;
  const k = mapply(inv, [1, 1, 1]);
  return p.map((row) => row.map((v, c) => v * k[c]));
}

// ---------------------------------------------------------------------------------------------
// Legacy clip.color sliders (gradeMath in src/lib/project.ts)

function legacyStage(color) {
  const cl = (v) => num(v, 0, -1, 1);
  const e = cl(color.exposure);
  const c = cl(color.contrast);
  const s = cl(color.saturation);
  const t = cl(color.temperature);
  if (Math.abs(e) < 1e-6 && Math.abs(c) < 1e-6 && Math.abs(s) < 1e-6 && Math.abs(t) < 1e-6) return null;
  const bright = 1 + e * 0.6;
  const warm = t > 0 ? [1, 1 - 0.08 * t, 1 - 0.24 * t] : [1 + 0.24 * t, 1 + 0.08 * t, 1];
  const sat = 1 + s;
  return {
    g: warm.map((w) => w * bright),
    k: 1 + c * 0.8,
    // CSS saturate() matrix (Rec.709 weights)
    m: [
      [0.2126 + 0.7874 * sat, 0.7152 - 0.7152 * sat, 0.0722 - 0.0722 * sat],
      [0.2126 - 0.2126 * sat, 0.7152 + 0.2848 * sat, 0.0722 - 0.0722 * sat],
      [0.2126 - 0.2126 * sat, 0.7152 - 0.7152 * sat, 0.0722 + 0.9278 * sat],
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// The compiled pipeline

const cl01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function compile(color) {
  const col = color && typeof color === 'object' ? color : {};
  const s = resolveLook(col.dev);
  const legacy = legacyStage(col);

  // input matrix: exposure · WB · (Rec.709 → Rec.2020), all linear
  const wb = wbFor(s.temp, s.tint);
  const gain = Math.pow(2, s.exposure);
  const mIn = mmul(diag(gain, gain, gain), wb ? mmul(wb, S2W) : S2W);
  const hl = s.highlights / 100;
  const sh = s.shadows / 100;
  const calib = calibrationMatrix(s.calibration);
  const shadowTint = s.calibration.shadowsTint / 100;
  const tone = displayTone(s.contrast, s.whites, s.blacks);

  // colour ops
  const lookId = s.look.id;
  const bw = s.bw || lookId === 'lc.mono' || lookId.startsWith('lc.bw.');
  const vib = s.vibrance / 100;
  const satu = s.saturation / 100;
  const mh = BANDS.map((b) => (s.hsl[b].h / 100) * 0.5);
  const ms = BANDS.map((b) => s.hsl[b].s / 100);
  const ml = BANDS.map((b) => (s.hsl[b].l / 100) * 0.18);
  const mixer = BANDS.some((b) => s.hsl[b].h !== 0 || s.hsl[b].s !== 0 || s.hsl[b].l !== 0);
  const bwm = BANDS.map((b) => s.bwMix[b] / 100);
  const grading = WHEELS.some((w) => s.wheels[w].sat !== 0 || s.wheels[w].lum !== 0);
  const wk = WHEELS.map((w) => {
    const h = oklchHueOfSrgbHue(s.wheels[w].hue);
    const sat = (s.wheels[w].sat / 100) * 0.09;
    return [sat * Math.cos(h), sat * Math.sin(h), (s.wheels[w].lum / 100) * 0.12];
  });
  const gm = 0.5 - (s.balance / 100) * 0.25;
  const gw = 0.15 + (s.blending / 100) * 0.5;
  const opsOn = vib !== 0 || satu !== 0 || mixer || bw || grading;

  const curves = curveLuts(s.curve);
  const refine = s.refineSat / 100;

  const identity =
    !legacy && !wb && gain === 1 && hl === 0 && sh === 0 && !calib && shadowTint === 0 && !tone && !opsOn && !curves;

  const [[a00, a01, a02], [a10, a11, a12], [a20, a21, a22]] = mIn;
  const [[o00, o01, o02], [o10, o11, o12], [o20, o21, o22]] = W2S;
  const [[k00, k01, k02], [k10, k11, k12], [k20, k21, k22]] = calib || IDENT;
  const [[l00, l01, l02], [l10, l11, l12], [l20, l21, l22]] = TO_LMS;
  const [[f00, f01, f02], [f10, f11, f12], [f20, f21, f22]] = FROM_LMS;
  const [[p00, p01, p02], [p10, p11, p12], [p20, p21, p22]] = LMS_TO_LAB;
  const [[q00, q01, q02], [q10, q11, q12], [q20, q21, q22]] = LAB_FROM_LMS;
  const [y0, y1, y2] = SRGB_LUMA;
  const [cR, cG, cB] = curves || [null, null, null];
  const LOG_MIN = Math.pow(2, LUT_MIN_EV) * GREY;

  /** Linear Rec.709 in → sRGB-encoded out (0..1) at out[o..o+2]. */
  function lin(r0, g0, b0, out, o) {
    let r = a00 * r0 + a01 * g0 + a02 * b0;
    let g = a10 * r0 + a11 * g0 + a12 * b0;
    let b = a20 * r0 + a21 * g0 + a22 * b0;

    // Highlights / Shadows (global: base = own log luminance after exposure)
    if (hl !== 0 || sh !== 0) {
      const base = Math.log2(Math.max(L20[0] * r + L20[1] * g + L20[2] * b, 1e-7) / GREY);
      const sw = 1 - smooth(-4.8, 0.3, base);
      const hw = smooth(-1, 2.8, base);
      const delta = sh * 1.7 * sw * Math.sqrt(sw) + hl * 1.7 * hw;
      if (delta !== 0) {
        const k = Math.pow(2, delta);
        r *= k;
        g *= k;
        b *= k;
      }
    }

    // calibration (scene linear)
    if (calib) {
      const r1 = Math.max(0, k00 * r + k01 * g + k02 * b);
      const g1 = Math.max(0, k10 * r + k11 * g + k12 * b);
      const b1 = Math.max(0, k20 * r + k21 * g + k22 * b);
      r = r1;
      g = g1;
      b = b1;
    }
    if (shadowTint !== 0) {
      const ya = L20[0] * r + L20[1] * g + L20[2] * b;
      const w = 1 - smooth(-5, -0.5, Math.log2(Math.max(ya, 1e-7) / 0.18));
      g *= Math.max(0, 1 - 0.3 * shadowTint * w);
      const yb = Math.max(L20[0] * r + L20[1] * g + L20[2] * b, 1e-9);
      const k = ya / yb;
      r *= k;
      g *= k;
      b *= k;
    }

    // tone map on luminance (ratio kept), then highlight desaturation above white
    const yl = L20[0] * r + L20[1] * g + L20[2] * b;
    let ot;
    if (yl <= 0) ot = 0;
    else if (!tone) ot = yl < 1 ? yl : 1;
    else {
      const ev = Math.log2(yl / GREY);
      let f = (ev - LUT_MIN_EV) / (LUT_MAX_EV - LUT_MIN_EV);
      f = (f < 0 ? 0 : f > 1 ? 1 : f) * (LUT_N - 1);
      let i = f | 0;
      if (i > LUT_N - 2) i = LUT_N - 2;
      ot = tone[i] + (tone[i + 1] - tone[i]) * (f - i);
      if (ev < LUT_MIN_EV) ot *= yl / LOG_MIN;
    }
    if (yl > 1e-9) {
      if (ot !== yl) {
        const k = ot / yl;
        r *= k;
        g *= k;
        b *= k;
      }
    } else {
      r = 0;
      g = 0;
      b = 0;
    }
    const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
    if (mx > 1) {
      let t = (mx - 1) / Math.max(mx - ot, 1e-6);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      r += (ot - r) * t;
      g += (ot - g) * t;
      b += (ot - b) * t;
    }

    // colour in OkLab / OkLCh
    if (opsOn) {
      const lm = Math.cbrt(l00 * r + l01 * g + l02 * b);
      const mm = Math.cbrt(l10 * r + l11 * g + l12 * b);
      const sm = Math.cbrt(l20 * r + l21 * g + l22 * b);
      let L = p00 * lm + p01 * mm + p02 * sm;
      let A = p10 * lm + p11 * mm + p12 * sm;
      let B = p20 * lm + p21 * mm + p22 * sm;
      const c0 = Math.sqrt(A * A + B * B);
      let c = c0;
      if (!mixer && !bw) {
        if (vib !== 0) {
          const low = 1 - Math.min(Math.max(c / 0.22, 0), 1);
          const skin = vib > 0 ? 1 - 0.6 * Math.exp(-((wrap(Math.atan2(B, A) - SKIN_HUE) / 0.35) ** 2)) : 1;
          c *= Math.max(1 + vib * low * low * skin * 1.2, 0);
        }
        if (satu !== 0) c *= Math.max(1 + satu, 0);
        if (c0 > 0) {
          const k = c / c0;
          A *= k;
          B *= k;
        }
      } else {
        let h = Math.atan2(B, A);
        if (mixer) {
          const bi = bandOf(h);
          const i = bi | 0;
          const t = bi - i;
          const j = (i + 1) % 8;
          const dh = mh[i] * (1 - t) + mh[j] * t;
          const ds = ms[i] * (1 - t) + ms[j] * t;
          const dl = ml[i] * (1 - t) + ml[j] * t;
          const cw = Math.min(c / 0.12, 1);
          h += dh * cw;
          c *= Math.max(1 + ds, 0);
          L += dl * cw * Math.sqrt(Math.max(L, 0.05));
        }
        if (vib !== 0) {
          const low = 1 - Math.min(Math.max(c / 0.22, 0), 1);
          const skin = vib > 0 ? 1 - 0.6 * Math.exp(-((wrap(h - SKIN_HUE) / 0.35) ** 2)) : 1;
          c *= Math.max(1 + vib * low * low * skin * 1.2, 0);
        }
        if (satu !== 0) c *= Math.max(1 + satu, 0);
        if (bw) {
          const bi = bandOf(h);
          const i = bi | 0;
          const t = bi - i;
          const mix = bwm[i] * (1 - t) + bwm[(i + 1) % 8] * t;
          L = Math.max(L + mix * Math.min(c / 0.2, 1) * 0.25, 0);
          c = 0;
        }
        A = c * Math.cos(h);
        B = c * Math.sin(h);
      }
      if (grading) {
        const ws = 1 - smooth(gm - gw, gm + gw * 0.25, L);
        const wh = smooth(gm - gw * 0.25, gm + gw, L);
        const wm = Math.max(1 - ws - wh, 0);
        A += wk[0][0] * ws + wk[1][0] * wm + wk[2][0] * wh + wk[3][0];
        B += wk[0][1] * ws + wk[1][1] * wm + wk[2][1] * wh + wk[3][1];
        L += wk[0][2] * ws + wk[1][2] * wm + wk[2][2] * wh + wk[3][2];
      }
      let x = q00 * L + q01 * A + q02 * B;
      let y = q10 * L + q11 * A + q12 * B;
      let z = q20 * L + q21 * A + q22 * B;
      x = x * x * x;
      y = y * y * y;
      z = z * z * z;
      r = f00 * x + f01 * y + f02 * z;
      g = f10 * x + f11 * y + f12 * z;
      b = f20 * x + f21 * y + f22 * z;
    }

    // gamut map into sRGB (desaturate towards luminance until 0..1)
    let R = o00 * r + o01 * g + o02 * b;
    let G = o10 * r + o11 * g + o12 * b;
    let Bc = o20 * r + o21 * g + o22 * b;
    let yy = y0 * R + y1 * G + y2 * Bc;
    yy = yy < 0 ? 0 : yy > 1 ? 1 : yy;
    let t = 1;
    if (R < 0) t = Math.min(t, yy / Math.max(yy - R, 1e-9));
    else if (R > 1) t = Math.min(t, (1 - yy) / Math.max(R - yy, 1e-9));
    if (G < 0) t = Math.min(t, yy / Math.max(yy - G, 1e-9));
    else if (G > 1) t = Math.min(t, (1 - yy) / Math.max(G - yy, 1e-9));
    if (Bc < 0) t = Math.min(t, yy / Math.max(yy - Bc, 1e-9));
    else if (Bc > 1) t = Math.min(t, (1 - yy) / Math.max(Bc - yy, 1e-9));
    if (t < 1) {
      R = yy + (R - yy) * t;
      G = yy + (G - yy) * t;
      Bc = yy + (Bc - yy) * t;
    }

    // encode, curves, refine saturation
    let er = linearToSrgb(cl01(R));
    let eg = linearToSrgb(cl01(G));
    let eb = linearToSrgb(cl01(Bc));
    if (cR) {
      const r0e = er;
      const g0e = eg;
      const b0e = eb;
      er = lutEval(cR, er);
      eg = lutEval(cG, eg);
      eb = lutEval(cB, eb);
      if (refine < 1) {
        const ya = 0.2126 * r0e + 0.7152 * g0e + 0.0722 * b0e;
        const yb = 0.2126 * er + 0.7152 * eg + 0.0722 * eb;
        const s0 = (Math.max(r0e, g0e, b0e) - Math.min(r0e, g0e, b0e)) / Math.max(ya, 1e-4);
        const s1 = (Math.max(er, eg, eb) - Math.min(er, eg, eb)) / Math.max(yb, 1e-4);
        if (s1 > 1e-6 && s0 > 1e-6) {
          const k = Math.max(0, Math.min(4, Math.pow(s0 / s1, 1 - refine)));
          er = yb + (er - yb) * k;
          eg = yb + (eg - yb) * k;
          eb = yb + (eb - yb) * k;
        }
      }
    }
    out[o] = cl01(er);
    out[o + 1] = cl01(eg);
    out[o + 2] = cl01(eb);
  }

  const lg = legacy;
  /** sRGB-encoded in → encoded out. */
  function pixel(r, g, b, out, o) {
    if (lg) {
      r = cl01(r * lg.g[0]);
      g = cl01(g * lg.g[1]);
      b = cl01(b * lg.g[2]);
      r = cl01((r - 0.5) * lg.k + 0.5);
      g = cl01((g - 0.5) * lg.k + 0.5);
      b = cl01((b - 0.5) * lg.k + 0.5);
      const m = lg.m;
      const r1 = cl01(m[0][0] * r + m[0][1] * g + m[0][2] * b);
      const g1 = cl01(m[1][0] * r + m[1][1] * g + m[1][2] * b);
      const b1 = cl01(m[2][0] * r + m[2][1] * g + m[2][2] * b);
      r = r1;
      g = g1;
      b = b1;
    }
    lin(srgbToLinear(cl01(r)), srgbToLinear(cl01(g)), srgbToLinear(cl01(b)), out, o);
  }

  return { identity, legacy: Boolean(lg), lin, pixel, settings: s };
}

/** `(r, g, b) => [r, g, b]`, sRGB-encoded 0..1 in and out: the clip colour of `color` (Grade with optional `dev`). */
export function makePixelFn(color) {
  const P = compile(color);
  const out = new Float64Array(3);
  return (r, g, b) => {
    P.pixel(r, g, b, out, 0);
    return [out[0], out[1], out[2]];
  };
}

/** True when `color` (legacy sliders + dev) changes no pixel (vignette and lut not considered). */
export function isIdentityDev(color) {
  return compile(color).identity;
}

// ---------------------------------------------------------------------------------------------
// 3D LUTs (.cube: red fastest)

function sampleCube(lut, r, g, b, out, o) {
  const { N, data } = lut;
  const lo = lut.domainMin || [0, 0, 0];
  const hi = lut.domainMax || [1, 1, 1];
  const n1 = N - 1;
  const fr = cl01((r - lo[0]) / (hi[0] - lo[0] || 1)) * n1;
  const fg = cl01((g - lo[1]) / (hi[1] - lo[1] || 1)) * n1;
  const fb = cl01((b - lo[2]) / (hi[2] - lo[2] || 1)) * n1;
  let ir = fr | 0;
  let ig = fg | 0;
  let ib = fb | 0;
  if (ir > n1 - 1) ir = Math.max(n1 - 1, 0);
  if (ig > n1 - 1) ig = Math.max(n1 - 1, 0);
  if (ib > n1 - 1) ib = Math.max(n1 - 1, 0);
  const tr = fr - ir;
  const tg = fg - ig;
  const tb = fb - ib;
  const sR = N > 1 ? 3 : 0;
  const sG = N > 1 ? 3 * N : 0;
  const sB = N > 1 ? 3 * N * N : 0;
  const i000 = 3 * ((ib * N + ig) * N + ir);
  for (let c = 0; c < 3; c++) {
    const p = i000 + c;
    const c00 = data[p] + (data[p + sR] - data[p]) * tr;
    const c10 = data[p + sG] + (data[p + sG + sR] - data[p + sG]) * tr;
    const c01 = data[p + sB] + (data[p + sB + sR] - data[p + sB]) * tr;
    const c11 = data[p + sB + sG] + (data[p + sB + sG + sR] - data[p + sB + sG]) * tr;
    const c0 = c00 + (c10 - c00) * tg;
    const c1 = c01 + (c11 - c01) * tg;
    out[o + c] = c0 + (c1 - c0) * tb;
  }
}

/**
 * The clip colour as an N×N×N LUT (Float32Array, N³·3, .cube order: red fastest), sRGB-encoded in
 * and out. A user .cube ({ N, data, domainMin?, domainMax? } from parseCube) is applied after the
 * develop function (trilinear), so both end up in one table.
 */
export function bakeLut(color, N = 33, userLut) {
  const n = Math.max(2, Math.min(256, Math.floor(N) || 33));
  const P = compile(color);
  const data = new Float32Array(n * n * n * 3);
  const grid = new Float64Array(n);
  const gridLin = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    grid[i] = i / (n - 1);
    gridLin[i] = srgbToLinear(grid[i]);
  }
  const tmp = new Float64Array(3);
  let o = 0;
  for (let ib = 0; ib < n; ib++) {
    for (let ig = 0; ig < n; ig++) {
      for (let ir = 0; ir < n; ir++, o += 3) {
        if (P.identity) {
          tmp[0] = grid[ir];
          tmp[1] = grid[ig];
          tmp[2] = grid[ib];
        } else if (P.legacy) P.pixel(grid[ir], grid[ig], grid[ib], tmp, 0);
        else P.lin(gridLin[ir], gridLin[ig], gridLin[ib], tmp, 0);
        if (userLut) sampleCube(userLut, tmp[0], tmp[1], tmp[2], tmp, 0);
        data[o] = tmp[0];
        data[o + 1] = tmp[1];
        data[o + 2] = tmp[2];
      }
    }
  }
  return data;
}

/** A .cube file for an N³ LUT (red fastest). */
export function toCube(data, N, title = 'Cinemex') {
  const lines = [`TITLE "${String(title).replace(/["\r\n]/g, ' ')}"`, `LUT_3D_SIZE ${N}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  const f = (v) => (Number.isFinite(v) ? v : 0).toFixed(6);
  for (let i = 0; i < N * N * N * 3; i += 3) lines.push(`${f(data[i])} ${f(data[i + 1])} ${f(data[i + 2])}`);
  return lines.join('\n') + '\n';
}

/** Parse a 3D .cube (Adobe/Resolve). Throws on 1D LUTs and malformed files. */
export function parseCube(text) {
  let N = 0;
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  const vals = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const head = line.split(/\s+/)[0].toUpperCase();
    if (head === 'TITLE') continue;
    if (head === 'LUT_1D_SIZE' || head === 'LUT_1D_INPUT_RANGE') throw new Error('LUT 1D (.cube com LUT_1D_SIZE) não é suportado: usa um LUT 3D.');
    const parts = line.split(/\s+/).slice(1).map(Number);
    if (head === 'LUT_3D_SIZE') {
      N = parts[0];
      if (!Number.isInteger(N) || N < 2 || N > 256) throw new Error(`LUT_3D_SIZE inválido: ${line}`);
      continue;
    }
    if (head === 'DOMAIN_MIN' || head === 'DOMAIN_MAX') {
      if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) throw new Error(`${head} inválido: ${line}`);
      if (head === 'DOMAIN_MIN') domainMin = parts;
      else domainMax = parts;
      continue;
    }
    if (head === 'LUT_3D_INPUT_RANGE') {
      if (parts.length !== 2 || parts.some((v) => !Number.isFinite(v))) throw new Error(`LUT_3D_INPUT_RANGE inválido: ${line}`);
      domainMin = [parts[0], parts[0], parts[0]];
      domainMax = [parts[1], parts[1], parts[1]];
      continue;
    }
    if (/^[A-Z_]+$/.test(head)) continue; // other keywords
    const v = line.split(/\s+/).map(Number);
    if (v.length !== 3 || v.some((x) => !Number.isFinite(x))) throw new Error(`Linha inválida no .cube: ${line}`);
    vals.push(v[0], v[1], v[2]);
  }
  if (!N) throw new Error('.cube sem LUT_3D_SIZE (não é um LUT 3D).');
  if (vals.length !== N * N * N * 3) throw new Error(`.cube com ${vals.length / 3} entradas, esperava ${N * N * N}.`);
  return { N, data: Float32Array.from(vals), domainMin, domainMax };
}

// ---------------------------------------------------------------------------------------------
// Auto (pipeline/src/auto.rs), on an 8-bit RGBA frame (sRGB / Rec.709)

const DECODE8 = Float64Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));

/** Box-downscaled proxy (long edge ≤ maxSide) in linear Rec.2020: [r, g, b, r, g, b, ...]. */
function proxy2020(rgba, w, h, maxSide) {
  const step = Math.max(1, Math.ceil(Math.max(w, h) / maxSide));
  const pw = Math.ceil(w / step);
  const ph = Math.ceil(h / step);
  const out = new Float64Array(pw * ph * 3);
  const [[a00, a01, a02], [a10, a11, a12], [a20, a21, a22]] = S2W;
  for (let py = 0; py < ph; py++) {
    for (let px = 0; px < pw; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = py * step; y < Math.min(h, (py + 1) * step); y++) {
        for (let x = px * step; x < Math.min(w, (px + 1) * step); x++) {
          const i = (y * w + x) * 4;
          r += DECODE8[rgba[i]];
          g += DECODE8[rgba[i + 1]];
          b += DECODE8[rgba[i + 2]];
          n++;
        }
      }
      const o = (py * pw + px) * 3;
      r /= n;
      g /= n;
      b /= n;
      out[o] = a00 * r + a01 * g + a02 * b;
      out[o + 1] = a10 * r + a11 * g + a12 * b;
      out[o + 2] = a20 * r + a21 * g + a22 * b;
    }
  }
  return out;
}

/**
 * Auto tone (auto.rs auto_tone). Exposure follows the frame's log-average luminance exactly as
 * LightCraft does (−0.58 − 0.41·mean EV, −2..3, under the current white balance of `dev`). The rest
 * of LightCraft's recipe (Contrast 68, Highlights −66, Shadows +52, Vibrance 30) was fitted for raw
 * files on a flatter base curve with *spatial* Highlights/Shadows; for already-toned video with the
 * global Highlights/Shadows of this port it is retuned to Lightroom's own Auto averages scaled down:
 * Contrast +8, Highlights −33, Shadows +26, Vibrance +10 (Whites, Blacks, Saturation 0 as in LightCraft).
 */
export function autoTone(rgba, w, h, dev) {
  const px = proxy2020(rgba, w, h, 512);
  const s = cleanDev(dev);
  const wb = wbFor(s.temp, s.tint) || IDENT;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 3) {
    const c = mapply(wb, [px[i], px[i + 1], px[i + 2]]);
    const ev = Math.log2(Math.max(L20[0] * c[0] + L20[1] * c[1] + L20[2] * c[2], 1e-6) / GREY);
    if (Number.isFinite(ev)) {
      sum += ev;
      n++;
    }
  }
  const exposure = n > 0 ? Math.max(-2, Math.min(3, -0.58 - 0.41 * (sum / n))) : 0;
  return { exposure: Math.round(exposure * 100) / 100, contrast: 8, highlights: -33, shadows: 26, whites: 0, blacks: 0, vibrance: 10, saturation: 0 };
}

/** Auto white balance (auto.rs auto_wb): grey world weighted to mid-tone, low-chroma pixels → { temp, tint }. */
export function autoWhiteBalance(rgba, w, h) {
  const px = proxy2020(rgba, w, h, 256);
  const acc = [0, 0, 0];
  let wsum = 0;
  for (let i = 0; i < px.length; i += 3) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const y = L20[0] * r + L20[1] * g + L20[2] * b;
    if (!(y >= 0.01 && y <= 2)) continue;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const chroma = (mx - mn) / (mx + 1e-6);
    const wt = (1 - chroma) ** 2 * (1 - Math.min(Math.abs((Math.log2(y) + 2.5) / 4), 1));
    acc[0] += r * wt;
    acc[1] += g * wt;
    acc[2] += b * wt;
    wsum += wt;
  }
  if (wsum <= 0) return { temp: 6500, tint: 0 };
  const avg = acc.map((v) => v / wsum);
  const seen = xyFromXyz(mapply(bradford(D65, tempTintToXy(6500, 0)), mapply(X2020, avg)));
  const [t, tint] = xyToTempTint(seen);
  return { temp: Math.round(Math.max(2000, Math.min(50000, t))), tint: Math.round(Math.max(-150, Math.min(150, tint))) };
}
