// Fusion nodes from PhotoCraft (docs/engenharia-reversa/photocraft.md §3.7–3.9), shared by the preview
// (src/engine/fusion.ts) and the export (electron/render.cjs fusionChain):
//
//   tiltshift  Blur Gallery Tilt-Shift: d = |(p − c)·n| / short side, weight = smoothstep(focus, focus + transition, d)
//   irisblur   Blur Gallery Iris: superellipse distance e (exponent 2 + 6·roundness), weight = smoothstep(feather, 1, e)
//              Both blur with σ = weight · σmax, approximated by mixing three levels (sharp, σmax/2, σmax),
//              like PhotoCraft's level interpolation (gallery.rs uses 7 levels).
//   lensflare  Lens Flare (render.rs): core + glow, rays, optional anamorphic streak, chromatic halo ring
//              and ghost discs along the line to the frame centre, s = diagonal / 1000, added with Screen.
//              The lens tables are not ported: one 35 mm-like set of sizes and tints.
//   relight    Relight (relight.rs): S = Gaussian(luma, σ), normal from S's slopes, Lambert lamp,
//              out = c / max(S, 0.04) · (ambient + intensity · max(n·l, 0)) · warmth, mixed by `amount`.
//
// Each has a js form (preview and tests) and an ffmpeg form (geq on a single frame for the static masks
// and the flare, looped; geq per frame for relight).

const fx = (n) => String(Math.round(n * 1e6) / 1e6);
const smooth = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / Math.max(1e-6, e1 - e0)));
  return t * t * (3 - 2 * t);
};
const ffSmooth = (e0, e1, x) => `(st(9,clip((${x}-(${fx(e0)}))/${fx(Math.max(1e-6, e1 - e0))},0,1));ld(9)*ld(9)*(3-2*ld(9)))`;
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

// ---------------------------------------------------------------------------------------------
// Blur Gallery

/** Largest blur σ (px) for `blur` 0..1 on a frame whose shorter side is `short` (same scale as the Blur node). */
export const galleryMaxSigma = (blur, short) => Math.max(0, Math.min(1, num(blur, 0.5))) * 0.03 * short;

/** Weight 0..1 (0 = sharp) at pixel (x, y) of a W × H frame. p = the node's params. */
export function tiltWeight(x, y, W, H, p) {
  const short = Math.min(W, H);
  const a = (num(p.angle, 0) * Math.PI) / 180;
  const d = Math.abs(-(x - W / 2) * Math.sin(a) + (y - num(p.y, 0.5) * H) * Math.cos(a)) / short;
  const f = Math.max(0, num(p.focus, 0.12));
  return smooth(f, f + Math.max(0.001, num(p.transition, 0.15)), d);
}
export function tiltFF(W, H, p) {
  const short = Math.min(W, H);
  const a = (num(p.angle, 0) * Math.PI) / 180;
  const f = Math.max(0, num(p.focus, 0.12));
  const d = `abs(-(X-${fx(W / 2)})*${fx(Math.sin(a))}+(Y-${fx(num(p.y, 0.5) * H)})*${fx(Math.cos(a))})/${fx(short)}`;
  return ffSmooth(f, f + Math.max(0.001, num(p.transition, 0.15)), d);
}

function irisGeo(W, H, p) {
  const short = Math.min(W, H);
  const asp = Math.max(0.2, num(p.aspect, 1));
  const r = Math.max(0.01, num(p.size, 0.3)) * short;
  return { cx: num(p.x, 0.5) * W, cy: num(p.y, 0.5) * H, rx: r * Math.sqrt(asp), ry: r / Math.sqrt(asp), pw: 2 + 6 * Math.max(0, Math.min(1, num(p.roundness, 0))), feather: Math.max(0, Math.min(0.99, num(p.feather, 0.5))) };
}
export function irisWeight(x, y, W, H, p) {
  const g = irisGeo(W, H, p);
  const e = Math.pow(Math.pow(Math.abs((x - g.cx) / g.rx), g.pw) + Math.pow(Math.abs((y - g.cy) / g.ry), g.pw), 1 / g.pw);
  return smooth(g.feather, 1, e);
}
export function irisFF(W, H, p) {
  const g = irisGeo(W, H, p);
  const e = `pow(pow(abs((X-${fx(g.cx)})/${fx(g.rx)}),${fx(g.pw)})+pow(abs((Y-${fx(g.cy)})/${fx(g.ry)}),${fx(g.pw)}),${fx(1 / g.pw)})`;
  return ffSmooth(g.feather, 1, e);
}

