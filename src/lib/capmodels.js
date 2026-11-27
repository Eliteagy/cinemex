// Caption models ("Modelos de legendas"): a whole caption look, not just a style. A model says how
// the words of each caption block are split between big text BEHIND the person (cut out by a person
// "front" mask) and small text IN FRONT of them, and with which fonts, colours and sizes. Used by the
// Shorts panel (electron/shorts.cjs), by "Aplicar modelo" on the timeline (src/aiActions.ts) and by
// the MCP tools. The Gui's own models are saved in userData/caption-models.json (electron/capmodels.cjs)
// and always pass through validateModel, so a hand-edited file cannot inject anything.
//
// Kinds:
//   atras-frente  main word big behind the head, the other words small on the chest (Vitor)
//   gigante       one word at a time, every word big behind the head, nothing in front
//   duas-linhas   the block in two big lines behind the person (top line bigger), magazine cover
// accent: words in the accent colour (numbers, money, %, a word list) - "Atrás com cor".
import { cleanWord, metricsOf, pickKeyword } from './emphasis.js';

export const MODEL_KINDS = ['atras-frente', 'gigante', 'duas-linhas'];
export const BACK_STYLE = 'atras-grande';
export const FRONT_STYLE = 'frente-peito';

const ACCENT_WORDS = ['vendido', 'vendida', 'vendidos', 'casa', 'casas', 'dinheiro', 'euros', 'milhões', 'mil', 'grátis', 'hoje', 'agora', 'nunca', 'sempre', 'riqueza', 'rico', 'lucro', 'investimento', 'imóvel', 'moradia', 'apartamento'];

export const BUILTIN_MODELS = {
  vitor: {
    label: 'Atrás + frente (Vitor)',
    kind: 'atras-frente',
    maxWords: 3,
    back: { font: 'Inter Black', color: '#FFFFFF', width: 0.85, maxSize: 0.2, lift: 0.55 },
    front: { font: 'Inter Bold', color: '#FFFFFF', size: 0.05, drop: 2.6 },
  },
  'atras-cor': {
    label: 'Atrás com cor',
    kind: 'atras-frente',
    maxWords: 3,
    back: { font: 'Inter Black', color: '#FFFFFF', width: 0.85, maxSize: 0.2, lift: 0.55 },
    front: { font: 'Inter Bold', color: '#FFFFFF', size: 0.05, drop: 2.6 },
    accent: { color: '#D4AF37', numbers: true, words: ACCENT_WORDS },
  },
  gigante: {
    label: 'Palavra gigante só atrás',
    kind: 'gigante',
    maxWords: 1,
    back: { font: 'Inter Black', color: '#FFFFFF', width: 0.9, maxSize: 0.26, lift: 0.45 },
  },
  'duas-linhas': {
    label: 'Duas linhas atrás',
    kind: 'duas-linhas',
    maxWords: 4,
    back: { font: 'Inter Black', color: '#FFFFFF', width: 0.88, maxSize: 0.17, lift: 0.5 },
  },
};

