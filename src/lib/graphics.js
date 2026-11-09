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
//   scaleAccel           libass \t accel of the scale (u^accel: below 1 starts fast and lands softly)
//   clip {from, to, ms, accel}   visible window [left, top, right, bottom] in canvas pixels, animated (\clip + \t)
//   colors [[ms, '#RRGGBB'], ...] fill colour keys, linear between them (\1c + \t)
//   glass: x1, y1 (centre), w, h, radius, blur (sigma, px), tint {color, alpha}, border {color, alpha, width}
//          the picture under the card is blurred (export: crop + gblur + rounded alpha before the captions)
//
// The Apple templates (headline, reveal, glass) copy techniques of apple.com product pages: headlines
// with a gradient that sweeps across the letters (background-clip:text + background-position), copy
// revealed through a moving mask (clip-path), and frosted glass cards (backdrop-filter). Their timing
// uses apple.com's cubic-bezier curves (src/lib/anim.js CURVES).

import { CURVES, bezierAt } from './anim.js';

export const GRAPHICS = {
  lower: { label: 'Nome (lower third)', title: 'Nome Apelido', subtitle: 'Consultor imobiliário' },
  title: { label: 'Título', title: 'T3 EM LISBOA', subtitle: '' },
  label: { label: 'Etiqueta', title: 'SALA', subtitle: '' },
  progress: { label: 'Barra de progresso', title: '', subtitle: '' },
  headline: { label: 'Título gradiente (Apple)', title: 'Feito para criar.', subtitle: '' },
  reveal: { label: 'Revelação (Apple)', title: 'Pequeno. Gigante.', subtitle: 'Agora mais rápido do que nunca.' },
  glass: { label: 'Cartão de vidro (Apple)', title: 'T3 em Lisboa', subtitle: 'Vista rio · 145 m²' },
};
export const GRAPHIC_KINDS = Object.keys(GRAPHICS);

