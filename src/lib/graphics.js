// Graphics templates (Premiere "Essential Graphics", CapCut text templates, Resolve titles):
// lower third, title, label and progress bar. A template becomes a list of simple events
// (rectangles and texts with move / fade / scale over time). The preview draws the events on the
// canvas (src/engine/graphics.ts) and the export turns the same events into ASS lines for libass
// (electron/render.cjs), so both show the same thing.
//
// Event fields (pixels of the project canvas, times in seconds from the clip start):
//   kind 'rect' | 'text', layer, t0, t1, an (ASS alignment 4/5/7), x0, y0 -> x1, y1 over moveMs,
//   fadeIn / fadeOut (ms), scale {x0, y0, x1, y1, ms} (percent), color, alpha (0..1)
//   rect: w, h          text: text, font, size (line height), box {color, alpha, pad}, shadow {color, alpha, x, y}

export const GRAPHICS = {
  lower: { label: 'Nome (lower third)', title: 'Nome Apelido', subtitle: 'Consultor imobiliário' },
  title: { label: 'Título', title: 'T3 EM LISBOA', subtitle: '' },
  label: { label: 'Etiqueta', title: 'SALA', subtitle: '' },
  progress: { label: 'Barra de progresso', title: '', subtitle: '' },
};
export const GRAPHIC_KINDS = Object.keys(GRAPHICS);

export const GFX_FONT = 'Inter Black';
const DEF = { accent: '#D4AF37', color: '#FFFFFF', dark: '#111111' };

const hexOk = (h) => typeof h === 'string' && /^#[0-9a-fA-F]{6}$/.test(h);

/** Graphic settings with defaults filled in (bad values dropped). */
export function graphicOf(g) {
  const kind = GRAPHICS[g?.kind] ? g.kind : 'title';
  const num = (v, a, b, d) => (Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : d);
  return {
    kind,
    title: typeof g?.title === 'string' ? g.title : GRAPHICS[kind].title,
    subtitle: typeof g?.subtitle === 'string' ? g.subtitle : GRAPHICS[kind].subtitle,
    accent: hexOk(g?.accent) ? g.accent.toUpperCase() : DEF.accent,
    color: hexOk(g?.color) ? g.color.toUpperCase() : DEF.color,
    dark: hexOk(g?.dark) ? g.dark.toUpperCase() : DEF.dark,
    font: typeof g?.font === 'string' && g.font ? g.font : GFX_FONT,
    x: num(g?.x, 0, 1, kind === 'lower' ? 0.07 : 0.5),
    y: num(g?.y, 0, 1, kind === 'lower' ? 0.74 : kind === 'label' ? 0.2 : kind === 'progress' ? 0 : 0.42),
    scale: num(g?.scale, 0.4, 3, 1),
  };
}

