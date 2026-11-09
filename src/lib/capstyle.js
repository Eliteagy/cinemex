// Caption styles: the ONE place where a caption's look is worked out, shared by the preview
// (src/engine/player.ts, the gallery), the export (electron/render.cjs) and the style store
// (electron/styles.cjs). Plain ESM so the .cjs files can require() it (Node 24 require(esm)).
//
// A caption's look = its style (a preset from styles.json, a saved style embedded in the project,
// a saved style from the app's store, or the old project.captionStyle 'custom') ⊕ its own
// override (colour, keyword colour, font, keyword font, outline colour).

const HEX = /^#[0-9a-f]{6}$/i;
export const ANIMS = ['pop', 'fade', 'slide', 'words', 'bounce', 'karaoke', 'marker'];
export const OVERRIDE_KEYS = ['color', 'highlight', 'outlineColor', 'font', 'keywordColor', 'keywordFont', 'layout', 'lineGap', 'textAnim', 'keywordAnim'];
const LAYER_ANIMS = ['reveal', 'rise', 'none'];
/** Id the old project-level style ('custom', "O meu estilo") is migrated to. */
export const MY_STYLE_ID = 'o-meu-estilo';

const isHex = (v) => typeof v === 'string' && HEX.test(v);
const hex = (v) => (isHex(v) ? v.toUpperCase() : undefined);
const isFont = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 80 && !/[\u0000-\u001f{}\\,]/.test(v);
const num = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : undefined);
export const isStyleId = (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,47}$/i.test(id);

/** Keep only valid override fields; undefined when nothing is left. */
export function cleanOverride(o) {
  if (!o || typeof o !== 'object') return undefined;
  const out = {};
  for (const k of ['color', 'highlight', 'outlineColor', 'keywordColor']) if (isHex(o[k])) out[k] = o[k].toUpperCase();
  for (const k of ['font', 'keywordFont']) if (isFont(o[k])) out[k] = o[k].trim();
  if (o.layout === 'line' || o.layout === 'stack') out.layout = o.layout;
  if (num(o.lineGap, 0.3, 3) !== undefined && Math.abs(o.lineGap - 1) > 1e-3) out.lineGap = Math.round(num(o.lineGap, 0.3, 3) * 1000) / 1000;
  for (const k of ['textAnim', 'keywordAnim']) if (LAYER_ANIMS.includes(o[k])) out[k] = o[k];
  return Object.keys(out).length ? out : undefined;
}

/**
 * Style ⊕ override. Text colour and font also drive the base words of keyword styles (Felipe,
 * Marta); the keyword colour/font drive their keyword (a chosen colour replaces the gradient).
 * The highlight colour doubles as the keyword colour when no keyword colour is given.
 */
export function applyOverride(st, o) {
  if (!st || !o) return st;
  const out = { ...st };
  if (o.color) out.color = o.color;
  if (o.highlight) out.highlight = o.highlight;
  if (o.outlineColor) out.outlineColor = o.outlineColor;
  if (o.font) out.font = o.font;
  if (st.emphasis) {
    const em = { ...st.emphasis };
    const solid = (layer, colour) => {
      const l = { ...layer, color: colour };
      delete l.color2;
      delete l.grad;
      return l;
    };
    for (const role of ['base', 'rest']) {
      if (!em[role]) continue;
      if (o.color) em[role] = solid(em[role], o.color);
      if (o.font) em[role] = { ...em[role], font: o.font };
    }
    const kc = o.keywordColor || o.highlight;
    if (kc) em.keyword = solid(em.keyword, kc);
    if (o.keywordFont) em.keyword = { ...em.keyword, font: o.keywordFont };
    // Layout: one line or stacked, the space between lines, and how each layer comes in.
    if (o.layout) em.oneLine = o.layout === 'line';
    if (o.lineGap) {
      em.pitch = (em.pitch ?? 0.05) * o.lineGap;
      if (em.slots) em.slots = Object.fromEntries(Object.entries(em.slots).map(([r, v]) => [r, { dx: v.dx, dy: v.dy * o.lineGap }]));
    }
    const withAnim = (layer, anim) => (layer ? { ...layer, anim, ...(anim === 'rise' && !layer.rise ? { rise: { dist: 0.015, dur: 0.15, blur: 0 } } : {}) } : layer);
    if (o.textAnim) {
      em.base = withAnim(em.base, o.textAnim);
      if (em.rest) em.rest = withAnim(em.rest, o.textAnim);
    }
    if (o.keywordAnim) em.keyword = withAnim(em.keyword, o.keywordAnim);
    out.emphasis = em;
  }
  return out;
}

/** Base style of a caption (without its override). */
export function baseStyleOf(clip, project, presets, userStyles) {
  const name = clip?.style || 'elite';
  if (name === 'custom' && project?.captionStyle) return project.captionStyle;
  return project?.styles?.[name] || userStyles?.[name] || (name !== '_comment' && presets[name]) || presets.elite;
}

/** The look a caption is drawn and exported with. */
export function resolveCaptionStyle(clip, project, presets, userStyles) {
  return applyOverride(baseStyleOf(clip, project, presets, userStyles), cleanOverride(clip?.override));
}

/** The fonts a style draws with (the base font and every keyword-layer font). */
export function fontsOf(st) {
  const set = new Set();
  if (!st) return [];
  if (st.emphasis) for (const r of ['base', 'keyword', 'rest']) st.emphasis[r]?.font && set.add(st.emphasis[r].font);
  else if (st.font) set.add(st.font);
  return [...set];
}

