// Preview of graphic clips: draws the events of src/lib/graphics.js the way libass draws the
// export's ASS lines (line height = font size, opaque box = text advance x line height + padding).
import type { Graphic } from '../types';
import { eventAt, graphicEvents } from '../lib/graphics.js';
import type { GfxEvent } from '../lib/graphics.js';
import { metricsOf } from '../lib/emphasis.js';
import { fontOf, resolveFont } from './caption';

const rgba = (hex: string, a: number) => {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
};

/** Draw a graphic clip `local` seconds after it starts on a cw x ch canvas (project W x H). */
export function drawGraphic(ctx: CanvasRenderingContext2D, g: Graphic, local: number, duration: number, W: number, H: number, cw: number, _ch: number) {
  const k = cw / W;
  const events = [...graphicEvents(g, duration, W, H)].sort((a, b) => a.layer - b.layer);
  for (const e of events) {
    const s = eventAt(e, local);
    if (!s || s.alpha <= 0.001 || s.sx <= 0.0001 || s.sy <= 0.0001) continue;
    ctx.save();
    ctx.scale(k, k);
    ctx.translate(s.x, s.y);
    ctx.scale(s.sx, s.sy);
    ctx.globalAlpha = s.alpha;
    if (e.kind === 'rect') drawRect(ctx, e);
    else drawText(ctx, e);
    ctx.restore();
  }
}

function drawRect(ctx: CanvasRenderingContext2D, e: GfxEvent) {
  const w = Math.round(e.w ?? 0);
  const h = Math.round(e.h ?? 0);
  // \an7: (x, y) is the top-left corner; \an5: the centre.
  const ox = e.an === 7 ? 0 : -w / 2;
  const oy = e.an === 7 ? 0 : -h / 2;
  ctx.fillStyle = rgba(e.color, 1);
  ctx.fillRect(ox, oy, w, h);
}

function drawText(ctx: CanvasRenderingContext2D, e: GfxEvent) {
  const font = resolveFont(e.font ?? 'Inter Black');
  const m = metricsOf(font);
  const S = e.size ?? 40;
  ctx.font = fontOf(font, (S * m.upem) / (m.a + m.d));
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const text = e.text ?? '';
  const width = ctx.measureText(text).width;
  // \an4: left edge at x; \an5: centred. Vertical centre of the line box at y.
  const left = e.an === 4 ? 0 : -width / 2;
  const baseline = (S * m.a) / (m.a + m.d) - S / 2;
  if (e.box) {
    const p = e.box.pad;
    ctx.fillStyle = rgba(e.box.color, e.box.alpha);
    ctx.fillRect(left - p, -S / 2 - p, width + 2 * p, S + 2 * p);
  } else if (e.shadow) {
    ctx.fillStyle = rgba(e.shadow.color, e.shadow.alpha);
    ctx.fillText(text, left + e.shadow.x, baseline + e.shadow.y);
  }
  ctx.fillStyle = rgba(e.color, 1);
  ctx.fillText(text, left, baseline);
}
