// Masks in the preview. Same geometry and strengths as the export (electron/render.cjs maskChain):
//   feather   gaussian sigma = feather × shorter side
//   blur      gaussian sigma = amount × 0.03 × shorter side
//   pixelate  block = max(2, amount × 0.08 × shorter side)
//   darken    multiply by 1 - amount × 0.85
//   cut       the clip is only visible inside the shape (outside with invert)
//   front     the shape's part of the clip is drawn again over the captions (captions behind it)
// Shapes: ellipse, rect, pen (drawn points), person (grey matte from engine/matte.py, framed like
// the clip by the player and handed in as a canvas).
import type { Mask } from '../types';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Mask centre at `local` seconds (linear movement to toX/toY over the clip). */
export function maskCentre(m: Mask, local: number, duration: number) {
  const u = duration > 0 ? clamp01(local / duration) : 0;
  return { x: m.x + ((m.toX ?? m.x) - m.x) * u, y: m.y + ((m.toY ?? m.y) - m.y) * u };
}

export const maskBlock = (m: Mask, short: number) => Math.max(2, Math.round(m.amount * 0.08 * short));

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Person mattes already framed like the clip (white = person), by mask id. */
export type Mattes = Map<string, HTMLCanvasElement>;

/** Grey matte -> white with the matte as alpha. */
function matteAlpha(src: HTMLCanvasElement, w: number, h: number) {
  const c = canvas(w, h);
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(src, 0, 0, w, h);
  const img = x.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i + 3] = d[i]!;
    d[i] = d[i + 1] = d[i + 2] = 255;
  }
  x.putImageData(img, 0, 0);
  return c;
}

/** White shape on transparent (or inverted), with the soft edge. Null: a person mask without its matte yet. */
function maskImage(m: Mask, w: number, h: number, local: number, duration: number, mattes?: Mattes) {
  const c = canvas(w, h);
  const x = c.getContext('2d')!;
  const short = Math.min(w, h);
  const { x: mx, y: my } = maskCentre(m, local, duration);
  const f = m.feather * short;
  if (m.shape === 'person') {
    const src = mattes?.get(m.id);
    if (!src) return null;
    const a = matteAlpha(src, w, h);
    if (m.invert) {
      x.fillStyle = '#fff';
      x.fillRect(0, 0, w, h);
      x.globalCompositeOperation = 'destination-out';
    }
    if (f > 0.5) x.filter = `blur(${f}px)`;
    x.drawImage(a, 0, 0);
    return c;
  }
  if (m.shape === 'pen' && (m.points?.length ?? 0) < 3) return null;
  const shape = (ctx: CanvasRenderingContext2D) => {
    ctx.beginPath();
    if (m.shape === 'ellipse') ctx.ellipse(mx * w, my * h, (m.w * w) / 2, (m.h * h) / 2, 0, 0, Math.PI * 2);
    else if (m.shape === 'pen') {
      // Drawn shape, moved with the mask's movement (centre path).
      const dx = mx - m.x;
      const dy = my - m.y;
      m.points!.forEach(([px, py], i) => (i ? ctx.lineTo((px + dx) * w, (py + dy) * h) : ctx.moveTo((px + dx) * w, (py + dy) * h)));
      ctx.closePath();
    } else ctx.rect((mx - m.w / 2) * w, (my - m.h / 2) * h, m.w * w, m.h * h);
    ctx.fill();
  };
  x.fillStyle = '#fff';
  if (f > 0.5) x.filter = `blur(${f}px)`;
  if (m.invert) {
    x.fillRect(-f * 3, -f * 3, w + f * 6, h + f * 6);
    x.globalCompositeOperation = 'destination-out';
  }
  shape(x);
  return c;
}

/**
 * The part of a clip that goes over the captions ("front" masks): a copy of the finished layer
 * kept only inside those masks. Null when the clip has none (or their shapes are not ready).
 */
export function frontLayer(layer: HTMLCanvasElement, masks: Mask[], local: number, duration: number, mattes?: Mattes) {
  const fronts = masks.filter((m) => m.mode === 'front');
  if (!fronts.length) return null;
  const w = layer.width;
  const h = layer.height;
  const union = canvas(w, h);
  const ux = union.getContext('2d')!;
  let any = false;
  for (const m of fronts) {
    const mi = maskImage(m, w, h, local, duration, mattes);
    if (!mi) continue;
    ux.globalCompositeOperation = 'lighten';
    ux.drawImage(mi, 0, 0);
    any = true;
  }
  if (!any) return null;
  const out = canvas(w, h);
  const ox = out.getContext('2d')!;
  ox.drawImage(layer, 0, 0);
  ox.globalCompositeOperation = 'destination-in';
  ox.drawImage(union, 0, 0);
  return out;
}

/** Apply a clip's masks to its layer (effects first, then cuts, like the export). Front masks do not change the layer. */
export function applyMasks(layer: HTMLCanvasElement, masks: Mask[], local: number, duration: number, mattes?: Mattes) {
  const w = layer.width;
  const h = layer.height;
  const short = Math.min(w, h);
  const lx = layer.getContext('2d')!;
  const live = masks.filter((m) => m.mode !== 'front');
  const ordered = [...live.filter((m) => m.mode !== 'cut'), ...live.filter((m) => m.mode === 'cut')];
  for (const m of ordered) {
    const mi = maskImage(m, w, h, local, duration, mattes);
    if (!mi) continue;
    if (m.mode === 'cut') {
      lx.save();
      lx.globalCompositeOperation = 'destination-in';
      lx.drawImage(mi, 0, 0);
      lx.restore();
      continue;
    }
    const e = canvas(w, h);
    const ex = e.getContext('2d')!;
    if (m.mode === 'blur') {
      ex.filter = `blur(${Math.max(0.5, m.amount * 0.03 * short)}px)`;
      ex.drawImage(layer, 0, 0);
      ex.filter = 'none';
    } else if (m.mode === 'pixelate') {
      const b = maskBlock(m, short);
      const small = canvas(Math.ceil(w / b), Math.ceil(h / b));
      const sx = small.getContext('2d')!;
      sx.imageSmoothingEnabled = true;
      sx.drawImage(layer, 0, 0, small.width, small.height);
      ex.imageSmoothingEnabled = false;
      ex.drawImage(small, 0, 0, small.width * b, small.height * b);
    } else {
      ex.drawImage(layer, 0, 0);
      ex.globalCompositeOperation = 'source-atop';
      ex.fillStyle = `rgba(0,0,0,${clamp01(m.amount * 0.85)})`;
      ex.fillRect(0, 0, w, h);
    }
    ex.globalCompositeOperation = 'destination-in';
    ex.drawImage(mi, 0, 0);
    lx.save();
    lx.globalCompositeOperation = 'source-atop';
    lx.drawImage(e, 0, 0);
    lx.restore();
  }
}