/** Level weights for the three-level mix: m1 sharp -> σmax/2, m2 σmax/2 -> σmax. */
export const levelWeights = (w) => [Math.max(0, Math.min(1, 2 * w)), Math.max(0, Math.min(1, 2 * w - 1))];

// ---------------------------------------------------------------------------------------------
// Lens flare

const GHOSTS = [
  { t: 0.35, r: 40, tint: [0.4, 0.8, 1] },
  { t: 0.6, r: 18, tint: [1, 0.6, 0.3] },
  { t: 0.85, r: 60, tint: [0.5, 1, 0.6] },
  { t: 1.1, r: 25, tint: [0.9, 0.5, 1] },
];
const CORE = [1, 0.92, 0.8];
const RAYS = [1, 0.95, 0.85];
const STREAK = [0.55, 0.75, 1];
const HALO_OFF = [0.04, 0, -0.04];

function flareGeo(W, H, p) {
  return { fxp: num(p.x, 0.3) * W, fyp: num(p.y, 0.3) * H, cx: W / 2, cy: H / 2, s: Math.hypot(W, H) / 1000, b: Math.max(0, num(p.brightness, 1)), streak: p.streak === true || p.streak === 1 };
}

/** Flare light [r, g, b] (0..1, added with Screen) at pixel (x, y). */
export function flareRGB(x, y, W, H, p) {
  const g = flareGeo(W, H, p);
  const dx = x - g.fxp;
  const dy = y - g.fyp;
  const d = Math.hypot(dx, dy);
  const th = Math.atan2(dy, dx);
  const core = Math.exp(-((d / (12 * g.s)) ** 2)) + 0.35 * Math.exp(-d / (120 * g.s));
  const rays = (Math.pow(Math.sin(12 * th) * 0.5 + 0.5, 8) + 0.6 * Math.pow(Math.sin(7 * th + 1.3) * 0.5 + 0.5, 12)) * Math.exp(-d / (220 * g.s)) * 0.35;
  const streak = g.streak ? Math.exp(-Math.abs(dy) / (2.5 * g.s)) * Math.exp(-Math.abs(dx) / (450 * g.s)) * 0.6 : 0;
  return [0, 1, 2].map((i) => {
    const R = 200 * g.s * (1 + HALO_OFF[i]);
    let v = core * CORE[i] + rays * RAYS[i] + streak * STREAK[i] + 0.18 * Math.exp(-(((d - R) / (6 * g.s)) ** 2));
    for (const gh of GHOSTS) {
      const gx = g.fxp + (g.cx - g.fxp) * 2 * gh.t;
      const gy = g.fyp + (g.cy - g.fyp) * 2 * gh.t;
      v += 0.08 * gh.tint[i] * Math.exp(-((Math.hypot(x - gx, y - gy) / (gh.r * g.s)) ** 4));
    }
    return Math.max(0, Math.min(1, g.b * v));
  });
}

