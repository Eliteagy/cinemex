// "Short editado" touches that follow the big words of a caption model (src/lib/capmodels.js):
// zoom punches and sound effects on the strongest moments, a progress bar and a closing call to
// action. Pure functions shared by the shorts builder (electron/shorts.cjs), the timeline action
// (src/actions.ts polishEdit) and the edit packs.

const r3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Moments to hit: start times of the big words (timeline seconds), at least `minGap` apart (a punch
 * every ~4 s reads as edited; every 2 s feels busy), never
 * in the first `skip` seconds (the hook card is there) nor in the last `tail` seconds (CTA).
 * Accent-coloured words (override colour) come first when two are close.
 */
export function beatsFromCaptions(back, { minGap = 4, skip = 0.6, tail = 0, duration = Infinity } = {}) {
  const list = (back || [])
    .filter((c) => c && Number.isFinite(c.start) && c.start >= skip && c.start <= duration - tail)
    .map((c) => ({ t: c.start, strong: Boolean(c.override?.color) || String(c.text || '').length >= 7 }))
    .sort((a, b) => a.t - b.t);
  const out = [];
  for (const b of list) {
    const last = out[out.length - 1];
    if (!last || b.t - last.t >= minGap) out.push(b);
    else if (b.strong && !last.strong && b.t - (out[out.length - 2]?.t ?? -Infinity) >= minGap) out[out.length - 1] = b;
  }
  return out.map((b) => r3(b.t));
}

/**
 * Zoom keyframes (clip-local seconds) for punches at `beats` (timeline seconds): 1 -> 1+amount in
 * `up` s (fast, apple_out), hold a moment, back to 1 in `down` s. Punches that would overlap are
 * dropped. `base` = the clip's zoom outside the punches.
 */
export function punchKeyframes(beats, clip, { amount = 0.12, up = 0.12, hold = 0.25, down = 0.5, base = 1 } = {}) {
  const len = (clip.out - clip.in) / (clip.speed || 1);
  const keys = [];
  let free = 0;
  for (const bt of beats || []) {
    const t = bt - clip.start;
    if (t < free || t + up + hold + down > len) continue;
    keys.push({ t: r3(Math.max(0, t - 0.01)), v: base, ease: 'apple_out' });
    keys.push({ t: r3(t + up), v: r3(base + amount), ease: 'smooth' });
    keys.push({ t: r3(t + up + hold), v: r3(base + amount), ease: 'easy' });
    keys.push({ t: r3(t + up + hold + down), v: base });
    free = t + up + hold + down + 0.05;
  }
  return keys;
}

/** Sound effects for the beats: a whoosh on the first, then pops (every `every`-th beat), -18 dB (0.12) so they sit under the voice. */
export function sfxPlan(beats, { every = 1, first = 'whoosh', rest = 'pop', volume = 0.12 } = {}) {
  return (beats || []).filter((_, i) => i % Math.max(1, every) === 0).map((at, i) => ({ id: i === 0 ? first : rest, at: r3(at), volume }));
}

/** Progress bar along the whole short (graphic clip body, top of the frame). */
export function progressClip(duration, { color = '#FFFFFF', y = 0.004 } = {}) {
  return { start: 0, in: 0, out: r3(duration), text: '', graphic: { kind: 'progress', title: '', subtitle: '', y, color } };
}

/** Call to action at the end (graphic clip body), `len` s long, low in the frame. */
export function ctaClip(text, duration, { len = 2.5, y = 0.8, kind = 'reveal' } = {}) {
  const t = String(text || '').trim().slice(0, 80);
  if (!t) return null;
  const l = Math.min(len, Math.max(1, duration / 3));
  return { start: r3(Math.max(0, duration - l)), in: 0, out: r3(l), text: t, graphic: { kind, title: t, subtitle: '', y } };
}

/** Music clips covering `len` s (the track repeats when shorter), fading out at the end. */
export function musicClips(track, len, { volume = 0.16, fade = 1.5, mediaId } = {}) {
  const out = [];
  const d = Math.max(1, track.duration || len);
  for (let t = 0; t < len - 0.05; t += d) {
    const piece = Math.min(d, len - t);
    out.push({ mediaId, start: Math.round(t * 1000) / 1000, in: 0, out: Math.round(piece * 1000) / 1000, volume, speed: 1 });
  }
  if (out.length) out[out.length - 1].transitionOut = { type: 'fade', d: Math.min(fade, out[out.length - 1].out) };
  return out;
}

/** Mood from what is said (no AI): exclamation and intensity words -> forte, soft words -> calma. */
export function moodFromText(text) {
  const s = String(text || '').toLowerCase();
  const strong = (s.match(/!|nunca|sempre|agora|dinheiro|rico|riqueza|ganhar|perder|guerra|ataca|luta|medo/g) || []).length;
  const soft = (s.match(/casa|família|familia|lar|calma|paz|amor|sonho|tranquil|conforto/g) || []).length;
  return strong >= soft + 3 ? 'forte' : soft > strong ? 'calma' : 'media';
}

