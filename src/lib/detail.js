// "Detalhe": LightCraft's spatial develop tools, kept outside the colour LUT (they look at
// neighbouring pixels). Formulas: docs/engenharia-reversa/lightcraft.md §3.4–3.6 and §3.15
// (LightCraft pipeline/src/finish.rs local_tone_delta, adjust_scene_pixel, grain_noise).
//
//   localHighlights / localShadows  −100..100  guided-filter base of log luminance (σ 1.5 % long edge)
//   clarity                         −100..100  guided-filter blur (σ 1.2 %), midtone weighted
//   texture                         −100..100  Gaussian σ = max(0.18 % long, 0.6 px)
//   sharpen {amount 0–150, radius 0.5–3, detail 0–100, masking 0–100}   pixel-scale band (process V3+)
//   dehaze                          −100..100  dark channel (min RGB, σ 2 %), airlight fixed per clip (dehazeAir)
//   grain {amount 0–100, size 0–100, roughness 0–100}                   value noise, after the LUT
//
// Every local-contrast tool is a luminance gain in stops (rgb_linear *= 2^delta), so colours do not shift.
// Spatial sizes are fractions of the long edge, so the preview (≤1280 px) and the export look alike.
//
// Simplifications vs LightCraft (identical in preview and export):
//   - works on the decoded sRGB video frame before the grade LUT, not on scene-linear Rec.2020 after WB/exposure;
//   - log luminance = log2(lin(Rec.709 luma of the encoded pixel) / 0.18), clamped to −10..4 EV;
//   - no V2 median prefilter before the base; guided filters use ffmpeg's box ("fast", subsampled) form;
//   - grain is added per channel (weight uses the channel, not the pixel luma), after the whole LUT;
//   - the export grain plate is ffmpeg `noise` upscaled bicubically (same cell size and amplitude, not the same pattern).
//
// Three forms that must agree: js (reference, tests), glsl (src/engine/gldetail.ts), ff (render.cjs ffmpeg graph).

const clampN = (v, lo, hi, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
};
const fx = (n) => String(Math.round(n * 1e6) / 1e6);

/** Log-luminance encoding of the guided-filter planes (ffmpeg's `guided` only takes integer planes). */
export const L_MIN = -10;
export const L_SPAN = 14;
export const GREY = 0.18;
export const AIR_DEFAULT = 0.85;

export const SHARPEN_DEFAULT = Object.freeze({ amount: 0, radius: 1, detail: 25, masking: 0 });
export const GRAIN_DEFAULT = Object.freeze({ amount: 0, size: 25, roughness: 50 });

/** The detail fields of clip.color.dev, clamped (zeros when absent). */
export function cleanDetail(dev) {
  const d = dev && typeof dev === 'object' ? dev : {};
  const sp = d.sharpen && typeof d.sharpen === 'object' ? d.sharpen : {};
  const gr = d.grain && typeof d.grain === 'object' ? d.grain : {};
  return {
    hl: clampN(d.localHighlights, -100, 100),
    sh: clampN(d.localShadows, -100, 100),
    clarity: clampN(d.clarity, -100, 100),
    texture: clampN(d.texture, -100, 100),
    sharpen: {
      amount: clampN(sp.amount, 0, 150),
      radius: clampN(sp.radius, 0.5, 3, SHARPEN_DEFAULT.radius),
      detail: clampN(sp.detail, 0, 100, SHARPEN_DEFAULT.detail),
      masking: clampN(sp.masking, 0, 100, SHARPEN_DEFAULT.masking),
    },
    dehaze: clampN(d.dehaze, -100, 100),
    air: clampN(d.dehazeAir, 0.05, 1, AIR_DEFAULT),
    grain: {
      amount: clampN(gr.amount, 0, 100),
      size: clampN(gr.size, 0, 100, GRAIN_DEFAULT.size),
      roughness: clampN(gr.roughness, 0, 100, GRAIN_DEFAULT.roughness),
    },
  };
}

