// Moldura e fundo: the clip is shown smaller, with rounded corners, a soft shadow and an optional
// outline, over a background (a colour or a two-colour gradient) that fills the canvas.
// Shared by the preview (src/engine/frame.ts) and the export (frameFilters, below): both read the
// same geometry from frameGeo and the same background from bgOf, so they draw the same picture.

const clamp = (v, a, b) => Math.max(a, Math.min(b, Number.isFinite(Number(v)) ? Number(v) : a));
const HEX = /^#[0-9a-f]{6}$/i;
const hex = (v, def) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : def);
const fx = (n) => String(Math.round(n * 10000) / 10000);

/** Gradient backgrounds: two colours along a line (angle in degrees, 0 = left to right, 90 = top to bottom). */
export const GRADIENTS = {
  noite: { label: 'Noite', from: '#141e30', to: '#243b55', angle: 135 },
  oceano: { label: 'Oceano', from: '#2f7cf6', to: '#00c2ff', angle: 135 },
  aurora: { label: 'Aurora', from: '#7f5af0', to: '#2cb67d', angle: 135 },
  por_do_sol: { label: 'Pôr do sol', from: '#ff512f', to: '#f09819', angle: 135 },
  magenta: { label: 'Magenta', from: '#c31432', to: '#6a11cb', angle: 135 },
  violeta: { label: 'Violeta', from: '#4e54c8', to: '#8f94fb', angle: 135 },
  ouro: { label: 'Ouro', from: '#3a2c0a', to: '#d4af37', angle: 135 },
  grafite: { label: 'Grafite', from: '#232526', to: '#414345', angle: 135 },
  menta: { label: 'Menta', from: '#0f9b8e', to: '#a8e063', angle: 135 },
};
export const GRADIENT_IDS = Object.keys(GRADIENTS);
export const BG_KINDS = ['none', 'color', 'gradient'];

/** What "Moldura" switches on with one click. */
export const FRAME_DEFAULT = { padding: 0.08, radius: 0.04, shadow: 0.5, border: 0, borderColor: '#ffffff', bg: { kind: 'gradient', preset: 'oceano' } };
export const FRAME_LIMITS = { padding: [0, 0.35], radius: [0, 0.5], shadow: [0, 1], border: [0, 0.02] };

/** A valid frame, or null when there is none (or it changes nothing). */
export function cleanFrame(f) {
  if (!f || typeof f !== 'object') return null;
  const b = f.bg && typeof f.bg === 'object' ? f.bg : {};
  const kind = BG_KINDS.includes(b.kind) ? b.kind : 'none';
  const bg = { kind };
  if (kind === 'color') bg.color = hex(b.color, '#101011');
  if (kind === 'gradient') {
    if (typeof b.preset === 'string' && GRADIENTS[b.preset]) bg.preset = b.preset;
    else {
      bg.from = hex(b.from, GRADIENTS.oceano.from);
      bg.to = hex(b.to, GRADIENTS.oceano.to);
      bg.angle = clamp(b.angle ?? 135, 0, 360);
    }
  }
  const out = {
    padding: clamp(f.padding, ...FRAME_LIMITS.padding),
    radius: clamp(f.radius, ...FRAME_LIMITS.radius),
    shadow: clamp(f.shadow, ...FRAME_LIMITS.shadow),
    border: clamp(f.border, ...FRAME_LIMITS.border),
    borderColor: hex(f.borderColor, '#ffffff'),
    bg,
  };
  const plain = out.padding < 1e-4 && out.radius < 1e-4 && out.border < 1e-5 && kind === 'none';
  return plain ? null : out;
}

export const hasFrame = (f) => cleanFrame(f) !== null;

/**
 * Pixel geometry on a W x H canvas: the picture's box (ix, iy, iw, ih, even sizes), its corner
 * radius r, the outline width bw (the outline grows outwards), and the shadow (gaussian sigma,
 * downward offset dy, opacity alpha) of the box with its outline.
 */
export function frameGeo(frame, W, H) {
  const f = cleanFrame(frame) ?? { padding: 0, radius: 0, shadow: 0, border: 0 };
  const short = Math.min(W, H);
  const s = 1 - 2 * f.padding;
  const iw = Math.max(2, Math.round((W * s) / 2) * 2);
  const ih = Math.max(2, Math.round((H * s) / 2) * 2);
  const r = Math.round(f.radius * Math.min(iw, ih));
  const bw = Math.round(f.border * short);
  return { ix: (W - iw) / 2, iy: (H - ih) / 2, iw, ih, r, bw, sigma: 0.022 * short, dy: Math.round(0.012 * short), alpha: 0.75 * f.shadow };
}

/**
 * The background as drawable facts: { kind: 'none' } | { kind: 'color', color } |
 * { kind: 'gradient', from, to, x0, y0, x1, y1 } with the line's ends in pixels of the W x H canvas.
 */