/** Events of a graphic clip of length `dur` on a W x H canvas. */
export function graphicEvents(graphic, dur, W, H) {
  const g = graphicOf(graphic);
  const u = (Math.min(W, H) / 1080) * g.scale;
  const ev = [];
  const base = { t0: 0, t1: dur, alpha: 1, fadeIn: 0, fadeOut: 0, moveMs: 0, scale: null };
  const fadeOut = Math.round(Math.min(250, (dur * 1000) / 4));
  if (g.kind === 'lower') {
    const S = 80 * u;
    const S2 = 48 * u;
    const pad = 20 * u;
    const pad2 = 14 * u;
    const gap = 10 * u;
    const barW = 12 * u;
    const X = g.x * W;
    const y = g.y * H;
    const ys = y + S / 2 + pad + gap + pad2 + S2 / 2;
    const top = y - S / 2 - pad;
    const bottom = g.subtitle ? ys + S2 / 2 + pad2 : y + S / 2 + pad;
    const tx = X + barW + 14 * u + pad;
    ev.push({ ...base, kind: 'rect', layer: 20, an: 7, x0: X, y0: top, x1: X, y1: top, w: barW, h: bottom - top, color: g.accent, fadeOut, scale: { x0: 100, y0: 0, x1: 100, y1: 100, ms: 300 } });
    const slide = 70 * u;
    ev.push({ ...base, kind: 'text', layer: 21, an: 4, t0: Math.min(0.12, dur), x0: tx - slide, y0: y, x1: tx, y1: y, moveMs: 350, fadeIn: 300, fadeOut, text: g.title, font: g.font, size: S, color: g.color, box: { color: g.dark, alpha: 0.88, pad } });
    if (g.subtitle)
      ev.push({ ...base, kind: 'text', layer: 22, an: 4, t0: Math.min(0.24, dur), x0: tx - slide, y0: ys, x1: tx, y1: ys, moveMs: 350, fadeIn: 300, fadeOut, text: g.subtitle, font: g.font, size: S2, color: g.dark, box: { color: g.accent, alpha: 1, pad: pad2 } });
  } else if (g.kind === 'title') {
    const S = 120 * u;
    const cx = g.x * W;
    const cy = g.y * H;
    ev.push({ ...base, kind: 'text', layer: 20, an: 5, x0: cx, y0: cy, x1: cx, y1: cy, fadeIn: 250, fadeOut, scale: { x0: 70, y0: 70, x1: 100, y1: 100, ms: 250 }, text: g.title, font: g.font, size: S, color: g.color, shadow: { color: '#000000', alpha: 0.55, x: 5 * u, y: 5 * u } });
    const by = cy + S / 2 + 26 * u;
    ev.push({ ...base, kind: 'rect', layer: 21, an: 5, t0: Math.min(0.15, dur), x0: cx, y0: by, x1: cx, y1: by, w: 320 * u, h: 10 * u, color: g.accent, fadeOut, scale: { x0: 0, y0: 100, x1: 100, y1: 100, ms: 400 } });
    if (g.subtitle) {
      const sy = by + 30 * u + 22 * u;
      ev.push({ ...base, kind: 'text', layer: 22, an: 5, t0: Math.min(0.3, dur), x0: cx, y0: sy + 30 * u, x1: cx, y1: sy, moveMs: 300, fadeIn: 300, fadeOut, text: g.subtitle, font: g.font, size: 44 * u, color: g.accent });
    }
  } else if (g.kind === 'label') {
    const S = 70 * u;
    const cx = g.x * W;
    const cy = g.y * H;
    ev.push({ ...base, kind: 'text', layer: 20, an: 5, x0: cx, y0: cy, x1: cx, y1: cy, fadeIn: 120, fadeOut, scale: { x0: 60, y0: 60, x1: 100, y1: 100, ms: 180 }, text: String(g.title).toUpperCase(), font: g.font, size: S, color: g.dark, box: { color: g.accent, alpha: 1, pad: 22 * u } });
  } else if (g.kind === 'progress') {
    const h = 14 * u;
    const y = Math.min(H - h, g.y * H);
    ev.push({ ...base, kind: 'rect', layer: 20, an: 7, x0: 0, y0: y, x1: 0, y1: y, w: W, h, color: g.accent, scale: { x0: 0, y0: 100, x1: 100, y1: 100, ms: Math.round(dur * 1000) } });
  }
  return ev.filter((e) => e.t1 - e.t0 > 0.01 && (e.kind === 'rect' || String(e.text || '').trim()));
}

/** State of an event `local` seconds after the clip start (linear, like \move, \fad and \t). */
export function eventAt(e, local) {
  if (local < e.t0 || local >= e.t1) return null;
  const ms = (local - e.t0) * 1000;
  const len = (e.t1 - e.t0) * 1000;
  const lin = (a, b, m) => (m > 0 ? a + (b - a) * Math.max(0, Math.min(1, ms / m)) : b);
  let alpha = e.alpha ?? 1;
  if (e.fadeIn > 0 && ms < e.fadeIn) alpha *= ms / e.fadeIn;
  if (e.fadeOut > 0 && ms > len - e.fadeOut) alpha *= Math.max(0, (len - ms) / e.fadeOut);
  return {
    x: lin(e.x0, e.x1, e.moveMs),
    y: lin(e.y0, e.y1, e.moveMs),
    sx: e.scale ? lin(e.scale.x0, e.scale.x1, e.scale.ms) / 100 : 1,
    sy: e.scale ? lin(e.scale.y0, e.scale.y1, e.scale.ms) / 100 : 1,
    alpha,
  };
}