const devOf = (color) => (color && typeof color === 'object' && 'dev' in color ? color.dev : color);

/** True when a spatial tool before the LUT is on (local tone, clarity, texture, sharpening, dehaze). */
export function hasDetail(color) {
  const c = cleanDetail(devOf(color));
  return c.hl !== 0 || c.sh !== 0 || c.clarity !== 0 || c.texture !== 0 || c.sharpen.amount > 0 || c.dehaze !== 0;
}
/** True when film grain is on (applied after the LUT). */
export function hasGrain(color) {
  return cleanDetail(devOf(color)).grain.amount > 0;
}

/** Box radius and subsampling of the fast guided filter for a Gaussian-like σ in pixels (same in ffmpeg and WebGL). */
export function guidedSize(sigma) {
  const R = Math.max(1, sigma * 1.7);
  const sub = Math.max(2, Math.min(64, Math.ceil(R / 12)));
  return { sub, r: Math.max(1, Math.min(20, Math.round(R / sub))) };
}

/**
 * Everything in pixels and engine units for a frame whose long edge is `long` px.
 * hs/clar: guided filters (eps in encoded units), tex/sharp/dark: Gaussian σ, grain: cell px.
 */
export function detailParams(color, long) {
  const c = cleanDetail(devOf(color));
  const L = Math.max(16, Number(long) || 1920);
  const e2 = L_SPAN * L_SPAN;
  const sp = c.sharpen;
  return {
    hl: c.hl / 100,
    sh: c.sh / 100,
    hs: { ...guidedSize(0.015 * L), eps: 0.35 / e2 },
    clar: c.clarity / 100,
    clarG: { ...guidedSize(0.012 * L), eps: 0.8 / e2 },
    tex: c.texture / 100,
    texSigma: Math.max(0.0018 * L, 0.6),
    sharp: sp.amount / 150,
    sharpSigma: Math.max(0.5, (sp.radius * L) / 1920),
    sharpLimit: 0.03 * Math.pow(50, sp.detail / 100),
    sharpMask: sp.masking / 100,
    dehaze: c.dehaze / 100,
    air: c.air,
    darkSigma: 0.02 * L,
    grain: c.grain.amount / 100 * 0.13,
    grainCell: Math.max((0.0006 + 0.0024 * (c.grain.size / 100)) * L, 0.6),
    grainRough: c.grain.roughness / 100,
  };
}

// ---------------------------------------------------------------------------------------------
// JS reference (tests and docs). Values: encoded sRGB 0..1 per channel, L in stops.

export const smooth = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
export const lin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
export const enc = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
export const encL = (L) => Math.max(0, Math.min(1, (L - L_MIN) / L_SPAN));
export const decL = (e) => e * L_SPAN + L_MIN;
export const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
/** Encoded log luminance of an encoded pixel. */
export const logLumEnc = (r, g, b) => encL(Math.log2(Math.max(lin(luma(r, g, b)), 1e-7) / GREY));

