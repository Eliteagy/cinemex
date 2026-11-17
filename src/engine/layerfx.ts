// Preview of the After Effects-style layer: effect stack and track matte drawn on the clip's layer canvas,
// with the same geometry as the export (src/lib/layerfx.js).
import type { Clip, Effect, Matte } from '../types';
import { MATTE_FONT, shadowOffset, sweepAt, textMatteBox } from '../lib/layerfx.js';
import { fontOf, resolveFont } from './caption';
import { spreadN, strokeMask } from '../lib/pslayer.js';

const rgba = (hex: string, a: number) => {
  const h = (hex || '#000000').replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16) || 0},${parseInt(h.slice(2, 4), 16) || 0},${parseInt(h.slice(4, 6), 16) || 0},${a})`;
};

const pool: HTMLCanvasElement[] = [];
function scratch(i: number, w: number, h: number) {
  const c = (pool[i] ??= document.createElement('canvas'));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const x = c.getContext('2d', { willReadFrequently: i === 3 || i === 6 })!;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalAlpha = 1;
  x.globalCompositeOperation = 'source-over';
  x.filter = 'none';
  x.shadowColor = 'transparent';
  x.clearRect(0, 0, w, h);
  return { c, x };
}

/**
 * Apply the clip's effects and matte to `layer` (canvas of cw x ch, the framed clip with transparency).
 * W, H: project size (export pixels); lengths are scaled by cw / W. matteSource gives a media's current picture.
 */
export function applyLayerFx(layer: HTMLCanvasElement, clip: Clip, local: number, W: number, H: number, matteSource: (mediaId: string) => CanvasImageSource | null) {
  const cw = layer.width;
  const ch = layer.height;
  const k = cw / W;
  const short = Math.min(W, H);
  const lx = layer.getContext('2d')!;
  for (const e of clip.effects ?? []) applyEffect(layer, lx, e, local, W, H, k, short);
  if (clip.matte) applyMatte(layer, lx, clip.matte, W, H, k, matteSource);
  void ch;
}

/**
 * Grey mask of the layer's alpha as `color` (inv: 1 − alpha), shifted by (dx, dy) px and blurred with σ px,
 * on scratch canvas `slot`. Outside the frame counts as transparent (inv: as colour), like the export's pad.
 */
function alphaMask(layer: HTMLCanvasElement, slot: number, color: string, o: { inv?: boolean; dx?: number; dy?: number; sigma: number }) {
  const cw = layer.width;
  const ch = layer.height;
  const dx = o.dx ?? 0;
  const dy = o.dy ?? 0;
  const M = Math.ceil(3 * o.sigma + Math.abs(dx) + Math.abs(dy)) + 2;
  const pad = scratch(4, cw + 2 * M, ch + 2 * M);
  if (o.inv) {
    pad.x.fillStyle = color;
    pad.x.fillRect(0, 0, cw + 2 * M, ch + 2 * M);
    pad.x.globalCompositeOperation = 'destination-out';
    pad.x.drawImage(layer, M + dx, M + dy);
  } else {
    pad.x.drawImage(layer, M + dx, M + dy);
    pad.x.globalCompositeOperation = 'source-in';
    pad.x.fillStyle = color;
    pad.x.fillRect(0, 0, cw + 2 * M, ch + 2 * M);
  }
  const out = scratch(slot, cw, ch);
  if (o.sigma > 0.3) out.x.filter = `blur(${o.sigma}px)`;
  out.x.drawImage(pad.c, -M, -M);
  out.x.filter = 'none';
  return out;
}

/** Repeats a mask n times (alpha 1 − (1 − g)^n: the glow's spread, same as the export's lut). */
function spread(m: { c: HTMLCanvasElement; x: CanvasRenderingContext2D }, n: number) {
  if (n <= 1) return m;
  const r = scratch(6, m.c.width, m.c.height);
  for (let i = 0; i < n; i++) r.x.drawImage(m.c, 0, 0);
  return r;
}

/** Stroke edge cut of a blurred mask (pslayer.js strokeMask), per pixel. */
function cut(m: { c: HTMLCanvasElement; x: CanvasRenderingContext2D }) {
  const d = m.x.getImageData(0, 0, m.c.width, m.c.height);
  const p = d.data;
  for (let i = 3; i < p.length; i += 4) p[i] = Math.round(255 * strokeMask(p[i]! / 255));
  m.x.putImageData(d, 0, 0);
  return m;
}

/** Draws `under` below the layer (outer styles). */
function below(layer: HTMLCanvasElement, lx: CanvasRenderingContext2D, under: HTMLCanvasElement, alpha: number) {
  const r = scratch(5, layer.width, layer.height);
  r.x.globalAlpha = alpha;
  r.x.drawImage(under, 0, 0);
  r.x.globalAlpha = 1;
  r.x.drawImage(layer, 0, 0);
  lx.clearRect(0, 0, layer.width, layer.height);
  lx.drawImage(r.c, 0, 0);
}

/** Draws `over` on the layer, inside its own alpha (inner styles). */
function atop(lx: CanvasRenderingContext2D, over: HTMLCanvasElement, alpha: number) {
  lx.save();
  lx.globalCompositeOperation = 'source-atop';
  lx.globalAlpha = alpha;
  lx.drawImage(over, 0, 0);
  lx.restore();
}

function applyEffect(layer: HTMLCanvasElement, lx: CanvasRenderingContext2D, e: Effect, local: number, W: number, H: number, k: number, short: number) {
  const cw = layer.width;
  const ch = layer.height;
  const op = 'opacity' in e ? Math.max(0, Math.min(1, e.opacity)) : 1;
  if (e.type === 'stroke') {
    const size = Math.max(0, Math.min(0.1, e.size)) * short * k;
    const part = e.position === 'center' ? size / 2 : size;
    if (e.position !== 'inside') below(layer, lx, cut(alphaMask(layer, 2, e.color, { sigma: part / 2 })).c, op);
    if (e.position === 'inside' || e.position === 'center') atop(lx, cut(alphaMask(layer, 2, e.color, { inv: true, sigma: part / 2 })).c, op);
    return;
  }
  if (e.type === 'outerGlow' || e.type === 'innerGlow') {
    const sigma = (Math.max(0, Math.min(0.2, e.size)) * short * k) / 2;
    const m = spread(alphaMask(layer, 2, e.color, { inv: e.type === 'innerGlow', sigma }), spreadN(e.spread));
    if (e.type === 'outerGlow') below(layer, lx, m.c, op);
    else atop(lx, m.c, op);
    return;
  }
  if (e.type === 'innerShadow') {
    const { dx, dy } = shadowOffset(e, short);
    // the export shifts by whole pixels
    const m = alphaMask(layer, 2, e.color, { inv: true, dx: Math.round(dx) * k, dy: Math.round(dy) * k, sigma: Math.max(0, Math.min(0.1, e.softness)) * short * k });
    atop(lx, m.c, op);
    return;
  }
  if (e.type === 'shadow') {
    // Shadow = the layer's alpha in the shadow colour, blurred, offset; the layer on top.
    const { c, x } = scratch(0, cw, ch);
    const { dx, dy } = shadowOffset(e, short);
    x.shadowColor = rgba(e.color, Math.max(0, Math.min(1, e.opacity)));
    x.shadowBlur = 2 * Math.max(0, e.softness) * short * k; // canvas shadowBlur = 2 sigma
    x.shadowOffsetX = dx * k + cw * 4;
    x.shadowOffsetY = dy * k;
    x.drawImage(layer, -cw * 4, 0); // draw the layer off-canvas: only its shadow lands on the canvas
    x.shadowColor = 'transparent';
    x.drawImage(layer, 0, 0);
    lx.clearRect(0, 0, cw, ch);
    lx.drawImage(c, 0, 0);
  } else if (e.type === 'glow') {
    // Screen a blurred copy at `intensity` (export: blend screen with all_opacity).
    const { c, x } = scratch(1, cw, ch);
    x.filter = `blur(${Math.max(0.5, e.radius * short) * k}px)`;
    x.drawImage(layer, 0, 0);
    lx.save();
    lx.globalCompositeOperation = 'screen';
    lx.globalAlpha = Math.max(0, Math.min(1, e.intensity));
    lx.drawImage(c, 0, 0);
    lx.restore();
  } else if (e.type === 'sweep') {
    const sw = sweepAt(e, local, W, H);
    if (!sw.active) return;
    // Band with linear falloff around `pos` along (cos, sin), added where the layer is (export: geq min(255, c + col * I)).
    const { c, x } = scratch(2, cw, ch);
    const g = x.createLinearGradient((sw.pos - sw.w) * sw.c * k, (sw.pos - sw.w) * sw.s * k, (sw.pos + sw.w) * sw.c * k, (sw.pos + sw.w) * sw.s * k);
    const I = Math.max(0, Math.min(2, e.intensity));
    g.addColorStop(0, rgba(e.color, 0));
    g.addColorStop(0.5, rgba(e.color, Math.min(1, I)));
    g.addColorStop(1, rgba(e.color, 0));
    x.fillStyle = g;
    x.fillRect(0, 0, cw, ch);
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(layer, 0, 0);
    lx.save();
    lx.globalCompositeOperation = 'lighter';
    lx.drawImage(c, 0, 0);
    lx.restore();
  } else if (e.type === 'gradient') {
    lx.save();
    lx.globalCompositeOperation = 'source-atop';
    lx.globalAlpha = Math.max(0, Math.min(1, e.opacity));
    const g = lx.createLinearGradient(e.x0 * W * k, e.y0 * H * k, e.x1 * W * k, e.y1 * H * k);
    g.addColorStop(0, e.c0);
    g.addColorStop(1, e.c1);
    lx.fillStyle = g;
    lx.fillRect(0, 0, cw, ch);
    lx.restore();
  }
}

function applyMatte(layer: HTMLCanvasElement, lx: CanvasRenderingContext2D, m: Matte, W: number, H: number, k: number, matteSource: (mediaId: string) => CanvasImageSource | null) {
  const cw = layer.width;
  const ch = layer.height;
  const { c, x } = scratch(3, cw, ch);
  if (m.kind === 'text') {
    if (!String(m.text || '').trim()) return;
    const b = textMatteBox(m, W, H);
    const font = resolveFont(m.font || MATTE_FONT);
    x.font = fontOf(font, b.px * k);
    x.textAlign = 'center';
    x.textBaseline = 'alphabetic';
    const tm = x.measureText(m.text);
    const asc = tm.fontBoundingBoxAscent;
    const desc = tm.fontBoundingBoxDescent;
    x.fillStyle = '#fff';
    x.fillText(m.text, b.cx * k, b.cy * k - (asc + desc) / 2 + asc);
  } else {
    const src = matteSource(m.mediaId);
    if (!src) return;
    const sw = src instanceof HTMLVideoElement ? src.videoWidth : (src as HTMLImageElement).naturalWidth || cw;
    const sh = src instanceof HTMLVideoElement ? src.videoHeight : (src as HTMLImageElement).naturalHeight || ch;
    const s = Math.max(cw / sw, ch / sh);
    x.drawImage(src, (cw - sw * s) / 2, (ch - sh * s) / 2, sw * s, sh * s);
    if (m.mode === 'luma') {
      // Brightness becomes alpha (export: format=gray as the alpha plane).
      const d = x.getImageData(0, 0, cw, ch);
      const p = d.data;
      for (let i = 0; i < p.length; i += 4) {
        p[i + 3] = Math.round((0.2126 * p[i]! + 0.7152 * p[i + 1]! + 0.0722 * p[i + 2]!) * (p[i + 3]! / 255));
        p[i] = p[i + 1] = p[i + 2] = 255;
      }
      x.putImageData(d, 0, 0);
    }
  }
  if (m.invert) {
    // Inverted matte: keep the layer where the matte is NOT.
    lx.save();
    lx.globalCompositeOperation = 'destination-out';
    lx.drawImage(c, 0, 0);
    lx.restore();
  } else {
    lx.save();
    lx.globalCompositeOperation = 'destination-in';
    lx.drawImage(c, 0, 0);
    lx.restore();
  }
}