/** geq r/g/b expressions (0..255) of flareRGB. */
export function flareGeq(W, H, p) {
  const g = flareGeo(W, H, p);
  const dx = `(X-${fx(g.fxp)})`;
  const dy = `(Y-${fx(g.fyp)})`;
  const d = `hypot(${dx},${dy})`;
  const th = `atan2(${dy},${dx})`;
  const core = `(exp(-pow(${d}/${fx(12 * g.s)},2))+0.35*exp(-${d}/${fx(120 * g.s)}))`;
  const rays = `((pow(sin(12*${th})*0.5+0.5,8)+0.6*pow(sin(7*${th}+1.3)*0.5+0.5,12))*exp(-${d}/${fx(220 * g.s)})*0.35)`;
  const streak = g.streak ? `(exp(-abs(${dy})/${fx(2.5 * g.s)})*exp(-abs(${dx})/${fx(450 * g.s)})*0.6)` : '0';
  const ch = (i) => {
    const R = 200 * g.s * (1 + HALO_OFF[i]);
    const ghosts = GHOSTS.map((gh) => {
      const gx = g.fxp + (g.cx - g.fxp) * 2 * gh.t;
      const gy = g.fyp + (g.cy - g.fyp) * 2 * gh.t;
      return `${fx(0.08 * gh.tint[i])}*exp(-pow(hypot(X-${fx(gx)},Y-${fx(gy)})/${fx(gh.r * g.s)},4))`;
    }).join('+');
    return `255*clip(${fx(g.b)}*(${core}*${CORE[i]}+${rays}*${RAYS[i]}+${streak}*${STREAK[i]}+0.18*exp(-pow((${d}-${fx(R)})/${fx(6 * g.s)},2))+${ghosts}),0,1)`;
  };
  return { r: ch(0), g: ch(1), b: ch(2) };
}

// ---------------------------------------------------------------------------------------------
// Relight

export const LUMA709 = [0.2126, 0.7152, 0.0722];

/** σ and slope step k (px) of the shading, light vector and warmth gains for a frame with shorter side `short`. */
export function relightParams(p, short) {
  const sigma = Math.max(2, Math.min(96, (Math.max(0, Math.min(100, num(p.softness, 50))) / 100) * 0.08 * short));
  const a = (num(p.angle, 135) * Math.PI) / 180;
  const e = (Math.max(0, Math.min(90, num(p.elevation, 45))) * Math.PI) / 180;
  const w = Math.max(-1, Math.min(1, num(p.warmth, 0)));
  const warm = w >= 0 ? [1 + 0.15 * w, 1 - 0.05 * w, 1 - 0.25 * w] : [1 + 0.2 * w, 1 + 0.1 * w, 1 - 0.15 * w];
  return {
    sigma,
    k: Math.max(1, Math.min(32, Math.round(sigma))),
    L: [Math.cos(a) * Math.cos(e), -Math.sin(a) * Math.cos(e), Math.sin(e)],
    ambient: Math.max(0, Math.min(1, num(p.ambient, 0.2))),
    intensity: Math.max(0, Math.min(2, num(p.intensity, 0.4))),
    amount: Math.max(0, Math.min(1, num(p.amount, 1))),
    warm,
  };
}

/** Light factor F = shade / max(S, 0.04) from the shading S at the pixel and its neighbours k px away. */
export function relightFactor(S, sxm, sxp, sym, syp, q) {
  let nx = 2 * (sxm - sxp);
  let ny = 2 * (sym - syp);
  let nz = 1;
  const l = Math.hypot(nx, ny, nz);
  nx /= l;
  ny /= l;
  nz /= l;
  const shade = q.ambient + q.intensity * Math.max(0, nx * q.L[0] + ny * q.L[1] + nz * q.L[2]);
  return shade / Math.max(S, 0.04);
}
/** One channel (0..1) relit: mix(c, c · F · warm, amount). */
export const relightJS = (c, F, i, q) => Math.max(0, Math.min(1, c + (c * F * q.warm[i] - c) * q.amount));

/** Encoding of F in a 16-bit plane. */
export const F_MAX = 32;
/** geq expression (gray16) of F / F_MAX from the blurred luma plane (lum() is 0..65535). */
export function relightGeq(q) {
  const S = (dx, dy) => `lum(X+(${dx}),Y+(${dy}))/65535`;
  const k = q.k;
  return (
    `st(0,2*(${S(-k, 0)}-${S(k, 0)}));st(1,2*(${S(0, -k)}-${S(0, k)}));st(2,sqrt(ld(0)*ld(0)+ld(1)*ld(1)+1));` +
    `st(3,${fx(q.ambient)}+${fx(q.intensity)}*max(0,(ld(0)*${fx(q.L[0])}+ld(1)*${fx(q.L[1])}+${fx(q.L[2])})/ld(2)));` +
    `65535*clip(ld(3)/max(${S(0, 0)},0.04)/${F_MAX},0,1)`
  );
}