function cleanLayer(l) {
  if (!l || typeof l !== 'object' || !isFont(l.font) || !isHex(l.color) || num(l.size, 0.005, 0.5) === undefined) return null;
  const out = { font: l.font, size: num(l.size, 0.005, 0.5), color: hex(l.color) };
  if (isHex(l.color2) && Array.isArray(l.grad) && l.grad.length === 2 && l.grad.every((g) => typeof g === 'number')) {
    out.color2 = hex(l.color2);
    out.grad = [num(l.grad[0], -1, 2), num(l.grad[1], -1, 2)];
  }
  for (const [k, lo, hi] of [['alpha', 0, 1], ['squeezeX', 0.3, 2], ['tracking', -0.05, 0.05]]) if (num(l[k], lo, hi) !== undefined) out[k] = num(l[k], lo, hi);
  if (l.glow && isHex(l.glow.color)) out.glow = { color: hex(l.glow.color), alpha: num(l.glow.alpha, 0, 1) ?? 0.3, blur: num(l.glow.blur, 0, 0.05) ?? 0.004 };
  if (l.shadow && isHex(l.shadow.color))
    out.shadow = { color: hex(l.shadow.color), alpha: num(l.shadow.alpha, 0, 1) ?? 0.4, blur: num(l.shadow.blur, 0, 0.05) ?? 0.003, x: num(l.shadow.x, -0.05, 0.05) ?? 0, y: num(l.shadow.y, -0.05, 0.05) ?? 0.002 };
  if (['reveal', 'rise', 'none'].includes(l.anim)) out.anim = l.anim;
  if (l.rise && typeof l.rise === 'object') out.rise = { dist: num(l.rise.dist, 0, 0.2) ?? 0.015, dur: num(l.rise.dur, 0, 2) ?? 0.15, blur: num(l.rise.blur, 0, 0.05) ?? 0 };
  if (typeof l.uppercase === 'boolean') out.uppercase = l.uppercase;
  return out;
}

function cleanEmphasis(e) {
  if (!e || typeof e !== 'object' || !['rows', 'slots'].includes(e.mode)) return null;
  const base = cleanLayer(e.base);
  const keyword = cleanLayer(e.keyword);
  if (!base || !keyword) return null;
  const out = { mode: e.mode, base, keyword };
  const rest = cleanLayer(e.rest);
  if (rest) out.rest = rest;
  if (num(e.pitch, 0, 0.5) !== undefined) out.pitch = num(e.pitch, 0, 0.5);
  if (typeof e.kwOnTop === 'boolean') out.kwOnTop = e.kwOnTop;
  if (e.oneLine === true) out.oneLine = true;
  if (num(e.maxWords, 1, 12) !== undefined) out.maxWords = Math.round(num(e.maxWords, 1, 12));
  if (num(e.maxChars, 1, 80) !== undefined) out.maxChars = Math.round(num(e.maxChars, 1, 80));
  if (e.slots && typeof e.slots === 'object') {
    out.slots = {};
    for (const r of ['base', 'kw', 'rest']) {
      const s = e.slots[r];
      if (s && typeof s.dx === 'number' && typeof s.dy === 'number') out.slots[r] = { dx: num(s.dx, -1, 1), dy: num(s.dy, -1, 1) };
    }
  }
  return out;
}

/** A caption style read from disk, a project or Claude: every field checked; null if unusable. */
export function validateStyle(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isFont(raw.font) || !isHex(raw.color) || num(raw.size, 0.005, 0.4) === undefined) return null;
  const st = {
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 60) : 'Estilo',
    font: raw.font.trim(),
    size: num(raw.size, 0.005, 0.4),
    color: hex(raw.color),
    highlight: hex(raw.highlight) ?? hex(raw.color),
    outline: num(raw.outline, 0, 0.05) ?? 0,
    outlineColor: hex(raw.outlineColor) ?? '#000000',
    box: raw.box === true,
    uppercase: raw.uppercase === true,
    y: num(raw.y, 0, 1) ?? 0.7,
  };
  if (hex(raw.boxColor)) st.boxColor = hex(raw.boxColor);
  if (ANIMS.includes(raw.anim)) st.anim = raw.anim;
  if (raw.glow === true) st.glow = true;
  if (num(raw.shadow, 0, 0.05) !== undefined) st.shadow = num(raw.shadow, 0, 0.05);
  if (hex(raw.shadowColor)) st.shadowColor = hex(raw.shadowColor);
  if (hex(raw.marker)) st.marker = hex(raw.marker);
  if (num(raw.spacing, 0, 0.05) !== undefined) st.spacing = num(raw.spacing, 0, 0.05);
  if (raw.emphasis !== undefined) {
    const em = cleanEmphasis(raw.emphasis);
    if (em) st.emphasis = em;
  }
  return st;
}

/** The saved-styles file (caption-styles.json): bad entries are dropped, never trusted. */
export function validateStore(json) {
  const out = { version: 1, styles: {} };
  const styles = json && typeof json === 'object' && json.styles && typeof json.styles === 'object' ? json.styles : {};
  let n = 0;
  for (const [id, raw] of Object.entries(styles)) {
    if (n >= 200 || !isStyleId(id)) continue;
    const st = validateStyle(raw);
    if (st) {
      out.styles[id] = st;
      n++;
    }
  }
  return out;
}

/** Id for a new saved style, from its name (unique among `taken`). */
export function styleIdFor(label, taken) {
  const base =
    String(label || 'estilo')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'estilo';
  let id = `u-${base}`;
  for (let i = 2; taken.has(id); i++) id = `u-${base}-${i}`;
  return id;
}