/** Highlights/shadows gain (stops) from the base (stops). */
export function hsDelta(base, hl, sh) {
  const sw = 1 - smooth(-4.8, 0.3, base);
  const hw = smooth(-1.0, 2.8, base);
  return sh * 1.7 * sw * Math.sqrt(sw) + hl * 1.7 * hw;
}
/** Clarity term; d = L − clarity blur (stops), base in stops. */
export const clarityDelta = (d, base, clar) => clar * 0.85 * Math.max(-2.5, Math.min(2.5, d)) * (0.35 + 0.65 * Math.exp(-((base / 3.2) ** 2)));
/** Texture term; d = L − texture blur. */
export const textureDelta = (d, tex) => tex * 1.1 * Math.max(-1, Math.min(1, d)) * (1 - 0.6 * smooth(0.4, 1.6, Math.abs(d)));
/** Sharpening term (LightCraft V3 sharpen_term, gain 7). */
export function sharpenDelta(d, sharp, limit, mask) {
  const m = mask > 0 ? smooth(mask * 0.1, mask * 0.1 + 0.06, Math.abs(d)) : 1;
  return sharp * 7 * m * d / (1 + Math.abs(d) / limit);
}
/** Gain in stops on one encoded channel. */
export const applyGain = (c, delta) => Math.max(0, Math.min(1, enc(lin(c) * Math.pow(2, delta))));
/** Veil 0..1 from the blurred dark channel and the pixel's own minimum channel (both linear). */
export const veilOf = (dark, minc, air) => Math.max(0, Math.min(1, Math.min(dark, minc) / air));
/** Dehaze on one encoded channel. */
export function dehazeJS(c, veil, d, air) {
  const v = lin(c);
  if (d > 0) {
    const t = Math.max(1 - 0.95 * Math.min(d, 1) * veil, 0.12);
    return Math.max(0, Math.min(1, enc(Math.max((v - air * (1 - t)) / t, 0))));
  }
  const k = Math.min(-d, 1) * 0.7 * (0.35 + 0.65 * veil);
  return Math.max(0, Math.min(1, enc(v + (air * 0.9 - v) * k)));
}
/** Grain on one encoded channel; n = noise value −1..1. */
export const grainJS = (c, n, amt) => Math.max(0, Math.min(1, c + amt * n * (0.35 + 2.6 * c * (1 - c))));

/** Airlight (linear) of a frame: 99.5th percentile of the blurred dark channel (LightCraft local.rs airlight), from RGBA bytes. */
export function estimateAirlight(rgba, w, h) {
  if (!rgba || !w || !h) return AIR_DEFAULT;
  const dark = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) dark[i] = lin(Math.min(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) / 255);
  // small box blur (σ ≈ 2 % of the long edge)
  const r = Math.max(1, Math.round(0.02 * Math.max(w, h)));
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let i = -r; i <= r; i++) { const xx = x + i; if (xx >= 0 && xx < w) { s += dark[y * w + xx]; n++; } }
    tmp[y * w + x] = s / n;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let j = -r; j <= r; j++) { const yy = y + j; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; n++; } }
    out[y * w + x] = s / n;
  }
  const samples = [];
  for (let i = 0; i < out.length; i += 7) samples.push(out[i]);
  samples.sort((a, b) => a - b);
  const a = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.995))] ?? AIR_DEFAULT;
  return Math.max(0.05, Math.min(1, Math.round(a * 1000) / 1000));
}

// ---------------------------------------------------------------------------------------------
// ffmpeg. Every plane is an integer plane (gbrp16le / gray16le; grain: gbrp / gray), because
// swscale treats float grey as limited range and stretches it when converting. Planes that hold
// signed values are encoded into 0..1 (below), and grey planes become RGB with mergeplanes (exact).

/** Encoded gain in stops (delta planes). */
export const D_MIN = -8;
export const D_SPAN = 16;
export const encD = (d) => Math.max(0, Math.min(1, (d - D_MIN) / D_SPAN));
export const decD = (e) => e * D_SPAN + D_MIN;
/** Encoded clarity detail (stops, ±2.5). */
export const encCD = (d) => Math.max(0, Math.min(1, (d + 2.5) / 5));
export const decCD = (e) => e * 5 - 2.5;
/** Encoded grain value (−1.5..1.5). */
export const encN = (v) => Math.max(0, Math.min(1, (v + 1.5) / 3));
export const decN = (e) => e * 3 - 1.5;

