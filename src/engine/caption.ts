// Caption drawing shared by the preview and the caption gallery. Every effect here has an
// equivalent in the export (electron/render.cjs buildAss), so what you see is what you get.
//
// Effects (style.anim):
//   pop      whole caption scales in (0.86 -> 1, 120 ms)
//   fade     whole caption fades in (150 ms)
//   slide    whole caption slides up and fades in (180 ms)
//   words    words appear as they are spoken
//   bounce   words appear as spoken; the spoken word bounces (1 -> 1.25 -> 1.15)
//   karaoke  each word fills with the highlight colour while it is spoken
//   marker   the spoken word gets a thick marker-pen outline
// Extras: highlight (spoken word colour), glow, shadow, letter spacing.
import type { CaptionStyle, TextLayer, Word } from '../types';
import { USER_FONTS, emphasisLines, keywordOf, layerOf, lineOffset, linePositions, metricsOf, registerMetrics, revealDur, riseAt, roleOrder } from '../lib/emphasis.js';
import type { EmphasisRole, LineOffsets } from '../lib/emphasis.js';

/** Fonts shipped with the app (public/fonts, OFL / Apache). Same files are given to libass on export. */
export const BUNDLED_FONTS: Record<string, string> = {
  Anton: 'Anton-Regular.ttf',
  'Archivo Black': 'ArchivoBlack-Regular.ttf',
  Bangers: 'Bangers-Regular.ttf',
  'Bebas Neue': 'BebasNeue-Regular.ttf',
  'Great Vibes': 'GreatVibes-Regular.ttf',
  'Inter Black': 'Inter-Black.ttf',
  'Lilita One': 'LilitaOne-Regular.ttf',
  'Permanent Marker': 'PermanentMarker-Regular.ttf',
  'Poppins Black': 'Poppins-Black.ttf',
};

let fontsLoading: Promise<void> | null = null;
/** Load the bundled fonts once (resolves when they can be drawn). */
export function loadFonts() {
  fontsLoading ??= Promise.all(
    Object.entries(BUNDLED_FONTS).map(async ([family, file]) => {
      try {
        const f = new FontFace(family, `url(fonts/${file})`);
        document.fonts.add(await f.load());
      } catch {
        /* missing font: the browser falls back */
      }
    }),
  )
    .then(() => loadUserFonts())
    .then(() => undefined);
  return fontsLoading;
}

/** User fonts (installed on this PC, never shipped) that loaded; the others use their fallback. */
const userLoaded = new Set<string>();
async function loadUserFonts() {
  for (const name of Object.keys(USER_FONTS)) {
    try {
      const data = await window.ec?.userFont?.(name);
      if (!data) continue;
      const f = new FontFace(name, data);
      document.fonts.add(await f.load());
      userLoaded.add(name);
    } catch {
      /* not installed: the fallback font is used, same as the export */
    }
  }
}

/** The font actually drawn: a user font that is not installed becomes its bundled fallback. */
export function resolveFont(name: string) {
  const u = USER_FONTS[name];
  return u && !userLoaded.has(name) ? u.fallback : name;
}

// Fonts installed on this PC (font picker): loaded from their file on first use, so the preview
// draws exactly the file the export gives libass, with the same metrics.
const installed = new Set<string>();
const asked = new Set<string>();
const fontListeners = new Set<() => void>();
/** Called when a font finished loading (redraw). Returns the unsubscribe function. */
export function onFontsChanged(cb: () => void) {
  fontListeners.add(cb);
  return () => void fontListeners.delete(cb);
}
let metricsList: Promise<void> | null = null;
/** Make an installed font drawable (no-op for bundled and personal-use fonts). */
export function requestFont(name: string) {
  if (!name || asked.has(name) || BUNDLED_FONTS[name] || USER_FONTS[name] || !window.ec?.fontFile) return;
  asked.add(name);
  metricsList ??= window.ec
    .listFonts()
    .then((l) => l.forEach((f) => f.a && registerMetrics(f.family, { upem: f.upem, a: f.a, d: f.d })))
    .catch(() => undefined);
  void metricsList
    .then(() => window.ec.fontFile(name))
    .then(async (data) => {
      if (!data) return;
      const f = new FontFace(name, data);
      document.fonts.add(await f.load());
      installed.add(name);
      fontListeners.forEach((cb) => cb());
    })
    .catch(() => undefined);
}

