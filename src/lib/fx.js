// Transitions and motion shared by the preview (src/engine/player.ts) and the export
// (electron/render.cjs). One source of numbers, so what plays is what renders.
//
// Transition types (clip.transitionIn / transitionOut):
//   fade   opacity (shows what is underneath)           Premiere "Cross Dissolve"
//   slide  pushes in from the right / out to the left     CapCut "Slide"
//   whip   fast push with horizontal motion blur          CapCut "Whip", Resolve "Smooth Cut" feel
//   zoom   zoom-through: the frame rushes in, with blur   CapCut "Zoom in"
//   spin   rotates in/out with blur                       CapCut "Spin"
//   flash  white flash                                    Premiere "Dip to White"
//   dip    black dip (covers what is underneath)          Premiere "Dip to Black"
//   blur   defocus in/out                                 Resolve "Blur Dissolve"
//   bflash Brightness Flash: the picture itself blows out to white at the cut (lift 0.67, gain 1.83,
//          sine curve mirrored on the cut), Resolve's Fusion transition the Gui uses on every passage

export const TRANSITIONS = {
  fade: { label: 'Fade', blur: 0 },
  slide: { label: 'Slide', blur: 0 },
  whip: { label: 'Whip', blur: 0.06, dir: true },
  zoom: { label: 'Zoom', blur: 0.012, zoom: 0.6 },
  spin: { label: 'Spin', blur: 0.01, spin: 180, zoom: 0.25 },
  flash: { label: 'Flash', blur: 0 },
  dip: { label: 'Preto', blur: 0 },
  blur: { label: 'Desfocar', blur: 0.03 },
  bflash: { label: 'Brightness Flash', blur: 0 },
};
/** Brightness Flash numbers (Resolve macro BrightnessFlash: Input1 lift, Input2 gain). */
export const BFLASH = { lift: 0.67, gain: 0.83 };
/** Strength of the Brightness Flash at progress u (0 = at the cut, 1 = window edge): sine, 1 at the cut. */
export const bflashS = (u) => 0.5 - 0.5 * Math.cos(Math.PI * (1 - Math.max(0, Math.min(1, u))));
export const TRANSITION_TYPES = Object.keys(TRANSITIONS);

/** Blur steps: the export switches N blur stages on and off in time (gblur has no time
 *  expression), so the preview uses the same staircase. */
export const BLUR_STEPS = 3;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
export const smooth = (u) => u * u * (3 - 2 * u);
/** Inverse of smooth on 0..1 (bisection). */
export function smoothInv(y) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (smooth(m) < y) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

/** How much of the transition is left (1 = start of an in / end of an out, 0 = clip fully shown). */
export function transitionAmount(clip, local, dur) {
  const out = [];
  const tin = clip.transitionIn;
  const tout = clip.transitionOut;
  if (tin && tin.d > 0 && local < tin.d) out.push({ side: 'in', type: tin.type, d: tin.d, u: clamp01(local / tin.d) });
  if (tout && tout.d > 0 && local > dur - tout.d) out.push({ side: 'out', type: tout.type, d: tout.d, u: clamp01((dur - local) / tout.d) });
  return out;
}

/** Number of blur stages on at progress u (0 = full transition, 1 = done). */
export function blurStages(u) {
  const a = 1 - smooth(clamp01(u));
  let n = 0;
  for (let k = 0; k < BLUR_STEPS; k++) if (a > k / BLUR_STEPS + 1e-9) n++;
  return n;
}

/**
 * Local times (seconds from the clip start) where blur stage k (0-based) is on, for one side.
 * In: [0, until); out: [from, dur).
 */
export function blurWindow(side, d, dur, k) {
  // Stage k is on while a = 1 - smooth(u) > k/N, i.e. u < smoothInv(1 - k/N).
  const uMax = smoothInv(1 - k / BLUR_STEPS);
  return side === 'in' ? [0, uMax * d] : [dur - uMax * d, dur];
}

/**
 * Everything a clip's transitions do at local time t: opacity, horizontal offset (fraction of the
 * width), extra zoom factor, rotation (degrees), white/black cover (0..1) and blur (fraction of the
 * frame's shorter side, already combined over the stages; dir = horizontal only).
 */
export function transitionState(clip, local, dur) {
  const st = { alpha: 1, slide: 0, zoom: 1, rotate: 0, white: 0, black: 0, blur: 0, blurDir: false, bright: 0 };
  for (const s of transitionAmount(clip, local, dur)) {
    const T = TRANSITIONS[s.type] || TRANSITIONS.fade;
    const e = smooth(s.u);
    const left = 1 - e;
    const sign = s.side === 'in' ? 1 : -1;
    switch (s.type) {
      case 'fade':
        st.alpha *= e;
        break;
      case 'slide':
        st.slide += sign * left;
        break;
      case 'whip':
        st.slide += sign * left;
        st.blurDir = true;
        break;
      case 'zoom':
        st.zoom *= 1 + T.zoom * left;
        break;
      case 'spin':
        st.rotate += sign * T.spin * left;
        st.zoom *= 1 + T.zoom * left;
        break;
      case 'flash':
        // Linear, like ffmpeg's fade filter.
        st.white = Math.max(st.white, 1 - s.u);
        break;
      case 'dip':
        st.black = Math.max(st.black, 1 - s.u);
        break;
      case 'bflash':
        st.bright = Math.max(st.bright, bflashS(s.u));
        break;
      default:
        break;
    }
    if (T.blur > 0) {
      const n = blurStages(s.u);
      st.blur = Math.max(st.blur, T.blur * Math.sqrt(n / BLUR_STEPS));
    }
  }
  return st;
}

