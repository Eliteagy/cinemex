// Develop: LightCraft's per-pixel colour pipeline (src/lib/develop.js) baked into 3D LUTs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEV_DEFAULT,
  LOOKS,
  autoTone,
  autoWhiteBalance,
  bakeLut,
  isIdentityDev,
  makePixelFn,
  parseCube,
  resolveLook,
  tempTintToXy,
  toCube,
  xyToTempTint,
} from '../src/lib/develop.js';

const enc = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const dec = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b} (±${eps})`);
const GREY = enc(0.18);

test('identity settings: LUT and pixel function are the identity', () => {
  for (const color of [undefined, {}, { dev: {} }, { dev: DEV_DEFAULT }, { vignette: 0.5, lut: 'x.cube', dev: { look: { id: 'lc.vivid', amount: 0 } } }]) {
    assert.equal(isIdentityDev(color), true);
    const N = 17;
    const lut = bakeLut(color, N);
    assert.equal(lut.length, N * N * N * 3);
    let o = 0;
    for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++, o += 3) {
      near(lut[o], r / (N - 1), 1e-4);
      near(lut[o + 1], g / (N - 1), 1e-4);
      near(lut[o + 2], b / (N - 1), 1e-4);
    }
  }
  // the full pipeline (no identity shortcut) round-trips too
  const f = makePixelFn({ dev: {} });
  for (const c of [[0, 0, 0], [1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.2, 0.5, 0.9], [0.73, 0.31, 0.05]]) {
    const out = f(...c);
    for (let i = 0; i < 3; i++) near(out[i], c[i], 1e-4, `identity ${c}`);
  }
  assert.equal(isIdentityDev({ dev: { exposure: 0.1 } }), false);
  assert.equal(isIdentityDev({ saturation: 0.2 }), false);
});

test('exposure +1 EV doubles linear light on mid-grey', () => {
  const out = makePixelFn({ dev: { exposure: 1 } })(GREY, GREY, GREY);
  for (const v of out) near(dec(v), 0.36, 1e-5);
  const dn = makePixelFn({ dev: { exposure: -2 } })(GREY, GREY, GREY);
  near(dec(dn[1]), 0.045, 1e-5);
});

test('contrast: identity at 0, anchored at mid-grey, S-curve around it', () => {
  near(makePixelFn({ dev: { contrast: 0 } })(0.3, 0.3, 0.3)[0], 0.3, 1e-6);
  for (const c of [-100, -40, 50, 100]) {
    const f = makePixelFn({ dev: { contrast: c } });
    near(dec(f(GREY, GREY, GREY)[0]), 0.18, 2e-4, `grey at contrast ${c}`);
  }
  const f = makePixelFn({ dev: { contrast: 60 } });
  assert.ok(f(0.8, 0.8, 0.8)[0] > 0.8 && f(0.2, 0.2, 0.2)[0] < 0.2);
});

test('white balance: 6500 K / 0 is the identity, warmer temp raises R/B, tint moves green', () => {
  assert.equal(isIdentityDev({ dev: { temp: 6500, tint: 0 } }), true);
  const grey = [0.5, 0.5, 0.5];
  const warm = makePixelFn({ dev: { temp: 9000 } })(...grey);
  const cool = makePixelFn({ dev: { temp: 4000 } })(...grey);
  assert.ok(warm[0] / warm[2] > 1.05, `warm ${warm}`);
  assert.ok(cool[0] / cool[2] < 0.95, `cool ${cool}`);
  const magenta = makePixelFn({ dev: { tint: 60 } })(...grey);
  assert.ok(magenta[1] < magenta[0] && magenta[1] < magenta[2], `tint ${magenta}`);
  // neutral luminance is kept (luminance-normalised Bradford)
  const y = (c) => 0.2126 * dec(c[0]) + 0.7152 * dec(c[1]) + 0.0722 * dec(c[2]);
  near(y(warm), dec(0.5), 0.01);
  // CCT round trip (cct.rs tests)
  for (const t of [2856, 5003, 6500, 9000]) for (const tint of [-20, 0, 35]) {
    const [t2, tint2] = xyToTempTint(tempTintToXy(t, tint));
    assert.ok(Math.abs(t2 - t) / t < 0.01 && Math.abs(tint2 - tint) < 1);
  }
});

test('HSL: green saturation −100 desaturates pure green and leaves red', () => {
  const f = makePixelFn({ dev: { hsl: { green: { s: -100 } } } });
  const g = f(0, 1, 0);
  assert.ok(Math.max(...g) - Math.min(...g) < 0.03, `green ${g}`);
  const r = f(1, 0, 0);
  near(r[0], 1, 1e-3);
  assert.ok(r[1] < 0.01 && r[2] < 0.01, `red ${r}`);
});

test('B&W and saturation −100 give neutral greys', () => {
  for (const dev of [{ bw: true }, { saturation: -100 }]) {
    const o = makePixelFn({ dev })(0.8, 0.3, 0.1);
    assert.ok(Math.max(...o) - Math.min(...o) < 2e-3, `${JSON.stringify(dev)} ${o}`);
  }
});

test('reference values computed by hand from the Rust formulas', () => {
  // Saturation −100 on sRGB red: OkLab L of red = 0.627955 kept, a = b = 0 → linear L³ = 0.247627 → encoded 0.53478.
  const red = makePixelFn({ dev: { saturation: -100 } })(1, 0, 0);
  for (const v of red) near(v, 0.53478, 1e-3);
  // Shadows +100 at 3 EV under grey (finish.rs local_tone_delta, base = own log luminance):
  // sw = 1 − smooth(−4.8, 0.3, −3) = 0.714227, delta = 1.7·sw·√sw = 1.02612 stops → 0.0225·2^1.02612 = 0.045823.
  const g = enc(0.0225);
  const sh = makePixelFn({ dev: { shadows: 100 } })(g, g, g);
  near(dec(sh[0]), 0.045823, 2e-5);
  // Display tone map, contrast +100 (tone.rs display_hdr): p = 0.5 → 0.5 + 0.35·(0.5 − 0.18^(1/2.2)) = 0.514434, out = p^2.2.
  const yIn = Math.pow(0.5, 2.2);
  const c = makePixelFn({ dev: { contrast: 100 } })(enc(yIn), enc(yIn), enc(yIn));
  near(dec(c[0]), Math.pow(0.514434, 2.2), 1e-4);
  // Parametric curve, highlights +100 at x = 0.875 (curve.rs): 0.875 + 0.22·4·0.875·0.125 = 0.97125.
  const hc = makePixelFn({ dev: { curve: { highlights: 100 } } })(0.875, 0.875, 0.875);
  near(hc[0], 0.97125, 1e-4);
  // Master point curve through (0.5, 0.6): 0.5 → 0.6 exactly (monotone Hermite passes through its points).
  near(makePixelFn({ dev: { curve: { master: [[0, 0], [0.5, 0.6], [1, 1]] } } })(0.5, 0.5, 0.5)[1], 0.6, 1e-3);
});

test('looks: 21 profiles, merged under the sliders like profiles.rs, all bake cleanly', () => {
  assert.equal(LOOKS.length, 21);
  assert.equal(new Set(LOOKS.map((l) => l.id)).size, 21);
  for (const l of LOOKS) assert.ok(l.label && l.group, l.id);
  // slider deltas are linear in the amount and add to the user's value
  const at = (amount) => resolveLook({ contrast: 5, look: { id: 'lc.neutral', amount } });
  assert.equal(at(100).contrast, 5 - 18);
  assert.equal(at(200).contrast, 5 - 36);
  assert.equal(at(50).shadows, 4);
  // wheels add as colour vectors (profiles.rs test)
  const w = resolveLook({ wheels: { shadows: { hue: 195, sat: 10 } }, look: { id: 'lc.cine.teal-amber' } }).wheels.shadows;
  near(w.hue, 195, 1e-6);
  near(w.sat, 40, 1e-6);
  // fade composes after the user's point curve, user points kept
  const m = resolveLook({ curve: { master: [[0, 0], [0.5, 0.6], [1, 1]] }, look: { id: 'lc.muted.matte-soft' } }).curve.master;
  assert.equal(m.length, 3);
  [0.08, 0.08 + 0.6 * 0.88, 0.96].forEach((y, i) => near(m[i][1], y, 1e-9));
  for (const l of LOOKS) {
    for (const amount of [100, 200]) {
      const lut = bakeLut({ dev: { look: { id: l.id, amount } } }, 9);
      for (const v of lut) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `${l.id} ${amount}: ${v}`);
    }
    assert.equal(isIdentityDev({ dev: { look: { id: l.id } } }), false, l.id);
  }
  const bw = makePixelFn({ dev: { look: { id: 'lc.bw.red-filter' } } })(0.9, 0.2, 0.1);
  assert.ok(Math.max(...bw) - Math.min(...bw) < 0.02, `B&W look ${bw}`);
});

test('legacy sliders still work, close to gradeMath', () => {
  const f = makePixelFn({ exposure: 0.5 });
  near(f(0.5, 0.5, 0.5)[0], 0.65, 1e-4); // bright = 1 + 0.6·e on encoded values
  const warm = makePixelFn({ temperature: 1 })(0.5, 0.5, 0.5);
  near(warm[0], 0.5, 1e-4);
  near(warm[2], 0.38, 1e-4);
  const c = makePixelFn({ contrast: 0.5 })(0.75, 0.75, 0.75);
  near(c[0], 0.5 + 0.25 * 1.4, 1e-4);
  const s = makePixelFn({ saturation: -1 })(1, 0, 0);
  assert.ok(Math.abs(s[0] - s[1]) < 1e-4 && Math.abs(s[1] - s[2]) < 1e-4);
  // dev settings apply on top of the legacy grade
  const both = makePixelFn({ exposure: 0.5, dev: { exposure: 1 } })(0.5, 0.5, 0.5);
  near(dec(both[0]), 2 * dec(0.65), 1e-4);
});

test('.cube: toCube / parseCube round trip, user LUT composed, 1D refused', () => {
  const N = 5;
  const data = bakeLut({ dev: { contrast: 30, temp: 7500 } }, N);
  const back = parseCube(toCube(data, N, 'teste'));
  assert.equal(back.N, N);
  assert.deepEqual(back.domainMin, [0, 0, 0]);
  for (let i = 0; i < data.length; i++) near(back.data[i], data[i], 1e-6);
  // composing: identity develop + user LUT = user LUT at the grid; develop then an invert LUT
  const inv = new Float32Array(N * N * N * 3);
  let o = 0;
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++, o += 3) {
    inv[o] = 1 - r / (N - 1);
    inv[o + 1] = 1 - g / (N - 1);
    inv[o + 2] = 1 - b / (N - 1);
  }
  const user = { N, data: inv };
  const id = bakeLut({}, N, user);
  for (let i = 0; i < inv.length; i++) near(id[i], inv[i], 1e-6);
  const composed = bakeLut({ dev: { exposure: 1 } }, 9, user);
  const plain = bakeLut({ dev: { exposure: 1 } }, 9);
  near(composed[3 * 40], 1 - plain[3 * 40], 1e-5, 'trilinear on a linear LUT is exact');
  assert.throws(() => parseCube('LUT_1D_SIZE 2\n0 0 0\n1 1 1\n'), /1D/);
  assert.throws(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n'), /entradas/);
  const r = parseCube('# c\nTITLE "x"\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n' + '0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
  assert.equal(r.N, 2);
  assert.equal(r.data[3], 1);
});

test('auto tone and auto white balance on a frame', () => {
  const w = 64;
  const h = 36;
  const frame = (r, g, b) => {
    const a = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) a.set([r, g, b, 255], i * 4);
    return a;
  };
  const g8 = Math.round(GREY * 255);
  const t = autoTone(frame(g8, g8, g8), w, h);
  near(t.exposure, -0.58, 0.02);
  assert.ok(autoTone(frame(20, 20, 20), w, h).exposure > 1);
  const neutral = autoWhiteBalance(frame(128, 128, 128), w, h);
  assert.ok(Math.abs(neutral.temp - 6500) < 30 && Math.abs(neutral.tint) <= 1, JSON.stringify(neutral));
  const orange = autoWhiteBalance(frame(160, 128, 96), w, h);
  assert.ok(orange.temp < 5000, JSON.stringify(orange));
  // applying it neutralises the cast
  const fixed = makePixelFn({ dev: orange })(160 / 255, 128 / 255, 96 / 255);
  assert.ok(Math.max(...fixed) - Math.min(...fixed) < 0.03, `${fixed}`);
});

test('performance: bakeLut 65³ with everything on in under 1 s', () => {
  const color = {
    exposure: 0.1,
    dev: {
      temp: 8000, tint: 10, exposure: 0.5, contrast: 30, highlights: -40, shadows: 30, whites: 10, blacks: -10, vibrance: 20, saturation: 10,
      hsl: { green: { h: 10, s: -30, l: 5 } }, wheels: { shadows: { hue: 200, sat: 20 }, highlights: { hue: 40, sat: 15 } },
      curve: { master: [[0, 0], [0.5, 0.55], [1, 1]], lights: 10 }, refineSat: 50, look: { id: 'lc.cine.teal-amber' }, calibration: { redHue: 20, shadowsTint: 10 },
    },
  };
  bakeLut(color, 17);
  const t0 = performance.now();
  const lut = bakeLut(color, 65);
  const ms = performance.now() - t0;
  assert.equal(lut.length, 65 ** 3 * 3);
  assert.ok(ms < 1000, `${ms} ms`);
});
