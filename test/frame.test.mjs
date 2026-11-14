// Moldura e fundo: the frame maths shared by preview and export, and a real export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { FRAME_DEFAULT, GRADIENTS, bgOf, cleanFrame, frameGeo, hasFrame } from '../src/lib/frame.js';

const require = createRequire(import.meta.url);
const { runExport } = require('../electron/render.cjs');

test('no frame: nothing, garbage or all zeros with no background mean "no frame"', () => {
  assert.equal(cleanFrame(undefined), null);
  assert.equal(cleanFrame('x'), null);
  assert.equal(cleanFrame({ padding: 0, radius: 0, shadow: 0.8, border: 0, bg: { kind: 'none' } }), null, 'a shadow alone shows nothing');
  assert.equal(hasFrame({}), false);
  assert.equal(hasFrame(FRAME_DEFAULT), true);
  assert.equal(hasFrame({ bg: { kind: 'color', color: '#112233' } }), true, 'a background alone is a frame');
});

test('values are clamped and bad colours fall back', () => {
  const f = cleanFrame({ padding: 9, radius: -1, shadow: 7, border: 1, borderColor: 'red', bg: { kind: 'color', color: 'nope' } });
  assert.deepEqual(f, { padding: 0.35, radius: 0, shadow: 1, border: 0.02, borderColor: '#ffffff', bg: { kind: 'color', color: '#101011' } });
  assert.deepEqual(cleanFrame({ padding: 0.1, bg: { kind: 'gradient', preset: 'does-not-exist' } }).bg, { kind: 'gradient', from: GRADIENTS.oceano.from, to: GRADIENTS.oceano.to, angle: 135 });
  assert.deepEqual(cleanFrame({ padding: 0.1, bg: { kind: 'weird' } }).bg, { kind: 'none' });
});

test('geometry: the box is centred, even-sized and keeps the canvas shape', () => {
  const g = frameGeo({ padding: 0.1, radius: 0.1, shadow: 1, border: 0.01, bg: { kind: 'none' } }, 1920, 1080);
  assert.deepEqual([g.iw, g.ih, g.ix, g.iy], [1536, 864, 192, 108]);
  assert.equal(g.r, 86);
  assert.equal(g.bw, 11);
  assert.equal(g.alpha, 0.75);
  const odd = frameGeo({ padding: 0.123, bg: { kind: 'color' } }, 1080, 1920);
  assert.equal(odd.iw % 2, 0);
  assert.equal(odd.ih % 2, 0);
  assert.equal(odd.ix * 2 + odd.iw, 1080);
});

test('gradient line: goes through the centre and reaches the corners', () => {
  const across = bgOf({ padding: 0.1, bg: { kind: 'gradient', from: '#000000', to: '#ffffff', angle: 0 } }, 200, 100);
  assert.deepEqual([across.x0, across.y0, across.x1, across.y1].map((v) => Math.round(v) + 0), [0, 50, 200, 50]);
  const down = bgOf({ padding: 0.1, bg: { kind: 'gradient', from: '#000000', to: '#ffffff', angle: 90 } }, 200, 100);
  assert.deepEqual([down.x0, down.y0, down.x1, down.y1].map((v) => Math.round(v) + 0), [100, 0, 100, 100]);
  assert.deepEqual(bgOf({ padding: 0.1, bg: { kind: 'gradient', preset: 'ouro' } }, 200, 100).to, GRADIENTS.ouro.to);
  assert.deepEqual(bgOf(undefined, 200, 100), { kind: 'none' });
});

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** Exports one red clip with `frame` and returns a pixel reader for the middle frame. */
async function exported(dir, frame, under) {
  const src = join(dir, 'red.mp4');
  assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]).status, 0);
  const media = [{ id: 'v', path: src, kind: 'video', duration: 1, hasAudio: false }];
  const tracks = [];
  if (under) {
    const blue = join(dir, 'blue.mp4');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', blue]).status, 0);
    media.push({ id: 'b', path: blue, kind: 'video', duration: 1, hasAudio: false });
    tracks.push({ id: 'v0', kind: 'video', clips: [{ id: 'u', mediaId: 'b', start: 0, in: 0, out: 1, fit: 'fill' }] });
  }
  tracks.push({ id: 'v1', kind: 'video', clips: [{ id: 'a', mediaId: 'v', start: 0, in: 0, out: 1, fit: 'fill', frame }] });
  const out = join(dir, `out-${Math.random().toString(36).slice(2)}.mp4`);
  await runExport({ name: 'frame', canvas: { w: 320, h: 240, fps: 30, preset: '16:9' }, media, tracks }, out);
  return (x, y) => [...spawnSync('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', out, '-frames:v', '1', '-vf', `crop=2:2:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' }).stdout];
}

test('real export: picture in the box, rounded corners, colour background, outline', { skip: !ffmpeg, timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec-frame-'));
  try {
    // 320x240, padding 0.25: box 160x120 at (80, 60); radius 0.4 * 120 = 48 px; outline 0.02 * 240 = 5 px.
    const px = await exported(dir, { padding: 0.25, radius: 0.4, shadow: 0, border: 0.02, borderColor: '#ffffff', bg: { kind: 'color', color: '#00ff00' } });
    const centre = px(160, 120);
    const margin = px(20, 120);
    const corner = px(83, 63);
    const outline = px(76, 120);
    assert.ok(centre[0] > 200 && centre[1] < 60, `the picture is in the middle: ${centre}`);
    assert.ok(margin[1] > 200 && margin[0] < 60, `the margin shows the green background: ${margin}`);
    assert.ok(corner[1] > 200 && corner[0] < 90, `the box's corner is rounded away: ${corner}`);
    assert.ok(outline[0] > 190 && outline[1] > 190 && outline[2] > 190, `white outline just outside the box: ${outline}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real export: gradient runs left to right; shadow darkens the background under the box', { skip: !ffmpeg, timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec-frame-'));
  try {
    const px = await exported(dir, { padding: 0.25, radius: 0, shadow: 1, border: 0, borderColor: '#ffffff', bg: { kind: 'gradient', from: '#404040', to: '#f0f0f0', angle: 0 } });
    const left = px(6, 20);
    const right = px(310, 20);
    assert.ok(Math.abs(left[0] - 0x44) < 16, `left edge is near the first colour: ${left}`);
    assert.ok(Math.abs(right[0] - 0xec) < 16, `right edge is near the second colour: ${right}`);
    // Same x, so the same gradient colour: under the box (shadow) is darker than far above it.
    const far = px(160, 6);
    const under = px(160, 182);
    assert.ok(far[0] - under[0] > 30, `shadow below the box: far ${far}, under ${under}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real export: no background lets the track below show in the margin', { skip: !ffmpeg, timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec-frame-'));
  try {
    const px = await exported(dir, { padding: 0.25, radius: 0.1, shadow: 0, border: 0, borderColor: '#ffffff', bg: { kind: 'none' } }, true);
    const centre = px(160, 120);
    const margin = px(20, 120);
    assert.ok(centre[0] > 200 && centre[2] < 60, `the framed clip is on top in the middle: ${centre}`);
    assert.ok(margin[2] > 200 && margin[0] < 60, `the blue clip below shows in the margin: ${margin}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
