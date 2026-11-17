// Photoshop layer tools (src/lib/pslayer.js + layerfx.js): Blend If, Color to Alpha and the new layer
// styles. Formulas against ffmpeg, then real exports checked pixel by pixel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { FFMPEG } = require('../electron/bin.cjs');
const { runExport, buildExport } = require('../electron/render.cjs');
const P = await import('../src/lib/pslayer.js');

const run = (args, opts = {}) => {
  const r = spawnSync(FFMPEG, ['-v', 'error', ...args], { maxBuffer: 1 << 26, ...opts });
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
};

test('Blend If: weights, ranges and the ffmpeg expression', () => {
  const r = [20, 60, 200, 240];
  assert.equal(P.blendIfWeight(r, 10), 0);
  assert.equal(P.blendIfWeight(r, 40), 0.5);
  assert.equal(P.blendIfWeight(r, 128), 1);
  assert.equal(P.blendIfWeight(r, 220), 0.5);
  assert.equal(P.blendIfWeight(r, 250), 0);
  assert.equal(P.cleanBlendIf({ this: [0, 0, 255, 255] }), null, 'full ranges = off');
  assert.deepEqual(P.cleanBlendIf({ this: [60, 20, 300, 100] }).this, [20, 60, 100, 255]);
  // ffmpeg: one gray row, the weight of v for this range times the under range of 255 − v
  const u = [0, 0, 100, 180];
  const v = Array.from({ length: 256 }, (_, i) => i);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmx-bif-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.raw'), Buffer.from(v));
    fs.writeFileSync(path.join(dir, 'b.raw'), Buffer.from(v.map((x) => 255 - x)));
    const inp = (f) => ['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', '256x1', '-i', f];
    const out = run([...inp('a.raw'), ...inp('b.raw'), '-filter_complex', `[0][1]blend=all_expr='255*${P.blendIfFF(r, 'A')}*${P.blendIfFF(u, 'B')}'`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { cwd: dir });
    v.forEach((x, i) => {
      const exp = 255 * P.blendIfWeight(r, x) * P.blendIfWeight(u, 255 - x);
      assert.ok(Math.abs(out[i] - exp) <= 1, `v=${x}: ${out[i]} vs ${exp}`);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Color to Alpha: composited back over the colour gives the pixel; geq equals the reference', () => {
  const C = [0.1, 0.2, 0.9];
  for (const p of [[0.5, 0.5, 0.5], [0.1, 0.2, 0.9], [1, 0, 0.3], [0.05, 0.6, 0.95]]) {
    const [r, g, b, a] = P.colorToAlphaJS(p, C);
    [r, g, b].forEach((q, i) => assert.ok(Math.abs(q * a + C[i] * (1 - a) - p[i]) < 1e-9, `${p} channel ${i}`));
  }
  assert.equal(P.colorToAlphaJS([0, 0, 0], [0, 0, 0])[3], 0, 'the key colour is fully transparent');
  assert.equal(P.cleanColorToAlpha({ color: 'red' }), null);
  // geq on a row of colours
  const px = [];
  for (let i = 0; i < 64; i++) px.push([(i * 37) % 256, (i * 91) % 256, (i * 13) % 256, 255]);
  const key = '#202060';
  const c = P.cleanColorToAlpha({ color: key, threshold: 0.1 });
  const q = P.colorToAlphaGeq(c.color, c.threshold);
  const out = run(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '64x1', '-i', '-', '-vf', `format=rgba,geq=r='${q.r}':g='${q.g}':b='${q.b}':a='${q.a}'`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { input: Buffer.from(px.flat()) });
  px.forEach((p, i) => {
    const e = P.colorToAlphaJS(p.slice(0, 3).map((v) => v / 255), c.color, c.threshold);
    for (let k = 0; k < 4; k++) assert.ok(Math.abs(out[i * 4 + k] - 255 * e[k]) <= 1.5, `px ${i} ch ${k}: ${out[i * 4 + k]} vs ${255 * e[k]}`);
  });
});

// ---- real exports -----------------------------------------------------------------------------
const W = 320;
const H = 180;

async function exportOf(dir, name, bottom, top, topClip = {}) {
  const media = [
    { id: 'b', path: bottom, kind: 'image', duration: 5, width: W, height: H, hasAudio: false },
    { id: 't', path: top, kind: 'image', duration: 5, width: W, height: H, hasAudio: false },
  ];
  const p = {
    name,
    canvas: { w: W, h: H, fps: 25 },
    media,
    tracks: [
      { id: 'v1', kind: 'video', clips: [{ id: 'cb', mediaId: 'b', start: 0, in: 0, out: 0.4, fit: 'fill' }] },
      { id: 'v2', kind: 'video', clips: [{ id: 'ct', mediaId: 't', start: 0, in: 0, out: 0.4, fit: 'fill', ...topClip }] },
    ],
  };
  const out = path.join(dir, `${name}.mp4`);
  await runExport(p, out);
  const raw = run(['-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return { at: (x, y) => [...raw.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)], fc: buildExport(p, out).args.find((a) => a.includes('[base0]')) };
}

const near = (got, exp, tol, what) => assert.ok(got.every((v, i) => Math.abs(v - exp[i]) <= tol), `${what}: got ${got} want ${exp}`);

test('export: Blend If, Color to Alpha and the layer styles', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmx-ps-'));
  const img = (name, vf) => {
    const f = path.join(dir, `${name}.png`);
    run(['-f', 'lavfi', '-i', `color=c=black@0:s=${W}x${H},format=rgba,${vf}`, '-frames:v', '1', '-y', f]);
    return f;
  };
  try {
    const red = img('red', 'drawbox=x=0:y=0:w=iw:h=ih:color=0xFF0000:t=fill:replace=1');
    const black = img('black', 'drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:replace=1');
    // black frame with a white square in the middle (opaque)
    const sqOnBlack = img('sqb', 'drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:replace=1,drawbox=x=110:y=40:w=100:h=100:color=white:t=fill:replace=1');
    // transparent frame with a white square
    const sq = img('sq', 'drawbox=x=110:y=40:w=100:h=100:color=white:t=fill:replace=1');
    // half black (left) / half white (right) backdrop, and solid grey
    const half = img('half', 'drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:replace=1,drawbox=x=160:y=0:w=160:h=ih:color=white:t=fill:replace=1');
    const grey = img('grey', 'drawbox=x=0:y=0:w=iw:h=ih:color=0x808080:t=fill:replace=1');

    await t.test('Color to Alpha removes the black around the square', async () => {
      const r = await exportOf(dir, 'cta', red, sqOnBlack, { colorToAlpha: { color: '#000000' } });
      near(r.at(20, 20), [255, 0, 0], 12, 'black became transparent');
      near(r.at(160, 90), [255, 255, 255], 12, 'white stays');
    });
    await t.test('Blend If (this layer) hides the dark part', async () => {
      const r = await exportOf(dir, 'bift', red, sqOnBlack, { blendIf: { this: [0, 40, 255, 255] } });
      near(r.at(20, 20), [255, 0, 0], 12, 'dark part hidden');
      near(r.at(160, 90), [255, 255, 255], 12, 'bright part kept');
    });
    await t.test('Blend If (underlying) shows the layer only over the dark backdrop', async () => {
      const r = await exportOf(dir, 'bifu', half, grey, { blendIf: { under: [0, 0, 100, 140] } });
      near(r.at(60, 90), [128, 128, 128], 12, 'over black: grey layer');
      near(r.at(260, 90), [255, 255, 255], 12, 'over white: hidden');
    });
    await t.test('stroke outside draws a ring around the square', async () => {
      const r = await exportOf(dir, 'stroke', black, sq, { effects: [{ id: 'e', type: 'stroke', color: '#FF0000', size: 0.04, position: 'outside', opacity: 1 }] });
      near(r.at(160, 90), [255, 255, 255], 12, 'inside');
      near(r.at(104, 90), [255, 0, 0], 40, 'just outside: red');
      near(r.at(40, 90), [0, 0, 0], 12, 'far: black');
    });
    await t.test('stroke inside paints inside the edge', async () => {
      const r = await exportOf(dir, 'strokein', black, sq, { effects: [{ id: 'e', type: 'stroke', color: '#00FF00', size: 0.04, position: 'inside', opacity: 1 }] });
      near(r.at(113, 90), [0, 255, 0], 40, 'inside the edge: green');
      near(r.at(160, 90), [255, 255, 255], 12, 'centre');
      near(r.at(100, 90), [0, 0, 0], 12, 'outside untouched');
    });
    await t.test('outer glow lights the outside, inner glow and inner shadow the inside', async () => {
      const og = await exportOf(dir, 'og', black, sq, { effects: [{ id: 'e', type: 'outerGlow', color: '#FFD60A', opacity: 1, size: 0.05, spread: 0.5 }] });
      assert.ok(og.at(105, 90)[0] > 60, `glow outside ${og.at(105, 90)}`);
      near(og.at(20, 20), [0, 0, 0], 12, 'far from the glow');
      const ig = await exportOf(dir, 'ig', black, sq, { effects: [{ id: 'e', type: 'innerGlow', color: '#0000FF', opacity: 1, size: 0.05, spread: 0.5 }] });
      assert.ok(ig.at(112, 90)[0] < 200 && ig.at(112, 90)[2] > 200, `inner glow at the edge ${ig.at(112, 90)}`);
      near(ig.at(160, 90), [255, 255, 255], 20, 'centre untouched');
      const is = await exportOf(dir, 'is', black, sq, { effects: [{ id: 'e', type: 'innerShadow', color: '#000000', opacity: 1, distance: 0.03, angle: 135, softness: 0.005 }] });
      // light from the top-left (135° = the shadow falls down-right): dark along the top and left edges
      assert.ok(is.at(113, 90)[0] < 120, `left edge shaded ${is.at(113, 90)}`);
      assert.ok(is.at(205, 90)[0] > 200, `right edge lit ${is.at(205, 90)}`);
      near(is.at(100, 90), [0, 0, 0], 12, 'outside untouched');
    });
    await t.test('nothing set: no extra filters', async () => {
      const r = await exportOf(dir, 'plain', red, sqOnBlack, {});
      assert.ok(!/geq|alphamerge|extractplanes/.test(r.fc), r.fc);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