const LN2 = '0.6931471805599453';
const ffLin = (x) => `if(lte(${x},0.04045),${x}/12.92,pow((${x}+0.055)/1.055,2.4))`;
const ffEnc = (x) => `if(lte(${x},0.0031308),${x}*12.92,1.055*pow(${x},1/2.4)-0.055)`;
/** smoothstep with slot k for t. */
const ffSmooth = (e0, e1, x, k) => `(st(${k},clip((${x}-(${fx(e0)}))/${fx(e1 - e0)},0,1));ld(${k})*ld(${k})*(3-2*ld(${k})))`;
const a = 'ld(8)';
const b = 'ld(9)';
/** Wraps a body written on a = A/S, b = B/S (0..1) into an integer-plane expression. */
const wrap = (body, S) => `st(8,A/${S});st(9,B/${S});${S}*clip(${body},0,1)`;
const eD = (x) => `((${x})-(${D_MIN}))/${D_SPAN}`;
const dD = (x) => `(${x}*${D_SPAN}+(${D_MIN}))`;

/** Bodies of every blend step on normalised a, b (exported for the tests; wrap16 / wrap8 make the expression). */
export const FF = {
  /** a = luma (encoded) -> encoded log luminance. */
  logLum: `st(0,${ffLin(a)});(log(max(ld(0),1e-7)/${GREY})/${LN2}-(${L_MIN}))/${L_SPAN}`,
  /** a = Lenc, b = clarity blur -> encoded clarity detail. */
  clarityDetail: `(clip((${a}-${b})*${L_SPAN},-2.5,2.5)+2.5)/5`,
  /** a = base (Lenc), b = encoded clarity detail -> encoded delta (highlights/shadows + clarity). */
  hsClar: (hl, sh, clar) =>
    `st(1,${a}*${L_SPAN}+(${L_MIN}));st(2,1-${ffSmooth(-4.8, 0.3, 'ld(1)', 3)});st(4,${ffSmooth(-1.0, 2.8, 'ld(1)', 5)});` +
    eD(`${fx(sh)}*1.7*ld(2)*sqrt(ld(2))+${fx(hl)}*1.7*ld(4)+${fx(clar)}*0.85*(${b}*5-2.5)*(0.35+0.65*exp(-pow(ld(1)/3.2,2)))`),
  /** a = Lenc, b = texture blur -> encoded delta. */
  texture: (tex) => `st(1,(${a}-${b})*${L_SPAN});` + eD(`${fx(tex)}*1.1*clip(ld(1),-1,1)*(1-0.6*${ffSmooth(0.4, 1.6, 'abs(ld(1))', 2)})`),
  /** a = Lenc, b = sharpen blur -> encoded delta. */
  sharpen: (sharp, limit, mask) =>
    `st(1,(${a}-${b})*${L_SPAN});` + eD(`${fx(sharp)}*7*${mask > 0 ? ffSmooth(mask * 0.1, mask * 0.1 + 0.06, 'abs(ld(1))', 2) : '1'}*ld(1)/(1+abs(ld(1))/${fx(limit)})`),
  /** Sum of two encoded deltas. */
  add: eD(`${dD(a)}+${dD(b)}`),
  /** a = channel (encoded), b = encoded delta. */
  gain: `st(0,${ffLin(a)}*pow(2,${dD(b)}));${ffEnc('ld(0)')}`,
  /** a, b = encoded channels -> min. */
  min: `min(${a},${b})`,
  /** a, b = encoded channels -> linear min. */
  linMin: `st(0,min(${a},${b}));${ffLin('ld(0)')}`,
  /** a = blurred dark channel, b = min channel (both linear) -> veil. */
  veil: (air) => `min(${a},${b})/${fx(air)}`,
  /** a = channel (encoded), b = veil. */
  dehaze: (d, air) =>
    d > 0
      ? `st(0,${ffLin(a)});st(1,max(1-${fx(0.95 * Math.min(d, 1))}*${b},0.12));${ffEnc(`max((ld(0)-${fx(air)}*(1-ld(1)))/ld(1),0)`)}`
      : `st(0,${ffLin(a)});st(1,${fx(Math.min(-d, 1) * 0.7)}*(0.35+0.65*${b}));${ffEnc(`ld(0)+(${fx(air * 0.9)}-ld(0))*ld(1)`)}`,
  /** a, b = two 8-bit noise octaves (ffmpeg noise alls=100 on grey 128: uniform 128 ± 50) -> encoded grain value. */
  octaves: (rough) => `(((${a}*255-128)/50)*${fx(1 - 0.5 * rough)}+((${b}*255-128)/50)*${fx(0.7 * rough)}+1.5)/3`,
  /** a = channel (encoded), b = encoded grain value. */
  grain: (amt) => `${a}+${fx(amt)}*(${b}*3-1.5)*(0.35+2.6*${a}*(1-${a}))`,
};
export const wrap16 = (body) => wrap(body, 65535);
export const wrap8 = (body) => wrap(body, 255);

