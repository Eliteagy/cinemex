// Blend modes: the export expression (ffmpeg blend all_expr) equals the reference formulas
// (src/lib/blend.js, the same ones the preview shader uses), pixel by pixel on solid colours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { FFMPEG } = require('../electron/bin.cjs');
const { BLENDS, BLEND_ORDER, blendFF, blendJS } = await import('../src/lib/blend.js');

const V = [0, 1, 37, 64, 127, 128, 200, 254, 255];
const hex = (v) => v.toString(16).padStart(2, '0');

test('every listed mode has the three forms', () => {
  for (const m of BLEND_ORDER) {
    if (m === 'normal') continue;
    assert.ok(BLENDS[m], m);
    for (const k of ['label', 'js', 'glsl', 'ff']) assert.ok(BLENDS[m][k], `${m}.${k}`);
  }
});

test('ffmpeg all_expr matches the reference formulas', () => {
  // One frame per mode: 81 pixels wide, pixel i = pair (V[i/9], V[i%9]) on R; G and B carry swapped pairs.
  const n = V.length;
  const pairs = [];
  for (const a of V) for (const b of V) pairs.push([a, b]);
  const bg = pairs.map(([a, b]) => `${hex(a)}${hex(b)}${hex(255 - a)}`);
  const fg = pairs.map(([a, b]) => `${hex(b)}${hex(a)}${hex(255 - b)}`);
  // Build the two 81x1 images as raw rgb24 through stdin-free lavfi: use geq-free approach with raw files.
  const toRaw = (cols) => Buffer.from(cols.flatMap((c) => [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16))));
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmx-blend-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.rgb'), toRaw(bg));
    fs.writeFileSync(path.join(dir, 'b.rgb'), toRaw(fg));
    for (const mode of BLEND_ORDER) {
      if (mode === 'normal') continue;
      const r = spawnSync(FFMPEG, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${pairs.length}x1`, '-i', 'a.rgb', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${pairs.length}x1`, '-i', 'b.rgb',
        '-filter_complex', `[0]format=gbrp[x];[1]format=gbrp[y];[x][y]blend=${blendFF(mode)},format=rgb24`, '-f', 'rawvideo', '-'], { cwd: dir, maxBuffer: 1 << 20 });
      assert.equal(r.status, 0, `${mode}: ${r.stderr}`);
      const out = r.stdout;
      pairs.forEach(([a, b], i) => {
        const exp = [blendJS(mode, a, b), blendJS(mode, b, a), blendJS(mode, 255 - a, 255 - b)];
        for (let c = 0; c < 3; c++) {
          const got = out[i * 3 + c];
          assert.ok(Math.abs(got - exp[c]) <= 1, `${mode} a=${[a, b, 255 - a][c]} b=${[b, a, 255 - b][c]}: ffmpeg ${got} vs ${exp[c].toFixed(2)}`);
        }
      });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  void n;
});
