// Recorte (cropping) of the Inspector: the crop <-> mask maths and a real export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { CROP_ID, cropOf, hasCrop, setCrop } from '../src/lib/crop.js';

const require = createRequire(import.meta.url);
const { runExport } = require('../electron/render.cjs');

test('no crop: all zeros, and setting zeros adds nothing', () => {
  const clip = {};
  assert.deepEqual(cropOf(clip), { left: 0, right: 0, top: 0, bottom: 0, soft: 0 });
  setCrop(clip, { left: 0, soft: 0 });
  assert.equal(clip.masks, undefined);
  assert.equal(hasCrop(clip), false);
});

test('a crop is one rectangle mask in cut mode, and reads back the same', () => {
  const clip = {};
  const v = setCrop(clip, { left: 0.25, right: 0.1, top: 0.2, soft: 0.5 });
  assert.deepEqual(v, { left: 0.25, right: 0.1, top: 0.2, bottom: 0, soft: 0.5 });
  assert.equal(clip.masks.length, 1);
  const m = clip.masks[0];
  assert.deepEqual({ id: m.id, shape: m.shape, mode: m.mode, invert: m.invert }, { id: CROP_ID, shape: 'rect', mode: 'cut', invert: false });
  assert.deepEqual([m.x, m.y, m.w, m.h, m.feather], [0.575, 0.6, 0.65, 0.8, 0.1]);
  assert.deepEqual(cropOf(clip), v);
});

test('only the given sides change; the other masks stay, after the crop', () => {
  const other = { id: 'mk1', shape: 'ellipse', x: 0.5, y: 0.5, w: 0.3, h: 0.3, feather: 0, invert: false, mode: 'blur', amount: 0.7 };
  const clip = { masks: [other] };
  setCrop(clip, { left: 0.1 });
  setCrop(clip, { bottom: 0.3 });
  assert.deepEqual(cropOf(clip), { left: 0.1, right: 0, top: 0, bottom: 0.3, soft: 0 });
  assert.deepEqual(clip.masks.map((m) => m.id), [CROP_ID, 'mk1']);
  setCrop(clip, { left: 0, bottom: 0 });
  assert.deepEqual(clip.masks, [other], 'crop back to zero: only the crop mask goes');
});

test('opposite sides never meet: the side being changed stops', () => {
  const clip = {};
  setCrop(clip, { left: 0.6 });
  assert.equal(setCrop(clip, { right: 0.9 }).right, 0.38);
  assert.equal(cropOf(clip).left, 0.6);
  assert.equal(setCrop(clip, { left: 0.95 }).left, 0.6, 'left stops at what right leaves');
  const both = setCrop({}, { top: 0.8, bottom: 0.8 });
  assert.ok(both.top + both.bottom <= 0.98 + 1e-9);
  assert.deepEqual(setCrop({}, { left: -3, right: Number.NaN, soft: 7 }), { left: 0, right: 0, top: 0, bottom: 0, soft: 1 });
});

test('a crop mask moved by hand in the viewer reads back as a crop', () => {
  const clip = { masks: [{ id: CROP_ID, shape: 'rect', x: 0.5, y: 0.5, w: 0.5, h: 1, feather: 0, invert: false, mode: 'cut', amount: 1 }] };
  assert.deepEqual(cropOf(clip), { left: 0.25, right: 0.25, top: 0, bottom: 0, soft: 0 });
});

test('real export: the cropped side shows what is underneath, the rest keeps the picture', { skip: spawnSync('ffmpeg', ['-version']).status !== 0, timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec-crop-'));
  try {
    const src = join(dir, 'red.mp4');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]).status, 0);
    const clip = { id: 'a', mediaId: 'v', start: 0, in: 0, out: 1, fit: 'fill' };
    setCrop(clip, { left: 0.5, top: 0.25 });
    const p = {
      name: 'crop', canvas: { w: 320, h: 240, fps: 30, preset: '16:9' },
      media: [{ id: 'v', path: src, kind: 'video', duration: 1, hasAudio: false }],
      tracks: [{ id: 'v1', kind: 'video', clips: [clip] }],
    };
    const out = join(dir, 'out.mp4');
    await runExport(p, out);
    const px = (x, y) => [...spawnSync('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', out, '-frames:v', '1', '-vf', `crop=4:4:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' }).stdout];
    const kept = px(240, 150);
    const leftGone = px(60, 150);
    const topGone = px(240, 20);
    assert.ok(kept[0] > 200 && kept[1] < 60, `right-bottom keeps the red picture: ${kept}`);
    assert.ok(leftGone[0] < 30, `left half is cut: ${leftGone}`);
    assert.ok(topGone[0] < 30, `top quarter is cut: ${topGone}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
