// Built-in sound effects (CapCut "Sound effects", Premiere's Essential Sound presets): made here
// by synthesis, so there are no licences and nothing to download. Written once as 48 kHz WAV files
// in the app's data folder and imported like any other audio.
const fs = require('node:fs');
const path = require('node:path');

const RATE = 48000;

/** Deterministic white noise. */
function noise(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

/** RBJ biquad whose centre frequency can change every sample. */
function biquad(type) {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (x, f, q = 0.9) => {
    const w = (2 * Math.PI * Math.max(20, Math.min(RATE / 2.2, f))) / RATE;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    let b0;
    let b1;
    let b2;
    if (type === 'band') {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    } else if (type === 'high') {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
    } else {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
    }
    const a0 = 1 + alpha;
    const a1 = -2 * cos;
    const a2 = 1 - alpha;
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

const env = (t, attack, dur, curve = 2) => (t < attack ? t / attack : Math.pow(Math.max(0, 1 - (t - attack) / Math.max(1e-6, dur - attack)), curve));

/** id -> label, length (s) and a function of (time, sample index state) giving one sample. */
const SFX = {
  whoosh: {
    label: 'Whoosh',
    dur: 0.7,
    make() {
      const n = noise(7);
      const bp = biquad('band');
      const bp2 = biquad('band');
      return (t) => {
        const u = t / 0.7;
        const f = 250 * Math.pow(14, Math.sin(Math.PI * Math.min(1, u * 1.05)));
        const e = Math.sin(Math.PI * Math.min(1, u)) ** 1.6;
        const x = n();
        return (bp(x, f, 1.2) * 2.2 + bp2(x, f * 1.9, 2) * 1.2) * e;
      };
    },
  },
  swoosh: {
    label: 'Swoosh rápido',
    dur: 0.35,
    make() {
      const n = noise(11);
      const bp = biquad('band');
      return (t) => {
        const u = t / 0.35;
        return bp(n(), 600 + 5200 * u, 1.4) * 2.6 * Math.sin(Math.PI * u) ** 1.2;
      };
    },
  },
  pop: {
    label: 'Pop',
    dur: 0.14,
    make() {
      let ph = 0;
      return (t) => {
        ph += (2 * Math.PI * (300 + 900 * Math.exp(-t * 60))) / RATE;
        return Math.sin(ph) * Math.exp(-t * 32) * Math.min(1, t * 2000);
      };
    },
  },
  click: {
    label: 'Clique',
    dur: 0.05,
    make() {
      const n = noise(3);
      const hp = biquad('high');
      return (t) => hp(n(), 2500) * Math.exp(-t * 180) * 1.8;
    },
  },
  riser: {
    label: 'Riser (subida)',
    dur: 2,
    make() {
      const n = noise(5);
      const bp = biquad('band');
      let ph = 0;
      let ph2 = 0;
      return (t) => {
        const u = t / 2;
        const f = 180 * Math.pow(9, u);
        ph += (2 * Math.PI * f) / RATE;
        ph2 += (2 * Math.PI * f * 1.5) / RATE;
        const saw = ((ph / Math.PI) % 2) - 1;
        const tone = 0.35 * saw + 0.25 * Math.sin(ph2);
        const air = bp(n(), 400 + 7000 * u * u, 0.8) * 1.6;
        const e = Math.pow(u, 1.8) * (t > 1.96 ? (2 - t) / 0.04 : 1);
        return (tone * 0.6 + air) * e;
      };
    },
  },
  impacto: {
    label: 'Impacto (boom)',
    dur: 1.4,
    make() {
      const n = noise(9);
      const lp = biquad('low');
      let ph = 0;
      return (t) => {
        ph += (2 * Math.PI * (42 + 80 * Math.exp(-t * 14))) / RATE;
        const sub = Math.sin(ph) * Math.exp(-t * 2.6);
        const crack = lp(n(), 2400 * Math.exp(-t * 6) + 120, 0.7) * Math.exp(-t * 9) * 1.4;
        return (sub + crack) * Math.min(1, t * 1500);
      };
    },
  },
  ding: {
    label: 'Ding',
    dur: 1.2,
    make() {
      return (t) => {
        const w = 2 * Math.PI * t;
        const e = Math.exp(-t * 3.2) * Math.min(1, t * 800);
        return (Math.sin(w * 1318.5) * 0.6 + Math.sin(w * 2637) * 0.25 * Math.exp(-t * 3) + Math.sin(w * 3955.5) * 0.12 * Math.exp(-t * 6)) * e;
      };
    },
  },
  camara: {
    label: 'Câmara (foto)',
    dur: 0.32,
    make() {
      const n = noise(13);
      const hp = biquad('high');
      return (t) => {
        const a = Math.exp(-t * 140) * 1.6;
        const b = t > 0.16 ? Math.exp(-(t - 0.16) * 110) * 1.2 : 0;
        return hp(n(), 1800) * (a + b);
      };
    },
  },
  flash: {
    label: 'Flash (transição)',
    dur: 0.6,
    make() {
      // Air that rises into the cut (0.22 s) + a bright shimmer that decays: the peak lands at 0.22 s.
      const n = noise(21);
      const bp = biquad('band');
      const hp = biquad('high');
      return (t) => {
        const peak = 0.22;
        const rise = t < peak ? Math.pow(t / peak, 2.2) : Math.exp(-(t - peak) * 9);
        const air = bp(n(), 900 + 6000 * Math.min(1, t / peak), 1.1) * 1.8;
        const sh = t >= peak ? hp(n(), 5000) * Math.exp(-(t - peak) * 14) * 1.6 + Math.sin(2 * Math.PI * 2093 * t) * 0.25 * Math.exp(-(t - peak) * 10) : 0;
        return air * rise + sh;
      };
    },
  },
  glitch: {
    label: 'Glitch',
    dur: 0.4,
    make() {
      const n = noise(17);
      let ph = 0;
      return (t) => {
        const block = Math.floor(t * 40);
        const on = (block * 7919) % 5 !== 0;
        ph += (2 * Math.PI * (200 + ((block * 131) % 9) * 140)) / RATE;
        const sq = Math.sign(Math.sin(ph)) * 0.5;
        const crush = Math.round(n() * 4) / 4;
        return on ? (sq + crush * 0.4) * (1 - t / 0.4) : 0;
      };
    },
  },
};

/** Samples of one effect (mono, 48 kHz), normalised to a 0.9 peak. */
function renderSfx(id) {
  const def = SFX[id];
  if (!def) throw new Error(`Efeito sonoro desconhecido: ${id}`);
  const len = Math.round(def.dur * RATE);
  const out = new Float32Array(len);
  const gen = def.make();
  let peak = 0;
  for (let i = 0; i < len; i++) {
    const v = gen(i / RATE);
    out[i] = Number.isFinite(v) ? v : 0;
    peak = Math.max(peak, Math.abs(out[i]));
  }
  const k = peak > 0 ? 0.9 / peak : 0;
  // 3 ms fade at both ends: no clicks.
  const f = Math.round(0.003 * RATE);
  for (let i = 0; i < len; i++) out[i] *= k * Math.min(1, i / f, (len - 1 - i) / f);
  return out;
}

/** 16-bit mono PCM WAV. */
function wav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buf;
}

const VERSION = 1;
/** Write the effects into `dir` (once per version) and list them. */
function ensureSfx(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return Object.entries(SFX).map(([id, def]) => {
    const file = path.join(dir, `${id}-v${VERSION}.wav`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, wav(renderSfx(id)));
    return { id, label: def.label, path: file, duration: def.dur };
  });
}

module.exports = { SFX, renderSfx, wav, ensureSfx, RATE };