const blend16 = (body) => `blend=all_expr='${wrap16(body)}'`;
/** Gaussian blur (σ px). */
const gblur = (s) => `gblur=sigma=${fx(Math.max(0.3, s))}:steps=2`;
/** Fast guided filter of an encoded 16-bit plane. */
const guided = (g) => `guided=radius=${g.r}:eps=${fx(g.eps)}:mode=fast:sub=${g.sub}`;
/** A grey plane as RGB (all three planes the same). */
function toRgb(filters, label, out, fmt) {
  filters.push(`[${label}]split=3[${out}a][${out}b][${out}c]`);
  filters.push(`[${out}a][${out}b][${out}c]mergeplanes=0x001020:${fmt}[${out}]`);
}

/**
 * ffmpeg graph of the spatial tools before the LUT. Appends to `filters`, reads label `input`
 * (any format, framed W×H), returns the label of the result (gbrp16le). ctx: { W, H }.
 */
export function detailFilters(filters, color, input, tag, { W, H }) {
  const p = detailParams(color, Math.max(W, H));
  const L = (s) => `dt${tag}_${s}`;
  let rgb = L('rgb');
  filters.push(`[${input}]format=gbrp16le[${rgb}]`);
  if (p.dehaze !== 0) {
    filters.push(`[${rgb}]split=2[${L('dm')}][${L('dp')}]`);
    filters.push(`[${L('dp')}]extractplanes=r+g+b[${L('r')}][${L('g')}][${L('b')}]`);
    filters.push(`[${L('r')}][${L('g')}]${blend16(FF.min)}[${L('rg')}]`);
    filters.push(`[${L('rg')}][${L('b')}]${blend16(FF.linMin)},split=2[${L('mn1')}][${L('mn2')}]`);
    filters.push(`[${L('mn1')}]${gblur(p.darkSigma)}[${L('dk')}]`);
    filters.push(`[${L('dk')}][${L('mn2')}]${blend16(FF.veil(p.air))}[${L('vg')}]`);
    toRgb(filters, L('vg'), L('vl'), 'gbrp16le');
    filters.push(`[${L('dm')}][${L('vl')}]${blend16(FF.dehaze(p.dehaze, p.air))}[${L('dh')}]`);
    rgb = L('dh');
  }
  const terms = [];
  const hsOn = p.hl !== 0 || p.sh !== 0 || p.clar !== 0;
  const uses = (hsOn ? 1 : 0) + (p.clar !== 0 ? 2 : 0) + (p.tex !== 0 ? 2 : 0) + (p.sharp !== 0 ? 2 : 0);
  if (uses === 0) return rgb;
  filters.push(`[${rgb}]split=2[${L('src')}][${L('ly')}]`);
  const Y = 'colorchannelmixer=rr=0.2126:rg=0.7152:rb=0.0722:gr=0.2126:gg=0.7152:gb=0.0722:br=0.2126:bg=0.7152:bb=0.0722,extractplanes=g';
  filters.push(`[${L('ly')}]${Y},split=2[${L('y1')}][${L('y2')}]`);
  const lOuts = Array.from({ length: uses }, (_, i) => L(`l${i}`));
  filters.push(`[${L('y1')}][${L('y2')}]${blend16(FF.logLum)}${uses > 1 ? `,split=${uses}` : ''}${lOuts.map((o) => `[${o}]`).join('')}`);
  let li = 0;
  const nextL = () => lOuts[li++];
  if (hsOn) {
    const base = L('base');
    filters.push(`[${nextL()}]${guided(p.hs)}[${base}]`);
    if (p.clar !== 0) {
      const l1 = nextL();
      const l2 = nextL();
      filters.push(`[${l2}]${guided(p.clarG)}[${L('cb')}]`);
      filters.push(`[${l1}][${L('cb')}]${blend16(FF.clarityDetail)}[${L('cd')}]`);
      filters.push(`[${base}][${L('cd')}]${blend16(FF.hsClar(p.hl, p.sh, p.clar))}[${L('t0')}]`);
    } else {
      filters.push(`[${base}]split=2[${L('b1')}][${L('b2')}]`);
      filters.push(`[${L('b1')}][${L('b2')}]${blend16(FF.hsClar(p.hl, p.sh, 0))}[${L('t0')}]`);
    }
    terms.push(L('t0'));
  }
  if (p.tex !== 0) {
    const l1 = nextL();
    const l2 = nextL();
    filters.push(`[${l2}]${gblur(p.texSigma)}[${L('tb')}]`);
    filters.push(`[${l1}][${L('tb')}]${blend16(FF.texture(p.tex))}[${L('t1')}]`);
    terms.push(L('t1'));
  }
  if (p.sharp !== 0) {
    const l1 = nextL();
    const l2 = nextL();
    filters.push(`[${l2}]${gblur(p.sharpSigma)}[${L('sb')}]`);
    filters.push(`[${l1}][${L('sb')}]${blend16(FF.sharpen(p.sharp, p.sharpLimit, p.sharpMask))}[${L('t2')}]`);
    terms.push(L('t2'));
  }
  let delta = terms[0];
  for (let i = 1; i < terms.length; i++) {
    filters.push(`[${delta}][${terms[i]}]${blend16(FF.add)}[${L(`s${i}`)}]`);
    delta = L(`s${i}`);
  }
  toRgb(filters, delta, L('dg'), 'gbrp16le');
  filters.push(`[${L('src')}][${L('dg')}]${blend16(FF.gain)}[${L('out')}]`);
  return L('out');
}

