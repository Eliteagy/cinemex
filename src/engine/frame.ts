// Preview of "Moldura e fundo": the same picture the export builds in src/lib/frame.js
// (frameFilters), drawn on the clip's layer canvas.
import { bgOf, cleanFrame, frameGeo } from '../lib/frame.js';

let copy: HTMLCanvasElement | null = null;
let shade: HTMLCanvasElement | null = null;

function sized(c: HTMLCanvasElement | null, w: number, h: number) {
  const out = c ?? document.createElement('canvas');
  if (out.width !== w || out.height !== h) {
    out.width = w;
    out.height = h;
  }
  return out;
}

function box(x: CanvasRenderingContext2D, left: number, top: number, w: number, h: number, r: number) {
  x.beginPath();
  x.roundRect(left, top, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
}

/**
 * Replaces the layer's picture (the clip filling the canvas) with: background, shadow, outline
 * and the clip scaled into its rounded box. W and H are the project's size; the layer may be
 * smaller (preview resolution), so the project geometry is scaled by layer.width / W.
 */
export function applyFrame(layer: HTMLCanvasElement, frame: unknown, W: number, H: number) {
  if (!cleanFrame(frame)) return;
  const cw = layer.width;
  const ch = layer.height;
  const k = cw / W;
  const g = frameGeo(frame, W, H);
  const bg = bgOf(frame, W, H);
  const f = cleanFrame(frame)!;

  copy = sized(copy, cw, ch);
  const cx = copy.getContext('2d')!;
  cx.clearRect(0, 0, cw, ch);
  cx.drawImage(layer, 0, 0);

  const x = layer.getContext('2d')!;
  x.save();
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalAlpha = 1;
  x.globalCompositeOperation = 'source-over';
  x.filter = 'none';
  x.clearRect(0, 0, cw, ch);

  if (bg.kind === 'color') {
    x.fillStyle = bg.color;
    x.fillRect(0, 0, cw, ch);
  } else if (bg.kind === 'gradient') {
    const grad = x.createLinearGradient(bg.x0 * k, bg.y0 * k, bg.x1 * k, bg.y1 * k);
    grad.addColorStop(0, bg.from);
    grad.addColorStop(1, bg.to);
    x.fillStyle = grad;
    x.fillRect(0, 0, cw, ch);
  }

  const left = (g.ix - g.bw) * k;
  const top = (g.iy - g.bw) * k;
  const ow = (g.iw + 2 * g.bw) * k;
  const oh = (g.ih + 2 * g.bw) * k;
  const orad = (g.r + g.bw) * k;

  if (g.alpha > 0.004) {
    // The box (with its outline) in black, blurred: a gaussian of the same sigma as the export's gblur.
    shade = sized(shade, cw, ch);
    const sx = shade.getContext('2d')!;
    sx.clearRect(0, 0, cw, ch);
    sx.fillStyle = '#000';
    box(sx, left, top + g.dy * k, ow, oh, orad);
    sx.fill();
    x.filter = `blur(${g.sigma * k}px)`;
    x.globalAlpha = g.alpha;
    x.drawImage(shade, 0, 0);
    x.filter = 'none';
    x.globalAlpha = 1;
  }
  if (g.bw > 0) {
    x.fillStyle = f.borderColor;
    box(x, left, top, ow, oh, orad);
    x.fill();
  }
  box(x, g.ix * k, g.iy * k, g.iw * k, g.ih * k, g.r * k);
  x.clip();
  x.drawImage(copy, g.ix * k, g.iy * k, g.iw * k, g.ih * k);
  x.restore();
}