export function bgOf(frame, W, H) {
  const f = cleanFrame(frame);
  if (!f || f.bg.kind === 'none') return { kind: 'none' };
  if (f.bg.kind === 'color') return { kind: 'color', color: f.bg.color };
  const g = f.bg.preset ? GRADIENTS[f.bg.preset] : f.bg;
  const a = (g.angle * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  // The line passes through the centre and is long enough to reach the corners (as CSS gradients).
  const half = (Math.abs(dx) * W + Math.abs(dy) * H) / 2;
  return { kind: 'gradient', from: g.from, to: g.to, x0: W / 2 - dx * half, y0: H / 2 - dy * half, x1: W / 2 + dx * half, y1: H / 2 + dy * half };
}

const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** ffmpeg geq expression, 0..1: inside a rounded box centred at (cx, cy) with half sizes hw, hh and radius r (1 px soft edge). */
export function roundBoxExpr(cx, cy, hw, hh, r) {
  if (r < 1) return `lte(abs(X-${fx(cx)}),${fx(hw)})*lte(abs(Y-${fx(cy)}),${fx(hh)})`;
  return `clip(${fx(r)}-hypot(max(abs(X-${fx(cx)})-${fx(hw - r)},0),max(abs(Y-${fx(cy)})-${fx(hh - r)},0))+0.5,0,1)`;
}

/**
 * Export. Appends to `filters`, reads the full-canvas stream labelled `input` (the framed, graded
 * clip in local time) and returns the label of a full-canvas RGBA stream: background, shadow,
 * outline and the clip inside its rounded box. Everything that does not move is drawn once and
 * repeated; only the clip itself is scaled every frame.
 */
export function frameFilters(filters, frame, input, tag, { W, H, FPS, dur }) {
  const g = frameGeo(frame, W, H);
  const bg = bgOf(frame, W, H);
  const f = cleanFrame(frame);
  const len = fx(dur + 0.5);
  const one = fx(1 / FPS);
  const still = `loop=loop=-1:size=1,trim=duration=${len},setpts=N/(${FPS}*TB)`;
  const cx = (W - 1) / 2;
  const cy = (H - 1) / 2;

  // The clip, scaled into its box, with rounded corners.
  filters.push(`color=c=black:s=${g.iw}x${g.ih}:r=${FPS}:d=${one},format=gray,geq=lum='255*${roundBoxExpr((g.iw - 1) / 2, (g.ih - 1) / 2, g.iw / 2, g.ih / 2, g.r)}',${still}[fk${tag}]`);
  filters.push(`[${input}]scale=${g.iw}:${g.ih},setsar=1,format=rgba[fs${tag}]`);
  filters.push(`[fs${tag}][fk${tag}]alphamerge[fc${tag}]`);

  // Background.
  let cur = `fb${tag}`;
  if (bg.kind === 'gradient') {
    const [r0, g0, b0] = rgb(bg.from);
    const [r1, g1, b1] = rgb(bg.to);
    const dx = bg.x1 - bg.x0;
    const dy = bg.y1 - bg.y0;
    const u = `clip(((X-${fx(bg.x0)})*${fx(dx)}+(Y-${fx(bg.y0)})*${fx(dy)})/${fx(dx * dx + dy * dy)},0,1)`;
    const ch = (a, b) => `${a}+(${b - a})*${u}`;
    filters.push(`color=c=black:s=${W}x${H}:r=${FPS}:d=${one},format=gbrp,geq=r='${ch(r0, r1)}':g='${ch(g0, g1)}':b='${ch(b0, b1)}',${still},format=rgba[${cur}]`);
  } else {
    const c = bg.kind === 'color' ? `0x${bg.color.slice(1)}` : 'black@0';
    filters.push(`color=c=${c}:s=${W}x${H}:r=${FPS}:d=${len},format=rgba[${cur}]`);
  }
  /** A flat colour shaped by a grey mask (drawn once), laid over the current picture. */
  const shape = (name, color, lum, soft) => {
    filters.push(`color=c=black:s=${W}x${H}:r=${FPS}:d=${one},format=gray,geq=lum='${lum}'${soft},${still}[${name}m${tag}]`);
    filters.push(`color=c=${color}:s=${W}x${H}:r=${FPS}:d=${len},format=rgba[${name}c${tag}]`);
    filters.push(`[${name}c${tag}][${name}m${tag}]alphamerge[${name}a${tag}]`);
    filters.push(`[${cur}][${name}a${tag}]overlay=format=auto[${name}o${tag}]`);
    cur = `${name}o${tag}`;
  };
  const hw = g.iw / 2 + g.bw;
  const hh = g.ih / 2 + g.bw;
  if (g.alpha > 0.004) shape('fh', 'black', `${fx(255 * g.alpha)}*${roundBoxExpr(cx, cy + g.dy, hw, hh, g.r + g.bw)}`, `,gblur=sigma=${fx(g.sigma)}`);
  if (g.bw > 0) shape('fo', `0x${f.borderColor.slice(1)}`, `255*${roundBoxExpr(cx, cy, hw, hh, g.r + g.bw)}`, '');
  filters.push(`[${cur}][fc${tag}]overlay=x=${g.ix}:y=${g.iy}:format=auto[fr${tag}_out]`);
  return `fr${tag}_out`;
}