export const GFX_FONT = 'Inter Black';

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** Mix of two #RRGGBB colours (k = 0 -> a, 1 -> b). */
export function mixColor(a, b, k) {
  const x = hexRgb(a);
  const y = hexRgb(b);
  const t = Math.max(0, Math.min(1, k));
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
}
/** Colour at ms of a colour-key list (linear between keys, like successive \t(\1c)). */
export function colorAt(keys, ms) {
  if (!keys || !keys.length) return null;
  if (ms <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [m1, c1] = keys[i];
    const [m0, c0] = keys[i - 1];
    if (ms < m1) return mixColor(c0, c1, (ms - m0) / Math.max(1, m1 - m0));
  }
  return keys[keys.length - 1][1];
}
/** Gradient sweep (apple.com headlines): strips of the text, each with its own colour over time. */
export const SWEEP = { strips: 40, samples: 12, delayMs: 150, ms: 1600, span: 0.92, travel: 1.45 };
function sweepColors(stops, final, xn) {
  const out = [];
  for (let j = 0; j < SWEEP.samples; j++) {
    const p = j / (SWEEP.samples - 1);
    const v = xn - SWEEP.travel * bezierAt(CURVES.apple, p);
    let c;
    if (v < 0) c = mixColor(stops[0], final, -v / 0.3);
    else {
      const f = Math.min(1, v) * (stops.length - 1);
      const i = Math.min(stops.length - 2, Math.floor(f));
      c = mixColor(stops[i], stops[i + 1], f - i);
    }
    out.push([Math.round(SWEEP.delayMs + p * SWEEP.ms), c]);
  }
  return out;
}
/** Rounded rectangle as an ASS drawing (origin top-left). */
export function roundRectPath(w, h, r) {
  const R = Math.max(0, Math.min(r, w / 2, h / 2));
  const k = R * 0.4477;
  const n = (v) => String(Math.round(v * 10) / 10);
  return `m ${n(R)} 0 l ${n(w - R)} 0 b ${n(w - k)} 0 ${n(w)} ${n(k)} ${n(w)} ${n(R)} l ${n(w)} ${n(h - R)} b ${n(w)} ${n(h - k)} ${n(w - k)} ${n(h)} ${n(w - R)} ${n(h)} l ${n(R)} ${n(h)} b ${n(k)} ${n(h)} 0 ${n(h - k)} 0 ${n(h - R)} l 0 ${n(R)} b 0 ${n(k)} ${n(k)} 0 ${n(R)} 0`;
}
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
  } else if (g.kind === 'headline') {
    // Gradient that sweeps across the letters, then settles on the text colour; soft scale-in.
    const S = 150 * u;
    const cx = g.x * W;
    const cy = g.y * H;
    const stops = [mixColor(g.accent, '#000000', 0.45), g.accent, mixColor(g.accent, '#FFFFFF', 0.45), g.color];
    const x0 = cx - (SWEEP.span * W) / 2;
    const sw = (SWEEP.span * W) / SWEEP.strips;
    const look = { an: 5, x0: cx, y0: cy, x1: cx, y1: cy, fadeIn: 450, fadeOut, scale: { x0: 92, y0: 92, x1: 100, y1: 100, ms: 1000 }, scaleAccel: 0.35, text: g.title, font: g.font, size: S, color: g.color };
    for (let i = 0; i < SWEEP.strips; i++) {
      // Strips overlap by a pixel so no seam shows between them.
      const box = [x0 + i * sw - 0.5, 0, x0 + (i + 1) * sw + 0.5, H];
      ev.push({ ...base, ...look, kind: 'text', layer: 20, clip: { from: box, to: box, ms: 0, accel: 1 }, colors: sweepColors(stops, g.color, (i + 0.5) / SWEEP.strips) });
    }
    if (g.subtitle) {
      const S2 = 48 * u;
      const sy = cy + S / 2 + S2;
      ev.push({ ...base, kind: 'text', layer: 21, an: 5, t0: Math.min(0.5, dur), x0: cx, y0: sy + 0.3 * S2, x1: cx, y1: sy, moveMs: 600, fadeIn: 400, fadeOut, text: g.subtitle, font: g.font, size: S2, color: mixColor(g.color, g.accent, 0.35) });
    }
  } else if (g.kind === 'reveal') {
    // Each line rises out of a mask that opens upwards (clip-path reveal), one after the other.
    const S = 110 * u;
    const S2 = 50 * u;
    const cx = g.x * W;
    const cy = g.y * H;
    const lines = [{ text: g.title, size: S, y: cy, color: g.color, t0: 0 }];
    if (g.subtitle) lines.push({ text: g.subtitle, size: S2, y: cy + S / 2 + S2 * 0.95, color: g.accent, t0: 0.22 });
    lines.forEach((L, i) => {
      const top = L.y - L.size * 0.62;
      const bottom = L.y + L.size * 0.62;
      ev.push({ ...base, kind: 'text', layer: 20 + i, an: 5, t0: Math.min(L.t0, dur), x0: cx, y0: L.y + L.size * 0.45, x1: cx, y1: L.y, moveMs: 650, fadeIn: 250, fadeOut, text: L.text, font: g.font, size: L.size, color: L.color, clip: { from: [0, bottom, W, bottom], to: [0, top, W, bottom], ms: 700, accel: 0.4 } });
    });
  } else if (g.kind === 'glass') {
    // Frosted glass card (backdrop-filter): the picture under it is blurred and lightly tinted.
    const S = 72 * u;
    const S2 = 40 * u;
    const padX = 60 * u;
    const padY = 44 * u;
    const gap = g.subtitle ? 16 * u : 0;
    const est = Math.max(String(g.title).length * 0.6 * S, g.subtitle ? String(g.subtitle).length * 0.52 * S2 : 0);
    const w = Math.round(Math.min(W * 0.94, Math.max(360 * u, est + 2 * padX)) / 2) * 2;
    const h = Math.round((padY * 2 + S + (g.subtitle ? gap + S2 : 0)) / 2) * 2;
    const cx = g.x * W;
    const cy = g.y * H;
    ev.push({ ...base, kind: 'glass', layer: 19, an: 5, x0: cx, y0: cy, x1: cx, y1: cy, fadeIn: 400, fadeOut, w, h, radius: 34 * u, blur: 28 * u, color: '#FFFFFF', alpha: 1, tint: { color: g.dark, alpha: 0.3 }, border: { color: '#FFFFFF', alpha: 0.3, width: 2 * u } });
    const ty = cy - h / 2 + padY + S / 2;
    ev.push({ ...base, kind: 'text', layer: 21, an: 5, t0: Math.min(0.15, dur), x0: cx, y0: ty + 18 * u, x1: cx, y1: ty, moveMs: 450, fadeIn: 400, fadeOut, text: g.title, font: g.font, size: S, color: g.color });
    if (g.subtitle) {
      const sy = ty + S / 2 + gap + S2 / 2;
      ev.push({ ...base, kind: 'text', layer: 22, an: 5, t0: Math.min(0.28, dur), x0: cx, y0: sy + 14 * u, x1: cx, y1: sy, moveMs: 450, fadeIn: 400, fadeOut, text: g.subtitle, font: g.font, size: S2, color: mixColor(g.color, g.dark, 0.22) });
    }
  }
  return ev.filter((e) => e.t1 - e.t0 > 0.01 && (e.kind !== 'text' || String(e.text || '').trim()));
}

/** State of an event `local` seconds after the clip start (linear, like \move, \fad and \t). */
export function eventAt(e, local) {
  if (local < e.t0 || local >= e.t1) return null;
  const ms = (local - e.t0) * 1000;
  const len = (e.t1 - e.t0) * 1000;
  const lin = (a, b, m, acc = 1) => (m > 0 ? a + (b - a) * Math.pow(Math.max(0, Math.min(1, ms / m)), acc) : b);
  let alpha = e.alpha ?? 1;
  if (e.fadeIn > 0 && ms < e.fadeIn) alpha *= ms / e.fadeIn;
  if (e.fadeOut > 0 && ms > len - e.fadeOut) alpha *= Math.max(0, (len - ms) / e.fadeOut);
  return {
    x: lin(e.x0, e.x1, e.moveMs),
    y: lin(e.y0, e.y1, e.moveMs),
    sx: e.scale ? lin(e.scale.x0, e.scale.x1, e.scale.ms, e.scaleAccel ?? 1) / 100 : 1,
    sy: e.scale ? lin(e.scale.y0, e.scale.y1, e.scale.ms, e.scaleAccel ?? 1) / 100 : 1,
    alpha,
    // \clip window (canvas pixels) and fill colour at this time.
    clip: e.clip ? e.clip.from.map((v, i) => lin(v, e.clip.to[i], e.clip.ms, e.clip.accel ?? 1)) : null,
    color: e.colors ? colorAt(e.colors, ms) : e.color,
  };
}