/** Gaussian sigma of one blur stage (pixels), so N stages together give the full blur. */
export function stageSigma(type, short) {
  const T = TRANSITIONS[type] || TRANSITIONS.fade;
  return (T.blur * short) / Math.sqrt(BLUR_STEPS);
}

// ------------------------------------------------------------------ motion presets

/** Deterministic pseudo-random numbers (same shake every time for the same clip). */
function rng(seed) {
  let s = 0;
  for (const ch of String(seed)) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const r3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Keyframes of a motion preset over a clip of length d (seconds). Presets: zoom_in, zoom_out,
 * ken_burns, punch, shake (handheld camera, CapCut "Shake"), pulse (zoom beat every 0.5 s),
 * spin_in (rotates into place), fade_in_out (opacity).
 */
export function motionPreset(preset, d, seed = 'x', opts = {}) {
  d = r3(d);
  switch (preset) {
    case 'zoom_in':
      return { zoom: [{ t: 0, v: 1 }, { t: d, v: 1.25 }] };
    case 'zoom_out':
      return { zoom: [{ t: 0, v: 1.25 }, { t: d, v: 1 }] };
    case 'ken_burns':
      return { zoom: [{ t: 0, v: 1.1 }, { t: d, v: 1.3 }], x: [{ t: 0, v: -0.06 }, { t: d, v: 0.06 }] };
    case 'punch':
      return { zoom: [{ t: 0, v: 1 }, { t: Math.min(0.15, d), v: 1.18 }, { t: d, v: 1.18 }] };
    case 'shake': {
      const amp = opts.amount ?? 0.012;
      const step = 1 / 12;
      const rand = rng(seed);
      const x = [];
      const y = [];
      const n = Math.min(300, Math.floor(d / step));
      for (let i = 0; i <= n; i++) {
        const t = r3(Math.min(d, i * step));
        x.push({ t, v: r3((rand() * 2 - 1) * amp) });
        y.push({ t, v: r3((rand() * 2 - 1) * amp) });
      }
      // The frame must be zoomed in to have room to move.
      return { zoom: [{ t: 0, v: r3(1 + amp * 6) }], x, y };
    }
    case 'pulse': {
      const every = opts.every ?? 0.5;
      const amt = opts.amount ?? 0.08;
      return { zoom: pulseKeys(Array.from({ length: Math.floor(d / every) + 1 }, (_, i) => i * every), d, amt) };
    }
    case 'spin_in':
      return { rotate: [{ t: 0, v: -90 }, { t: Math.min(0.4, d), v: 0 }], zoom: [{ t: 0, v: 1.6 }, { t: Math.min(0.4, d), v: 1 }] };
    case 'fade_in_out': {
      const f = Math.min(0.4, d / 3);
      return { opacity: [{ t: 0, v: 0 }, { t: r3(f), v: 1 }, { t: r3(d - f), v: 1 }, { t: d, v: 0 }] };
    }
    default:
      return null;
  }
}
export const MOTION_PRESETS = ['zoom_in', 'zoom_out', 'ken_burns', 'punch', 'shake', 'pulse', 'spin_in', 'fade_in_out'];

/** Zoom keyframes that kick up on each beat time (local seconds) and settle back. */
export function pulseKeys(beats, d, amount = 0.08, base = 1) {
  const keys = [];
  const list = beats.filter((b) => b >= 0 && b < d).sort((a, b) => a - b);
  for (const b of list) {
    const last = keys[keys.length - 1];
    if (last && b - last.t < 0.12) continue;
    if (b > 0.02) keys.push({ t: r3(Math.max(0, b - 0.01)), v: base });
    keys.push({ t: r3(b), v: r3(base + amount) });
    keys.push({ t: r3(Math.min(d, b + 0.18)), v: base });
  }
  // Keep times strictly increasing.
  const out = [];
  for (const k of keys) if (!out.length || k.t > out[out.length - 1].t + 0.005) out.push(k);
  return out.length ? out : [{ t: 0, v: base }];
}

// ------------------------------------------------------------------ beats

/**
 * Beat times (seconds, source time of the file) from waveform peaks (100 per second, 0-255):
 * onset strength = rise of a short energy envelope; peaks above an adaptive threshold, at least
 * minGap apart. Good for music with a clear kick (CapCut "Beats", Premiere "Beat Edit").
 */
export function detectBeats(peaks, { rate = 100, minGap = 0.28, sensitivity = 1 } = {}) {
  const n = peaks.length;
  if (n < rate) return [];
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) env[i] = (peaks[i] / 255) ** 2;
  // Onset = positive difference of a 30 ms smoothed envelope.
  const sm = new Float32Array(n);
  let acc = 0;
  const w = 3;
  for (let i = 0; i < n; i++) {
    acc += env[i] - (i >= w ? env[i - w] : 0);
    sm[i] = acc / w;
  }
  const on = new Float32Array(n);
  for (let i = 1; i < n; i++) on[i] = Math.max(0, sm[i] - sm[i - 1]);
  // Adaptive threshold: local mean over ±0.5 s times a factor.
  const half = Math.round(rate * 0.5);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + on[i];
  const k = 1.6 / Math.max(0.2, sensitivity);
  const beats = [];
  let last = -1e9;
  for (let i = 1; i < n - 1; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half);
    const mean = (pre[b] - pre[a]) / (b - a);
    if (on[i] > mean * k && on[i] > 0.004 && on[i] >= on[i - 1] && on[i] >= on[i + 1]) {
      const t = i / rate;
      if (t - last >= minGap) {
        beats.push(Math.round(t * 1000) / 1000);
        last = t;
      } else if (beats.length && on[i] > on[Math.round(last * rate)]) {
        beats[beats.length - 1] = Math.round(t * 1000) / 1000;
        last = t;
      }
    }
  }
  return beats;
}
