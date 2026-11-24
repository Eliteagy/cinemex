// Caption animations: the numbers behind every effect, in ONE place, shared by the preview
// (src/engine/caption.ts) and the export (electron/render.cjs buildAss, ASS/libass). Plain ESM so
// the .cjs files can require() it. Everything here is linear in time, because ASS \t, \move and
// \fade are linear: the preview then draws exactly what libass draws.
//
// Three kinds of effect:
//  - intros: the whole caption comes in (scale, move, fade, blur) during `dur` ms;
//  - steps: the whole caption jumps through a fixed table (shake, glitch), one ASS event per step;
//  - word effects: per word, as it is spoken (words, bounce, karaoke, marker, colorsweep,
//    scaleword, popin) or letter by letter (typewriter).

/** Every effect, with its PT-PT name (style editor, gallery). */
export const ANIM_LABELS = {
  pop: 'Pop',
  fade: 'Aparecer',
  slide: 'Deslizar',
  words: 'Palavra a palavra',
  bounce: 'Salto',
  karaoke: 'Karaoke',
  marker: 'Marcador',
  typewriter: 'Máquina de escrever',
  blur: 'Desfocado',
  zoom: 'Zoom',
  flip: 'Virar',
  stretch: 'Esticar',
  drop: 'Cair',
  rise: 'Subir',
  shake: 'Tremer',
  glitch: 'Glitch',
  colorsweep: 'Cor a cor',
  scaleword: 'Palavra grande',
  popin: 'Palavra a saltar',
};

/**
 * Whole-caption intros. dur: ms. sx/sy: scale from -> 1. dy: start offset (fraction of the frame
 * height, + = below) -> 0. fade: ms of alpha 0 -> 1. blur: start blur (fraction of the font
 * size) -> 0. bord: the outline grows in with the blur (libass blurs the outline, not the fill,
 * when there is one: the outline starts at 0 so the letters themselves are blurred).
 */
export const INTROS = {
  pop: { dur: 120, sx: 0.86, sy: 0.86 },
  fade: { dur: 150, fade: 150 },
  slide: { dur: 180, dy: 0.04, fade: 180 },
  zoom: { dur: 200, sx: 1.6, sy: 1.6, fade: 200 },
  flip: { dur: 220, sy: 0 },
  stretch: { dur: 240, sx: 1.6, sy: 0.5, fade: 150 },
  drop: { dur: 220, dy: -0.08, fade: 150 },
  rise: { dur: 320, dy: 0.06, fade: 320, blur: 0.12, bord: true },
  blur: { dur: 300, fade: 200, blur: 0.2, bord: true },
};

/** Stepped effects: the caption jumps every `step` ms (offsets: fractions of the frame height). */
export const STEPS = {
  shake: {
    step: 40,
    dx: [0.012, -0.011, 0.009, -0.007, 0.005, -0.003, 0.002, -0.001],
    dy: [-0.004, 0.005, -0.004, 0.003, -0.002, 0.002, -0.001, 0],
  },
  glitch: {
    step: 50,
    dx: [0.014, -0.018, 0.01, -0.008, 0.004, 0],
    dy: [0, 0.003, -0.002, 0, 0.001, 0],
    flash: ['#00F0FF', '#FF2D75', null, '#00F0FF', null, null],
  },
};

/** Word effects: popin (the spoken word grows in) and scaleword (the spoken word grows). */
export const POPIN = { from: 0.4, dur: 0.12 };
export const SCALEWORD = { to: 1.25, dur: 0.1 };
/** Typewriter: seconds per letter at most; an untimed caption is typed during this part of its length. */
export const TYPE = { rate: 0.04, min: 0.01, untimed: 0.7 };

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, u) => a + (b - a) * u;

/** Effects in which a word only shows once it is spoken. */
export const hidesWords = (anim) => anim === 'words' || anim === 'bounce' || anim === 'popin';

/** State of the whole-caption intro `t` seconds after the caption starts. */
export function introAt(anim, t) {
  const I = INTROS[anim];
  if (!I) return { sx: 1, sy: 1, dy: 0, alpha: 1, blur: 0, bord: 1 };
  const u = clamp01((t * 1000) / I.dur);
  return {
    sx: lerp(I.sx ?? 1, 1, u),
    sy: lerp(I.sy ?? 1, 1, u),
    dy: lerp(I.dy ?? 0, 0, u),
    alpha: I.fade ? clamp01((t * 1000) / I.fade) : 1,
    blur: lerp(I.blur ?? 0, 0, u),
    bord: I.bord ? u : 1,
  };
}