export function fontOf(name: string, px: number) {
  if (BUNDLED_FONTS[name] || installed.has(name)) return `${px}px "${name}", "Segoe UI", sans-serif`;
  requestFont(name);
  if (name === 'Arial Black') return `${px}px "Arial Black", "Segoe UI", sans-serif`;
  const weight = /Black/.test(name) ? 900 : /Bold/.test(name) ? 700 : /Semibold/.test(name) ? 600 : 500;
  const family = name.replace(/ (Black|Bold|Semibold)$/, '');
  return `${weight} ${px}px "${family}", "Segoe UI", sans-serif`;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOut = (u: number) => 1 - Math.pow(1 - clamp01(u), 3);

/** Scale of the spoken word in the bounce effect, `a` seconds after it starts. */
export function bounceScale(a: number) {
  if (a < 0) return 1;
  if (a < 0.08) return 1 + 0.25 * (a / 0.08);
  if (a < 0.16) return 1.25 - 0.1 * ((a - 0.08) / 0.08);
  return 1.15;
}

export interface CaptionInput {
  text: string;
  keyword?: number;
  words?: Word[];
  x?: number;
  y?: number;
  size?: number;
  /** Felipe/Marta: offsets of each line (fractions of the frame). */
  lines?: LineOffsets;
}

/**
 * Draw one caption `local` seconds after it starts. `duration` is its length on the timeline.
 * cw/ch: canvas size in pixels.
 */
export function drawCaption(ctx: CanvasRenderingContext2D, c: CaptionInput, st: CaptionStyle, local: number, duration: number, cw: number, ch: number) {
  if (st.emphasis) return drawEmphasis(ctx, c, st, local, duration, cw, ch);
  const anim = st.anim ?? 'pop';
  const up = (x: string) => (st.uppercase ? x.toUpperCase() : x);
  const timed = Boolean(c.words?.length);
  const words = timed ? c.words!.map((w) => ({ ...w, w: up(w.w) })) : [{ w: up(c.text), s: 0, e: duration }];
  let current = -1;
  if (timed) for (let i = 0; i < words.length; i++) if (local >= words[i]!.s) current = i;

  // libass treats the font size as the line height (ascent + descent), not the em size.
  const lineSize = Math.round((c.size ?? st.size) * ch);
  ctx.save();
  ctx.font = fontOf(st.font, lineSize);
  const fm = ctx.measureText('Hg');
  const lh = fm.fontBoundingBoxAscent + fm.fontBoundingBoxDescent;
  const size = lh > 0 ? Math.round((lineSize * lineSize) / lh) : lineSize;
  ctx.font = fontOf(st.font, size);
  ctx.letterSpacing = `${Math.round((st.spacing ?? 0) * ch)}px`;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  // Whole-caption intro.
  let scale = 1;
  let alpha = 1;
  let dy = 0;
  if (anim === 'pop') scale = 0.86 + 0.14 * easeOut(local / 0.12);
  else if (anim === 'fade') alpha = clamp01(local / 0.15);
  else if (anim === 'slide') {
    const u = easeOut(local / 0.18);
    dy = (1 - u) * 0.04 * ch;
    alpha = clamp01(local / 0.18);
  }
  ctx.globalAlpha *= alpha;
  ctx.translate((c.x ?? 0.5) * cw, (c.y ?? st.y) * ch + dy);
  ctx.scale(scale, scale);

  const wordScale = (i: number) => (timed && anim === 'bounce' && i === current ? bounceScale(local - words[i]!.s) : 1);
  const visible = (i: number) => !timed || !(anim === 'words' || anim === 'bounce') || i <= current;
  const space = ctx.measureText(' ').width;
  const widths = words.map((w, i) => ctx.measureText(w.w).width * wordScale(i));
  const total = widths.reduce((a, b) => a + b, 0) + space * (words.length - 1);
  // Wrap into lines that fit 88% of the frame.
  const maxW = cw * 0.88;
  const lines: number[][] = [[]];
  let lw = 0;
  words.forEach((_, i) => {
    const wv = widths[i]!;
    if (lw && lw + space + wv > maxW) {
      lines.push([]);
      lw = 0;
    }
    lines[lines.length - 1]!.push(i);
    lw += (lw ? space : 0) + wv;
  });
  const lineH = size * 1.15;
  if (st.box) {
    const bw = Math.min(total, maxW) + size * 0.7;
    const bh = lines.length * lineH + size * 0.35;
    ctx.fillStyle = st.boxColor ?? 'rgba(0,0,0,0.75)';
    ctx.beginPath();
    ctx.roundRect(-bw / 2, -bh / 2, bw, bh, size * 0.25);
    ctx.fill();
  }
  const outline = st.outline * ch * 2;
  const shadow = (st.shadow ?? st.outline / 2) * ch;
  const shadowColor = st.shadowColor ? st.shadowColor : 'rgba(0,0,0,0.5)';

  lines.forEach((line, li) => {
    const lineWidth = line.reduce((a, i) => a + widths[i]!, 0) + space * (line.length - 1);
    let x = -lineWidth / 2;
    const y = (li - (lines.length - 1) / 2) * lineH;
    for (const i of line) {
      const w = words[i]!;
      const ws = wordScale(i);
      const cx = x + widths[i]! / 2;
      x += widths[i]! + space;
      if (!visible(i)) continue;
      ctx.save();
      ctx.translate(cx, y);
      ctx.scale(ws, ws);
      ctx.textAlign = 'center';
      const spoken = timed && i === current;
      if (st.glow) {
        ctx.shadowColor = st.outlineColor;
        ctx.shadowBlur = size * 0.24;
      } else if (shadow > 0 && !st.box) {
        ctx.shadowColor = shadowColor;
        ctx.shadowOffsetX = shadow;
        ctx.shadowOffsetY = shadow;
      }
      if (anim === 'marker' && spoken) {
        ctx.lineWidth = size * 0.36;
        ctx.strokeStyle = st.marker ?? st.highlight;
        ctx.strokeText(w.w, 0, 0);
      } else if (outline > 0 && !st.box) {
        ctx.lineWidth = outline;
        ctx.strokeStyle = st.outlineColor;
        ctx.strokeText(w.w, 0, 0);
      }
      ctx.shadowColor = 'transparent';
      if (anim === 'karaoke' && timed) {
        // Fill from left to right while the word is spoken (ASS \kf).
        const next = i + 1 < words.length ? words[i + 1]!.s : w.e;
        const p = clamp01((local - w.s) / Math.max(0.01, next - w.s));
        const tw = widths[i]!;
        ctx.fillStyle = st.color;
        ctx.fillText(w.w, 0, 0);
        if (p > 0) {
          ctx.beginPath();
          ctx.rect(-tw / 2, -size, tw * p, size * 2);
          ctx.clip();
          ctx.fillStyle = st.highlight;
          ctx.fillText(w.w, 0, 0);
        }
      } else {
        ctx.fillStyle = spoken && st.highlight !== st.color && anim !== 'marker' ? st.highlight : st.color;
        ctx.fillText(w.w, 0, 0);
      }
      ctx.restore();
    }
  });
  ctx.restore();
}

const rgba = (hex: string, a: number) => {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
};

/**
 * Keyword captions (Felipe, Marta). Mirrors buildAss emphasisEvents in electron/render.cjs:
 * each line is drawn as shadow, glow and fill passes; reveal = karaoke sweep (\kf), rise = \move +
 * ad + 	(lur). Fonts are placed by their win metrics, the ones libass uses.
 */
function drawEmphasis(ctx: CanvasRenderingContext2D, c: CaptionInput, st: CaptionStyle, local: number, duration: number, cw: number, ch: number) {
  const em = st.emphasis!;
  const timed = Boolean(c.words?.length);
  const words: Word[] = timed ? c.words! : c.text.split(/\s+/).filter(Boolean).map((w) => ({ w, s: 0, e: duration }));
  if (!words.length) return;
  const kw = keywordOf(c, words.map((w) => w.w));
  const lines = emphasisLines(words.length, kw, em);
  const pos = linePositions(lines, em);
  const k = c.size ? c.size / st.size : 1;
  const ax = (c.x ?? 0.5) * cw;
  const ay = (c.y ?? st.y) * ch;
  if (em.oneLine) return drawOneLine(ctx, c, em, words, timed, lines, local, ax, ay, cw, ch, ch * k);
  const order = lines.map((_, i) => i).sort((a, b) => roleOrder(em, lines[a]!.role) - roleOrder(em, lines[b]!.role));
  for (const i of order) {
    const line = lines[i]!;
    const L = layerOf(em, line.role);
    const ws = words.slice(line.from, line.to);
    const t0 = ws[0]!.s;
    if (timed && local < t0) continue;
    const up = (w: string) => (L.uppercase ? w.toUpperCase() : w);
    const text = ws.map((w) => up(w.w)).join(' ');
    const off = lineOffset(c.lines, line.role);
    const x = ax + pos[i]!.dx * ch * k + off.x * cw;
    let baseline = ay + pos[i]!.dy * ch * k + off.y * ch;
    let alpha = 1;
    let extraBlur = 0;
    if (L.anim === 'rise') {
      const r = riseAt(local - t0, L.rise);
      baseline += r.dy * ch * k;
      alpha = r.alpha;
      extraBlur = r.blur * ch * k;
    }
    // Reveal: everything left of the frontier of the word being spoken (later words hidden).
    let reveal: { upto: number; frac: number } | null = null;
    if (L.anim === 'reveal' && timed) {
      let cur = 0;
      ws.forEach((w, j) => local >= w.s && (cur = j));
      reveal = { upto: cur, frac: Math.max(0, Math.min(1, (local - ws[cur]!.s) / revealDur(up(ws[cur]!.w)))) };
    }
    drawLayer(ctx, ws.map((w) => up(w.w)), text, L, x, baseline, alpha, extraBlur, reveal, ch * k);
  }
}

interface Seg {
  role: EmphasisRole;
  from: number;
  to: number;
  L: TextLayer;
  font: string;
  S: number;
  emPx: number;
  asc: number;
  desc: number;
  w: number;
  space: number;
}

/** Felipe/Marta one-line layout: each segment in its own font, side by side, on one baseline. */
function oneLineLayout(ctx: CanvasRenderingContext2D, words: Word[], lines: { role: EmphasisRole; from: number; to: number }[], em: NonNullable<CaptionStyle['emphasis']>, unit: number) {
  const segs: Seg[] = lines.map((line) => {
    const L = layerOf(em, line.role);
    const font = resolveFont(L.font);
    const m = metricsOf(font);
    const S = L.size * unit;
    const emPx = (S * m.upem) / (m.a + m.d);
    ctx.font = fontOf(font, emPx);
    ctx.letterSpacing = `${(L.tracking ?? 0) * unit}px`;
    const text = words
      .slice(line.from, line.to)
      .map((w) => (L.uppercase ? w.w.toUpperCase() : w.w))
      .join(' ');
    const sx = L.squeezeX ?? 1;
    return { ...line, L, font, S, emPx, asc: (S * m.a) / (m.a + m.d), desc: (S * m.d) / (m.a + m.d), w: ctx.measureText(text).width * sx, space: ctx.measureText(' ').width * sx };
  });
  const total = segs.reduce((a, s, i) => a + s.w + (i < segs.length - 1 ? s.space : 0), 0);
  return { segs, total };
}

/** Mirrors oneLineEvents in electron/render.cjs (solid colours, the base layer's animation for the whole line). */
function drawOneLine(ctx: CanvasRenderingContext2D, c: CaptionInput, em: NonNullable<CaptionStyle['emphasis']>, words: Word[], timed: boolean, lines: { role: EmphasisRole; from: number; to: number }[], local: number, ax: number, ay: number, cw: number, fh: number, unit: number) {
  if (timed && local < words[0]!.s) return;
  ctx.save();
  const { segs, total } = oneLineLayout(ctx, words, lines, em, unit);
  ctx.restore();
  const off = lineOffset(c.lines, 'base');
  const B = layerOf(em, 'base');
  let baseline = ay + off.y * fh;
  let alpha = 1;
  let extraBlur = 0;
  if (B.anim === 'rise') {
    const r = riseAt(local - words[0]!.s, B.rise);
    baseline += r.dy * unit;
    alpha = r.alpha;
    extraBlur = r.blur * unit;
  }
  // Word being spoken (reveal sweeps across the whole line).
  let cur = words.length - 1;
  let frac = 1;
  if (B.anim === 'reveal' && timed) {
    cur = 0;
    words.forEach((w, j) => local >= w.s && (cur = j));
    const L = segs.find((s) => cur >= s.from && cur < s.to)!.L;
    frac = Math.max(0, Math.min(1, (local - words[cur]!.s) / revealDur(L.uppercase ? words[cur]!.w.toUpperCase() : words[cur]!.w)));
  }
  let x = ax + off.x * cw - total / 2;
  for (const s of segs) {
    const parts = words.slice(s.from, s.to).map((w) => (s.L.uppercase ? w.w.toUpperCase() : w.w));
    const centre = x + s.w / 2;
    x += s.w + s.space;
    if (cur < s.from) continue;
    const reveal = cur >= s.to ? null : { upto: cur - s.from, frac };
    const solid: TextLayer = { ...s.L };
    delete solid.color2;
    delete solid.grad;
    drawLayer(ctx, parts, parts.join(' '), solid, centre, baseline, alpha, extraBlur, reveal, unit);
  }
}

/** Box of one caption line on the canvas (pixels), for picking and dragging it on the viewer. */
export interface CaptionBox {
  role: EmphasisRole | 'all';
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where a caption's lines are drawn (all words, as at the end of the caption). Felipe/Marta: one
 * box per line (top words, keyword, Marta's stack); other styles: one box for the whole caption.
 */
export function captionBoxes(ctx: CanvasRenderingContext2D, c: CaptionInput, st: CaptionStyle, duration: number, cw: number, ch: number): CaptionBox[] {
  const words: Word[] = c.words?.length ? c.words : c.text.split(/\s+/).filter(Boolean).map((w) => ({ w, s: 0, e: duration }));
  if (!words.length) return [];
  ctx.save();
  try {
    if (!st.emphasis) {
      const size = Math.round((c.size ?? st.size) * ch);
      ctx.font = fontOf(st.font, size);
      const text = words.map((w) => (st.uppercase ? w.w.toUpperCase() : w.w)).join(' ');
      const total = ctx.measureText(text).width;
      const maxW = cw * 0.88;
      const rows = Math.max(1, Math.ceil(total / maxW));
      const w = Math.min(total, maxW) + size * 0.4;
      const h = rows * size * 1.15 + size * 0.2;
      return [{ role: 'all', x: (c.x ?? 0.5) * cw - w / 2, y: (c.y ?? st.y) * ch - h / 2, w, h }];
    }
    const em = st.emphasis;
    const kw = keywordOf(c, words.map((w) => w.w));
    const lines = emphasisLines(words.length, kw, em);
    const pos = linePositions(lines, em);
    const k = c.size ? c.size / st.size : 1;
    const unit = ch * k;
    if (em.oneLine) {
      // One line: a single box (it moves with the base line's offset).
      const { segs, total } = oneLineLayout(ctx, words, lines, em, unit);
      const asc = Math.max(...segs.map((s) => s.asc));
      const desc = Math.max(...segs.map((s) => s.desc));
      const off = lineOffset(c.lines, 'base');
      const x = (c.x ?? 0.5) * cw + off.x * cw;
      const baseline = (c.y ?? st.y) * ch + off.y * ch;
      return [{ role: 'base' as const, x: x - total / 2 - 6, y: baseline - asc, w: total + 12, h: asc + desc }];
    }
    return lines.map((line, i) => {
      const L = layerOf(em, line.role);
      const text = words
        .slice(line.from, line.to)
        .map((w) => (L.uppercase ? w.w.toUpperCase() : w.w))
        .join(' ');
      const font = resolveFont(L.font);
      const m = metricsOf(font);
      const S = L.size * unit;
      ctx.font = fontOf(font, (S * m.upem) / (m.a + m.d));
      ctx.letterSpacing = `${(L.tracking ?? 0) * unit}px`;
      const w = ctx.measureText(text).width * (L.squeezeX ?? 1);
      const off = lineOffset(c.lines, line.role);
      const x = (c.x ?? 0.5) * cw + pos[i]!.dx * unit + off.x * cw;
      const baseline = (c.y ?? st.y) * ch + pos[i]!.dy * unit + off.y * ch;
      const top = baseline - (S * m.a) / (m.a + m.d);
      return { role: line.role, x: x - w / 2 - S * 0.08, y: top, w: w + S * 0.16, h: S };
    });
  } finally {
    ctx.restore();
  }
}

function drawLayer(
  ctx: CanvasRenderingContext2D,
  parts: string[],
  text: string,
  L: TextLayer,
  x: number,
  baseline: number,
  alpha: number,
  extraBlur: number,
  reveal: { upto: number; frac: number } | null,
  unit: number,
) {
  const font = resolveFont(L.font);
  const m = metricsOf(font);
  const S = L.size * unit;
  const emPx = (S * m.upem) / (m.a + m.d);
  ctx.save();
  ctx.font = fontOf(font, emPx);
  ctx.letterSpacing = `${(L.tracking ?? 0) * unit}px`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const sx = L.squeezeX ?? 1;
  const width = ctx.measureText(text).width;
  // Reveal frontier in text coordinates (from the left edge).
  let frontier = Infinity;
  if (reveal) {
    const before = parts.slice(0, reveal.upto).join(' ');
    const start = before ? ctx.measureText(before + ' ').width : 0;
    frontier = start + ctx.measureText(parts[reveal.upto]!).width * reveal.frac;
  }
  const top = -(S * m.a) / (m.a + m.d);
  const pass = (fill: string | CanvasGradient, a: number, blur: number, ox: number, oy: number) => {
    if (a <= 0) return;
    ctx.save();
    ctx.translate(x + ox, baseline + oy);
    ctx.scale(sx, 1);
    ctx.translate(-width / 2, 0);
    if (frontier !== Infinity) {
      ctx.beginPath();
      ctx.rect(-1e4, -1e4, 1e4 + frontier, 2e4);
      ctx.clip();
    }
    ctx.globalAlpha *= a;
    if (blur > 0.25) ctx.filter = `blur(${blur}px)`;
    ctx.fillStyle = fill;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  };
  if (L.shadow) pass(rgba(L.shadow.color, 1), L.shadow.alpha * alpha, L.shadow.blur * unit + extraBlur, L.shadow.x * unit, L.shadow.y * unit);
  if (L.glow) pass(rgba(L.glow.color, 1), L.glow.alpha * alpha, L.glow.blur * unit + extraBlur, 0, 0);
  let fill: string | CanvasGradient = L.color;
  if (L.color2 && L.grad) {
    const g = ctx.createLinearGradient(0, top + L.grad[0] * S, 0, top + L.grad[1] * S);
    g.addColorStop(0, L.color);
    g.addColorStop(1, L.color2);
    fill = g;
  }
  pass(fill, (L.alpha ?? 1) * alpha, extraBlur, 0, 0);
  ctx.restore();
}
