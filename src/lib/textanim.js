// Text animator (After Effects range selector): the letters (or words) of a caption come in one after the
// other, each from a starting look (opacity, vertical scale, blur, colour) to the style's look.
// The export writes ONE ASS event with an override block per unit (\alpha, \fscy, \blur, \1c animated with
// \t(t1, t2, accel, ...)); the preview draws each unit with the same timing (src/engine/caption.ts).

export const TEXT_ANIM_PRESETS = {
  typewriter: { label: 'Máquina de escrever', anim: { unit: 'char', stagger: 0.035, dur: 0.01, accel: 1, from: { opacity: 0 } } },
  fade: { label: 'Letra a letra (fade)', anim: { unit: 'char', stagger: 0.03, dur: 0.25, accel: 1, from: { opacity: 0 } } },
  rise: { label: 'Letras a crescer', anim: { unit: 'char', stagger: 0.03, dur: 0.22, accel: 0.6, from: { opacity: 0, scaleY: 0 } } },
  blur: { label: 'Desfocado → nítido', anim: { unit: 'char', stagger: 0.025, dur: 0.3, accel: 0.7, from: { opacity: 0, blur: 0.012 } } },
  words: { label: 'Palavra a palavra', anim: { unit: 'word', stagger: 0.12, dur: 0.2, accel: 0.7, from: { opacity: 0, scaleY: 0.4 } } },
  color: { label: 'Cor a varrer', anim: { unit: 'char', stagger: 0.03, dur: 0.15, accel: 1, from: { color: '#D4AF37' } } },
};

/** Split a caption into animated units: { text, i } for letters/words and { text, i: -1 } for spaces. */
export function units(text, unit) {
  const out = [];
  let i = 0;
  if (unit === 'word') {
    for (const part of String(text).split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) out.push({ text: part, i: -1 });
      else out.push({ text: part, i: i++ });
    }
  } else {
    for (const ch of Array.from(String(text))) {
      if (/\s/.test(ch)) out.push({ text: ch, i: -1 });
      else out.push({ text: ch, i: i++ });
    }
  }
  return out;
}

/** Progress 0..1 of unit i at time t (seconds from the caption start), like libass \t with accel. */
export function unitProgress(a, i, t) {
  const t1 = i * Math.max(0, a.stagger || 0);
  const d = Math.max(0.01, a.dur || 0.2);
  const u = Math.max(0, Math.min(1, (t - t1) / d));
  return Math.pow(u, Math.max(0.05, a.accel ?? 1));
}

/** Look of a unit at progress p: opacity, vertical scale, blur (fraction of frame height), colour mix 0..1. */
export function unitLook(a, p) {
  const f = a.from || {};
  return {
    opacity: f.opacity !== undefined ? f.opacity + (1 - f.opacity) * p : 1,
    scaleY: f.scaleY !== undefined ? f.scaleY + (1 - f.scaleY) * p : 1,
    blur: f.blur !== undefined ? f.blur * (1 - p) : 0,
    colorMix: f.color ? 1 - p : 0,
  };
}