/**
 * Film grain after the LUT: a noise plate at the cell size (two octaves), upscaled, added with the
 * luminance weighting, on 8-bit RGB. ctx: { W, H, FPS, dur }. Returns the label (gbrp).
 */
export function grainFilters(filters, color, input, tag, { W, H, FPS, dur }) {
  const p = detailParams(color, Math.max(W, H));
  const L = (s) => `gr${tag}_${s}`;
  const plate = (cell, seed, label) => {
    const gw = Math.max(2, Math.round(W / cell));
    const gh = Math.max(2, Math.round(H / cell));
    filters.push(`color=c=0x808080:s=${gw}x${gh}:r=${FPS}:d=${fx(dur + 1)},format=yuvj444p,noise=alls=100:allf=t+u:all_seed=${seed},extractplanes=y,scale=${W}:${H}:flags=bicubic[${label}]`);
  };
  plate(p.grainCell, 1234, L('n1'));
  if (p.grainRough > 0) plate(p.grainCell / 2.3, 5678, L('n2'));
  else filters.push(`[${L('n1')}]split=2[${L('n1')}x][${L('n2')}]`);
  const n1 = p.grainRough > 0 ? L('n1') : `${L('n1')}x`;
  filters.push(`[${n1}][${L('n2')}]blend=all_expr='${wrap8(FF.octaves(p.grainRough))}'[${L('nv')}]`);
  toRgb(filters, L('nv'), L('ng'), 'gbrp');
  filters.push(`[${input}]format=gbrp[${L('in')}]`);
  filters.push(`[${L('in')}][${L('ng')}]blend=all_expr='${wrap8(FF.grain(p.grain))}':shortest=1[${L('out')}]`);
  return L('out');
}

