// Emphasis captions (the Felipe and Marta styles): each caption block has one keyword drawn in a
// second font, colour and position, apart from the base words. Plain ESM shared by the preview
// (src/engine/caption.ts), the export (electron/render.cjs) and the grouping (electron/captions.cjs),
// so the three always agree on which word is the keyword and where each line goes.
//
// Units: sizes, offsets, blur and tracking are fractions of the frame height. `size` is the libass
// font size (line height = winAscent + winDescent), positions are baselines.

/** Portuguese (and a few English) words that are never picked as the keyword. */
export const STOP_WORDS = new Set(
  `a o as os um uma uns umas e é de do da dos das em no na nos nas para pra por com que se me te
  você vocês eu tu ele ela eles elas já aqui ali lá mais muito muita esse essa esses essas este esta estes estas
  isso isto aquilo ao aos à às mas porém porque não sim ainda também tem têm temos tenho vai vou vamos pode
  podem seu sua seus suas meu minha meus minhas teu tua nosso nossa onde como quem quando qual agora então bom
  dele dela sobre só mesmo assim além disso todo toda todos todas sem nesse nessa desse dessa deixa seria há
  acho vem conta pouco outro outra veio está estão estou era foi ser ter fazer faz pelo pela pelos pelas num numa
  lhe nos vos the and of to in is it you that this for with`.split(/\s+/).filter(Boolean),
);

/** The word without punctuation (keeps letters, digits, apostrophes and inner hyphens). */
export function cleanWord(w) {
  return String(w).replace(/[^\p{L}\p{N}'’-]/gu, '').replace(/^-+|-+$/g, '');
}

/** Index of the keyword: the longest content word (more than 2 letters, not a stop-word), or -1. */
export function pickKeyword(words) {
  let best = -1;
  let len = 0;
  words.forEach((w, i) => {
    const c = cleanWord(w);
    if (c.length > 2 && c.length > len && !STOP_WORDS.has(c.toLowerCase())) {
      best = i;
      len = c.length;
    }
  });
  return best;
}

/** Keyword of a caption clip: the clip's own choice (`keyword`, -1 = none) or the automatic one. */
export function keywordOf(clip, words) {
  if (Number.isInteger(clip.keyword)) return clip.keyword >= 0 && clip.keyword < words.length ? clip.keyword : -1;
  return pickKeyword(words);
}

/**
 * Split a block of `n` words into lines. role: 'base' (main words), 'kw' (the keyword, alone on its
 * line) or 'rest' (Marta's stack). `to` is exclusive.
 */
export function emphasisLines(n, kw, em) {
  const lines = [];
  const add = (role, from, to) => to > from && lines.push({ role, from, to });
  if (kw >= 0 && kw < n) {
    add('base', 0, kw);
    add('kw', kw, kw + 1);
    add(em.mode === 'slots' ? 'rest' : 'base', kw + 1, n);
  } else if (em.mode === 'slots') {
    const cut = Math.max(1, Math.floor(n / 2));
    add('base', 0, cut);
    add('rest', cut, n);
  } else add('base', 0, n);
  return lines;
}

/**
 * Where each line goes, relative to the caption anchor (x centre, first baseline), in fractions of
 * the frame height, before the caption's size factor `k` is applied.
 * rows (Felipe): lines stack from the anchor with a fixed pitch; a keyword alone sits on row 2.
 * slots (Marta): each role has its own place.
 */
export function linePositions(lines, em) {
  if (em.mode === 'slots') return lines.map((l) => ({ dx: em.slots?.[l.role]?.dx ?? 0, dy: em.slots?.[l.role]?.dy ?? 0 }));
  const lone = lines.length === 1 && lines[0].role === 'kw';
  return lines.map((_, i) => ({ dx: 0, dy: (lone ? 1 : i) * (em.pitch ?? 0.05) }));
}

/** Roles a caption line can have; each one can be moved on its own (clip.lines). */
export const LINE_ROLES = ['base', 'kw', 'rest'];

/**
 * A caption's own line offsets, checked: { base|kw|rest: { x, y } } in fractions of the frame
 * (x of the width, y of the height), each clamped to -1..1. Undefined when nothing is moved.
 */
export function cleanLines(l) {
  if (!l || typeof l !== 'object') return undefined;
  const out = {};
  for (const r of LINE_ROLES) {
    const o = l[r];
    if (!o || typeof o !== 'object') continue;
    const x = Number.isFinite(o.x) ? Math.max(-1, Math.min(1, Math.round(o.x * 10000) / 10000)) : 0;
    const y = Number.isFinite(o.y) ? Math.max(-1, Math.min(1, Math.round(o.y * 10000) / 10000)) : 0;
    if (x || y) out[r] = { x, y };
  }
  return Object.keys(out).length ? out : undefined;
}

/** Offset of one line of a caption (0, 0 when it was not moved). */
export function lineOffset(lines, role) {
  const o = lines?.[role];
  return { x: Number.isFinite(o?.x) ? o.x : 0, y: Number.isFinite(o?.y) ? o.y : 0 };
}

/** Text layer style of a role (the stack falls back to the base look). */
export function layerOf(em, role) {
  return role === 'kw' ? em.keyword : role === 'rest' ? em.rest ?? em.base : em.base;
}

/** Draw order: the keyword sits under the base words (as on Marta's Resolve tracks) unless kwOnTop. */
export function roleOrder(em, role) {
  return role === 'kw' ? (em.kwOnTop ? 3 : 0) : role === 'base' ? 1 : 2;
}

/** Vertical font metrics (win ascent/descent, the ones libass uses for the line height). */
export const FONT_METRICS = {
  'Inter Black': { upem: 2048, a: 2269, d: 660 },
  'Great Vibes': { upem: 1000, a: 851, d: 401 },
  'Birds of Paradise': { upem: 1000, a: 1001, d: 335 },
};
const DEFAULT_METRICS = { upem: 1000, a: 900, d: 250 };
export const metricsOf = (font) => FONT_METRICS[font] ?? DEFAULT_METRICS;

/** Fonts that live on the user's PC (never in the repo) and the bundled font used when they are missing. */
export const USER_FONTS = {
  'Birds of Paradise': { file: /^birds\s*of\s*paradise.*\.(ttf|otf)$/i, fallback: 'Great Vibes' },
};

/** Letters per second of the left-to-right reveal (Felipe: 4.7 letters per frame at 29.97). */
export const REVEAL_RATE = 140;
/** Reveal time of one word, rounded to centiseconds like the ASS \kf tag. */
export function revealDur(word) {
  return Math.max(1, Math.round((String(word).length * 100) / REVEAL_RATE)) / 100;
}

/** Rise intro `local` seconds after the line appears: offset down, extra blur and opacity (all linear, like \move, \t and \fad). */
export function riseAt(local, rise) {
  const dur = Math.max(0.01, rise?.dur ?? 0.15);
  const u = Math.max(0, Math.min(1, local / dur));
  return { dy: (1 - u) * (rise?.dist ?? 0), blur: (1 - u) * (rise?.blur ?? 0), alpha: u };
}

/** #RRGGBB between two colours. */
export function mixHex(a, b, t) {
  const p = (h) => [0, 2, 4].map((i) => parseInt(String(h).replace('#', '').slice(i, i + 2), 16) || 0);
  const x = p(a);
  const y = p(b);
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Metrics of a font read from its file (installed fonts), so preview and export place it the same. */
export function registerMetrics(font, m) {
  if (font && m && m.upem > 0 && m.a > 0 && m.d >= 0 && !FONT_METRICS[font]) FONT_METRICS[font] = { upem: m.upem, a: m.a, d: m.d };
}