/** Offset and colour flash of a stepped effect `t` seconds after the caption starts. */
export function stepAt(anim, t) {
  const S = STEPS[anim];
  if (!S || t < 0) return { dx: 0, dy: 0, flash: null };
  const i = Math.floor((t * 1000 + 1e-6) / S.step);
  if (i >= S.dx.length) return { dx: 0, dy: 0, flash: null };
  return { dx: S.dx[i], dy: S.dy[i] ?? 0, flash: S.flash?.[i] ?? null };
}

/** Times (s from the caption start) where a stepped effect changes. */
export function stepTimes(anim) {
  const S = STEPS[anim];
  if (!S) return [];
  return S.dx.map((_, i) => i * S.step / 1000).concat(S.dx.length * S.step / 1000);
}

const letters = (w) => Array.from(String(w));

/** Seconds per letter of word i (typed before the next word starts). */
export function typeRate(words, i) {
  const w = words[i];
  const next = i + 1 < words.length ? words[i + 1].s : w.e;
  const n = Math.max(1, letters(w.w).length);
  return Math.min(TYPE.rate, Math.max(TYPE.min, (next - w.s) / n));
}

/** How many letters of word i are typed `t` seconds after the caption starts. */
export function typedChars(words, i, t) {
  const w = words[i];
  if (t < w.s - 1e-6) return 0;
  const n = letters(w.w).length;
  return Math.min(n, Math.floor((t - w.s) / typeRate(words, i) + 1e-6) + 1);
}

/** Times (s from the caption start) where a letter appears. */
export function typeTimes(words) {
  const out = [];
  words.forEach((w, i) => {
    const r = typeRate(words, i);
    const n = letters(w.w).length;
    for (let k = 0; k < n; k++) out.push(w.s + k * r);
  });
  return out;
}

/** Scale of a word `a` seconds after it is spoken (popin, scaleword); 1 otherwise. */
export function wordScaleAt(anim, a) {
  if (anim === 'popin') return a < 0 ? POPIN.from : lerp(POPIN.from, 1, clamp01(a / POPIN.dur));
  if (anim === 'scaleword') return a < 0 ? 1 : lerp(1, SCALEWORD.to, clamp01(a / SCALEWORD.dur));
  return 1;
}

// ------------------------------------------------------------------ ASS (export)

const n2 = (v) => String(Math.round(v * 100) / 100);

/**
 * ASS tags of the intro for an event that starts `o` ms after the caption (the remaining part of
 * the animation, from where it is at `o`, so a caption split into several events keeps moving).
 * x, y: anchor in pixels; H: frame height; size: font size in px; bord: outline px; glowBlur: px.
 */
export function introAss(anim, o, { x, y, H, size, bord, glowBlur = 0 }) {
  const I = INTROS[anim];
  const out = { pos: `\\pos(${x},${y})`, fade: '', scale: '\\fscx100\\fscy100', bord: `\\bord${bord}`, blur: glowBlur ? `\\blur${glowBlur}` : '' };
  if (!I || o >= I.dur) return out;
  const s = introAt(anim, o / 1000);
  const rest = Math.round(I.dur - o);
  if (I.dy) {
    const y0 = Math.round(y + s.dy * H);
    out.pos = `\\move(${x},${y0},${x},${y},0,${rest})`;
  }
  if (I.fade && o < I.fade) {
    const a = Math.round(255 * (1 - s.alpha));
    const r = Math.round(I.fade - o);
    out.fade = `\\fade(${a},0,0,0,${r},${r},${r})`;
  }
  if (I.sx !== undefined || I.sy !== undefined) out.scale = `\\fscx${n2(s.sx * 100)}\\fscy${n2(s.sy * 100)}\\t(0,${rest},\\fscx100\\fscy100)`;
  if (I.bord) out.bord = `\\bord${n2(bord * s.bord)}\\t(0,${rest},\\bord${bord})`;
  if (I.blur) out.blur = `\\blur${n2(Math.max(glowBlur, s.blur * size))}\\t(0,${rest},\\blur${glowBlur})`;
  return out;
}

/** ASS tags of a word's own scale (popin, scaleword) for an event starting `a` s after the word. */
export function wordScaleAss(anim, a) {
  const W = anim === 'popin' ? { from: POPIN.from, to: 1, dur: POPIN.dur } : anim === 'scaleword' ? { from: 1, to: SCALEWORD.to, dur: SCALEWORD.dur } : null;
  if (!W) return '';
  const v = wordScaleAt(anim, a) * 100;
  if (a >= W.dur) return `\\fscx${n2(v)}\\fscy${n2(v)}`;
  const rest = Math.round((W.dur - a) * 1000);
  return `\\fscx${n2(v)}\\fscy${n2(v)}\\t(0,${rest},\\fscx${n2(W.to * 100)}\\fscy${n2(W.to * 100)})`;
}