const HEX = /^#[0-9A-F]{6}$/i;
const clamp = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
const r3 = (n) => Math.round(n * 1000) / 1000;
const hex = (v, d) => (typeof v === 'string' && HEX.test(v) ? v.toUpperCase() : d);
// Font names end up in the ASS file: letters, digits, spaces and a few signs only.
const font = (v, d) => (typeof v === 'string' && /^[\p{L}\p{N} ._&'-]{1,64}$/u.test(v.trim()) ? v.trim() : d);

/** A clean model (or null): every field clamped, unknown fields dropped. */
export function validateModel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = MODEL_KINDS.includes(raw.kind) ? raw.kind : null;
  if (!kind) return null;
  const label = String(raw.label ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || 'O meu modelo';
  const b = raw.back || {};
  const out = {
    label,
    kind,
    maxWords: Math.round(clamp(raw.maxWords, 1, 5, kind === 'gigante' ? 1 : kind === 'duas-linhas' ? 4 : 3)),
    back: {
      font: font(b.font, 'Inter Black'),
      color: hex(b.color, '#FFFFFF'),
      width: r3(clamp(b.width, 0.4, 0.98, 0.85)),
      maxSize: r3(clamp(b.maxSize, 0.06, 0.32, 0.2)),
      lift: r3(clamp(b.lift, -1, 2, 0.55)),
    },
  };
  if (kind === 'gigante') out.maxWords = 1;
  if (kind === 'atras-frente') {
    const f = raw.front || {};
    out.front = { font: font(f.font, 'Inter Bold'), color: hex(f.color, '#FFFFFF'), size: r3(clamp(f.size, 0.025, 0.1, 0.05)), drop: r3(clamp(f.drop, 1, 6, 2.6)) };
  }
  if (raw.accent && typeof raw.accent === 'object') {
    const a = raw.accent;
    const words = Array.isArray(a.words) ? [...new Set(a.words.map((w) => cleanWord(String(w)).toLowerCase()).filter((w) => w && w.length <= 30))].slice(0, 100) : [];
    if (HEX.test(a.color ?? '') && (a.numbers || words.length)) out.accent = { color: a.color.toUpperCase(), numbers: Boolean(a.numbers), words };
  }
  return out;
}

/** Store file content -> { version, models } with only valid models and safe ids. */
export function validateModelStore(raw) {
  const models = {};
  const src = raw && typeof raw === 'object' && raw.models && typeof raw.models === 'object' ? raw.models : {};
  for (const [id, m] of Object.entries(src)) {
    if (!isModelId(id) || BUILTIN_MODELS[id]) continue;
    const v = validateModel(m);
    if (v) models[id] = v;
  }
  return { version: 1, models };
}

export const isModelId = (id) => typeof id === 'string' && /^u-[a-z0-9][a-z0-9-]{0,40}$/.test(id);

/** New id for a saved model from its name: u-<slug>, unique among `taken`. */
export function modelIdFor(label, taken = new Set()) {
  const base =
    'u-' +
    (String(label || 'modelo')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'modelo');
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

/** Is this word an accent word of the model? */
export function isAccent(word, accent) {
  if (!accent) return false;
  const w = String(word);
  if (accent.numbers && /\d|€|%|\$/.test(w)) return true;
  return accent.words.includes(cleanWord(w).toLowerCase());
}

/**
 * Size (libass line height, fraction of the frame height) that makes `text` span `width` of the
 * frame. Capitals of heavy grotesques average ~0.70 em; 0.74 leaves a margin.
 */
export function fitSize(text, font, width, maxSize, W, H) {
  const m = metricsOf(font);
  const emPerSize = m.upem / (m.a + m.d);
  const n = Math.max(4, [...String(text)].length);
  return r3(Math.max(0.05, Math.min(maxSize, (width * W) / (0.74 * emPerSize * n * H))));
}

/**
 * Caption clips for a model. `groups` = caption blocks from captionClipsFor (start, out, text,
 * words with block-local times), W/H = canvas, face = { y, h } of the speaker's face (fractions of
 * the height) or null. Returns { back, front } clip bodies without ids (tracks: behind / in front).
 */
export function modelCaptions(model, groups, W, H, face) {
  const m = validateModel(model);
  if (!m) throw new Error('Modelo de legendas inválido');
  const fy = face?.y > 0.05 && face.y < 0.85 ? face.y : 0.3;
  const fh = face?.h > 0.01 && face.h < 0.4 ? face.h : 0.07;
  const headTop = fy - fh * m.back.lift;
  const back = [];
  const front = [];
  const backClip = (text, start, out, size, y, words) => {
    const accent = m.accent && words.some((w) => isAccent(w.w, m.accent));
    const color = accent ? m.accent.color : m.back.color;
    const override = { ...(m.back.font !== 'Inter Black' ? { font: m.back.font } : {}), ...(color !== '#FFFFFF' ? { color, highlight: color } : {}) };
    return { text, style: BACK_STYLE, start, in: 0, out, size, y: r3(Math.max(size * 0.55, y)), words: [{ w: text, s: 0, e: out }], ...(Object.keys(override).length ? { override } : {}) };
  };
  for (const g of groups) {
    const ws = g.words?.length ? g.words : String(g.text).split(/\s+/).filter(Boolean).map((w) => ({ w, s: 0, e: g.out }));
    if (!ws.length) continue;
    if (m.kind === 'duas-linhas' && ws.length > 1) {
      // Top line = first half (bigger), bottom line = second half, both behind the person.
      const cut = Math.ceil(ws.length / 2);
      const top = ws.slice(0, cut).map((w) => cleanWord(w.w)).join(' ').toUpperCase();
      const bot = ws.slice(cut).map((w) => cleanWord(w.w)).join(' ').toUpperCase();
      const s1 = fitSize(top, m.back.font, m.back.width, m.back.maxSize, W, H);
      const s2 = Math.min(fitSize(bot, m.back.font, m.back.width, m.back.maxSize * 0.8, W, H), s1 * 0.85);
      const y2 = headTop;
      const y1 = y2 - (s1 + s2) * 0.5;
      back.push(backClip(top, g.start, g.out, s1, y1, ws.slice(0, cut)));
      back.push(backClip(bot, g.start, g.out, r3(s2), y2, ws.slice(cut)));
      continue;
    }
    const k = m.kind === 'atras-frente' ? pickKeyword(ws.map((w) => w.w)) : 0;
    if (k >= 0) {
      const text = (m.kind === 'atras-frente' ? cleanWord(ws[k].w) : ws.map((w) => cleanWord(w.w)).join(' ')).toUpperCase();
      if (text) back.push(backClip(text, g.start, g.out, fitSize(text, m.back.font, m.back.width, m.back.maxSize, W, H), headTop, m.kind === 'atras-frente' ? [ws[k]] : ws));
    }
    if (m.kind !== 'atras-frente') continue;
    const rest = ws.filter((_, i) => i !== k);
    if (!rest.length) continue;
    const f = m.front;
    const override = { ...(f.font !== 'Inter Bold' ? { font: f.font } : {}), ...(f.color !== '#FFFFFF' ? { color: f.color, highlight: f.color } : {}) };
    front.push({ text: rest.map((w) => w.w).join(' '), style: FRONT_STYLE, start: g.start, in: 0, out: g.out, size: f.size, y: r3(Math.min(0.85, fy + Math.max(fh * f.drop, 0.09))), words: rest, ...(Object.keys(override).length ? { override } : {}) });
  }
  return { back, front };
}

/** Grouping options for captionClipsFor that suit the model. */
export const groupingFor = (model) => ({ style: FRONT_STYLE, stripPunct: true, maxWords: validateModel(model)?.maxWords ?? 3 });
