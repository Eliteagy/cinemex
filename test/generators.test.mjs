// Generators (Efeitos > Geradores): adjustment layer, solid colour and Fusion composition, in a real export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { GEN_KINDS, genColor, genMedia, genSource, hasPicture, isGen, newComp } from '../src/lib/generators.js';

const require = createRequire(import.meta.url);
const { runExport, buildExport } = require('../electron/render.cjs');
const noFfmpeg = spawnSync('ffmpeg', ['-version']).status !== 0;

test('what a generator is', () => {
  assert.deepEqual(GEN_KINDS, ['adjustment', 'solid', 'fusion']);
  assert.equal(isGen({ gen: 'solid' }), true);
  assert.equal(isGen({ gen: 'solid', mediaId: 'm' }), false, 'a clip with a file is not a generator');
  assert.equal(isGen({ text: 'x' }), false);
  assert.equal(hasPicture({ gen: 'adjustment' }), false);
  assert.equal(hasPicture({ gen: 'fusion' }), true);
  assert.equal(genColor({ gen: 'solid', genColor: '#ff8800' }), '#FF8800');
  assert.equal(genColor({ gen: 'solid', genColor: 'red' }), '#000000');
  const canvas = { w: 320, h: 240, fps: 30 };
  assert.equal(genMedia({ id: 'a', gen: 'adjustment' }, canvas), null);
  assert.deepEqual([genMedia({ id: 's', gen: 'solid' }, canvas).kind, genMedia({ id: 's', gen: 'solid' }, canvas).width], ['image', 320]);
  assert.match(genSource({ gen: 'solid', genColor: '#102030' }, 320, 240, 30), /^color=c=0x102030:s=320x240:r=30$/);
  assert.match(genSource({ gen: 'fusion' }, 320, 240, 30), /black@0\.0.*format=rgba/);
  assert.deepEqual(newComp().nodes.map((n) => n.type), ['mediaOut']);
});

const canvas = { w: 320, h: 240, fps: 30, preset: '16:9' };
/** Average colour of a small square of the frame at time t. */
const pixel = (file, t, x, y) => [...spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=8:8:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' }).stdout];

test('real export: solid colour, with opacity and over footage', { skip: noFfmpeg, timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec-gen-'));
  try {
    const src = join(dir, 'red.mp4');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]).status, 0);
    const p = {
      name: 'gen', canvas,
      media: [{ id: 'v', path: src, kind: 'video', duration: 3, hasAudio: false }],
      tracks: [
        { id: 'v1', kind: 'video', name: 'V1', clips: [{ id: 'a', mediaId: 'v', start: 0, in: 0, out: 3, fit: 'fill' }] },
        // 0-1 s nothing over the red, 1-2 s solid blue, 2-3 s solid black at half opacity
        { id: 'v2', kind: 'video', name: 'V2', clips: [
          { id: 's1', start: 1, in: 0, out: 1, gen: 'solid', genColor: '#0000FF' },
          { id: 's2', start: 2, in: 0, out: 1, gen: 'solid', genColor: '#000000', keyframes: { opacity: [{ t: 0, v: 0.5 }] } },
        ] },
      ],
    };
    const out = join(dir, 'out.mp4');
    await runExport(p, out);
    const red = pixel(out, 0.5, 100, 100);
    const blue = pixel(out, 1.5, 100, 100);
    const dim = pixel(out, 2.5, 100, 100);
    assert.ok(red[0] > 200 && red[2] < 60, `footage alone: ${red}`);
    assert.ok(blue[2] > 200 && blue[0] < 60, `solid blue covers it: ${blue}`);
    assert.ok(dim[0] > 90 && dim[0] < 170 && dim[2] < 60, `half black darkens the red: ${dim}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real export: an adjustment layer grades what is under it, only while it lasts', { skip: noFfmpeg, timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec-adj-'));
  try {
    const src = join(dir, 'red.mp4');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xC04040:s=320x240:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]).status, 0);
    const p = {
      name: 'adj', canvas,
      media: [{ id: 'v', path: src, kind: 'video', duration: 3, hasAudio: false }],
      tracks: [
        { id: 'v1', kind: 'video', name: 'V1', clips: [{ id: 'a', mediaId: 'v', start: 0, in: 0, out: 3, fit: 'fill' }] },
        { id: 'v2', kind: 'video', name: 'V2', clips: [{ id: 'adj', start: 1, in: 0, out: 1, gen: 'adjustment', color: { saturation: -1 } }] },
      ],
    };
    const { args } = buildExport(p, 'o.mp4');
    assert.equal(args.filter((a) => a === '-i').length, 1, 'the adjustment layer is no input');
    const out = join(dir, 'out.mp4');
    await runExport(p, out);
    const before = pixel(out, 0.5, 100, 100);
    const during = pixel(out, 1.5, 100, 100);
    const after = pixel(out, 2.5, 100, 100);
    const spread = (c) => Math.max(...c) - Math.min(...c);
    assert.ok(spread(before) > 80, `colour before the layer: ${before}`);
    assert.ok(spread(during) < 25, `no colour under the layer: ${during}`);
    assert.ok(spread(after) > 80, `colour again after it: ${after}`);
    // A layer without a grade changes nothing and adds nothing to the command.
    p.tracks[1].clips[0].color = undefined;
    assert.doesNotMatch(buildExport(p, 'o.mp4').args.join(' '), /adj0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real export: a Fusion composition draws its nodes; empty it shows what is under it', { skip: noFfmpeg, timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec-comp-'));
  try {
    const src = join(dir, 'red.mp4');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]).status, 0);
    const comp = newComp();
    comp.nodes.push({ id: 'bg', type: 'background', x: 100, y: 90, p: { color: '#00FF00' } });
    comp.links.push({ from: 'bg', to: 'out', port: 0 });
    const p = {
      name: 'comp', canvas,
      media: [{ id: 'v', path: src, kind: 'video', duration: 2, hasAudio: false }],
      tracks: [
        { id: 'v1', kind: 'video', name: 'V1', clips: [{ id: 'a', mediaId: 'v', start: 0, in: 0, out: 2, fit: 'fill' }] },
        { id: 'v2', kind: 'video', name: 'V2', clips: [
          { id: 'f0', start: 0, in: 0, out: 1, gen: 'fusion', fusion: newComp() },
          { id: 'f1', start: 1, in: 0, out: 1, gen: 'fusion', fusion: comp },
        ] },
      ],
    };
    const out = join(dir, 'out.mp4');
    await runExport(p, out);
    const empty = pixel(out, 0.5, 100, 100);
    const green = pixel(out, 1.5, 100, 100);
    assert.ok(empty[0] > 200 && empty[1] < 60, `an empty composition is transparent: ${empty}`);
    assert.ok(green[1] > 200 && green[0] < 60, `the background node of the composition: ${green}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Fusion nodes a composition is built with: Background gradients, Rectangle and Ellipse masks, Merge with a mask.
const ffxLib = await import('../src/lib/fusionfx.js');

test('Background gradient and shape mask maths', () => {
  const { gradT, gradRGB, shapeAlpha } = ffxLib;
  const W = 400, H = 200;
  assert.equal(gradT(10, 10, W, H, { type: 'solid' }), 0);
  assert.ok(gradT(0, 100, W, H, { type: 'horizontal' }) < 0.01 && gradT(400, 100, W, H, { type: 'horizontal' }) > 0.99);
  assert.ok(Math.abs(gradT(200, 50, W, H, { type: 'horizontal' }) - 0.5) < 1e-9);
  assert.ok(gradT(200, 0, W, H, { type: 'vertical' }) < 0.01 && gradT(200, 200, W, H, { type: 'vertical' }) > 0.99);
  assert.equal(gradT(200, 100, W, H, { type: 'radial' }), 0);
  assert.deepEqual(gradRGB(400, 100, W, H, { type: 'horizontal', color: '#000000', color2: '#FF8000' }).map(Math.round), [255, 128, 0]);
  const box = { x: 0.5, y: 0.5, width: 0.5, height: 0.5 };
  assert.equal(shapeAlpha(200, 100, W, H, box, 'rectangle'), 1);
  assert.equal(shapeAlpha(20, 100, W, H, box, 'rectangle'), 0);
  assert.equal(shapeAlpha(110, 60, W, H, box, 'rectangle'), 1, 'a corner of the rectangle');
  assert.equal(shapeAlpha(105, 55, W, H, box, 'ellipse'), 0, 'the same corner is outside the ellipse');
  assert.equal(shapeAlpha(20, 100, W, H, { ...box, invert: true }, 'rectangle'), 1);
  // A soft edge is a ramp, half way on the outline.
  assert.ok(Math.abs(shapeAlpha(300, 100, W, H, { ...box, soft: 0.5 }, 'rectangle') - 0.5) < 1e-9);
});

test('real export: a composition with a gradient background seen through an ellipse mask', { skip: noFfmpeg, timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec-nodes-'));
  try {
    const src = join(dir, 'red.mp4');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]).status, 0);
    // empty <- merge(frente = gradient black -> blue, left to right; máscara = ellipse in the middle) -> out
    const comp = {
      nodes: [
        { id: 'out', type: 'mediaOut', x: 560, y: 90, p: {} },
        { id: 'bg', type: 'background', x: 100, y: 90, p: { type: 'horizontal', color: '#000000', color2: '#0000FF' } },
        { id: 'el', type: 'ellipse', x: 100, y: 200, p: { width: 0.5, height: 0.5 } },
        { id: 'mg', type: 'merge', x: 340, y: 90, p: {} },
      ],
      links: [
        { from: 'bg', to: 'mg', port: 1 },
        { from: 'el', to: 'mg', port: 2 },
        { from: 'mg', to: 'out', port: 0 },
      ],
    };
    const p = {
      name: 'nodes', canvas,
      media: [{ id: 'v', path: src, kind: 'video', duration: 2, hasAudio: false }],
      tracks: [
        { id: 'v1', kind: 'video', name: 'V1', clips: [{ id: 'a', mediaId: 'v', start: 0, in: 0, out: 2, fit: 'fill' }] },
        { id: 'v2', kind: 'video', name: 'V2', clips: [{ id: 'f1', start: 0, in: 0, out: 2, gen: 'fusion', fusion: comp }] },
      ],
    };
    const out = join(dir, 'out.mp4');
    await runExport(p, out);
    const outside = pixel(out, 1, 10, 10);
    const leftIn = pixel(out, 1, 100, 116);
    const rightIn = pixel(out, 1, 215, 116);
    assert.ok(outside[0] > 200 && outside[2] < 60, `outside the ellipse the footage under the composition shows: ${outside}`);
    assert.ok(leftIn[0] < 60, `inside the ellipse the gradient covers the red: ${leftIn}`);
    assert.ok(rightIn[2] > leftIn[2] + 60, `the gradient gets bluer to the right: ${leftIn} -> ${rightIn}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Keyframes on node settings: the composition moves.
test('animated node settings: value over time, and what counts as animated', () => {
  const { nodeNum, nodeAnimated, nodeExpr } = ffxLib;
  const n = { id: 't', type: 'transform', p: { x: 0.2 }, k: { x: [{ t: 0, v: -0.5, ease: 'linear' }, { t: 2, v: 0.5, ease: 'linear' }], scale: [{ t: 1, v: 2 }] } };
  assert.equal(nodeAnimated(n, 'x'), true);
  assert.equal(nodeAnimated(n, 'scale'), false, 'one keyframe is a fixed value');
  assert.equal(nodeAnimated(n, 'rotate'), false);
  assert.equal(nodeNum(n, 'x', 0, 0), -0.5);
  assert.ok(Math.abs(nodeNum(n, 'x', 0, 1)) < 1e-9, 'half way');
  assert.equal(nodeNum(n, 'x', 0, 5), 0.5, 'held after the last keyframe');
  assert.equal(nodeNum(n, 'scale', 1, 0), 2);
  assert.equal(nodeNum(n, 'rotate', 0, 1), 0, 'no keyframes, no fixed value: the default');
  assert.equal(nodeNum({ p: { rotate: 30 } }, 'rotate', 0, 1), 30);
  assert.equal(nodeExpr(n, 'scale', 1), '2');
  assert.match(nodeExpr(n, 'x', 0), /^\(st\(0,t\)/);
});

test('real export: a Transform node with keyframes moves the picture, an animated Merge opacity fades it', { skip: noFfmpeg, timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec-anim-'));
  try {
    const src = join(dir, 'red.mp4');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]).status, 0);
    const lin = (a, b) => [{ t: 0, v: a, ease: 'linear' }, { t: 2, v: b, ease: 'linear' }];
    // 0-2 s: a green frame slides from the left half to the right half.
    const slide = {
      nodes: [
        { id: 'out', type: 'mediaOut', x: 560, y: 90, p: {} },
        { id: 'bg', type: 'background', x: 60, y: 90, p: { color: '#00FF00' } },
        { id: 'tf', type: 'transform', x: 300, y: 90, p: {}, k: { x: lin(-0.5, 0.5) } },
      ],
      links: [{ from: 'bg', to: 'tf', port: 0 }, { from: 'tf', to: 'out', port: 0 }],
    };
    // 2-4 s: a blue frame fades in over the footage.
    const fade = {
      nodes: [
        { id: 'out', type: 'mediaOut', x: 560, y: 90, p: {} },
        { id: 'bg', type: 'background', x: 60, y: 90, p: { color: '#0000FF' } },
        { id: 'mg', type: 'merge', x: 300, y: 90, p: {}, k: { opacity: lin(0, 1) } },
      ],
      links: [{ from: 'bg', to: 'mg', port: 1 }, { from: 'mg', to: 'out', port: 0 }],
    };
    const p = {
      name: 'anim', canvas,
      media: [{ id: 'v', path: src, kind: 'video', duration: 4, hasAudio: false }],
      tracks: [
        { id: 'v1', kind: 'video', name: 'V1', clips: [{ id: 'a', mediaId: 'v', start: 0, in: 0, out: 4, fit: 'fill' }] },
        { id: 'v2', kind: 'video', name: 'V2', clips: [
          { id: 'f1', start: 0, in: 0, out: 2, gen: 'fusion', fusion: slide },
          { id: 'f2', start: 2, in: 0, out: 2, gen: 'fusion', fusion: fade },
        ] },
      ],
    };
    const out = join(dir, 'out.mp4');
    await runExport(p, out);
    const isGreen = (c) => c[1] > 180 && c[0] < 80;
    const isRed = (c) => c[0] > 180 && c[1] < 80;
    const early = [pixel(out, 0.1, 40, 100), pixel(out, 0.1, 280, 100)];
    const late = [pixel(out, 1.9, 40, 100), pixel(out, 1.9, 280, 100)];
    assert.ok(isGreen(early[0]) && isRed(early[1]), `start: green on the left, footage on the right: ${early.join(' | ')}`);
    assert.ok(isRed(late[0]) && isGreen(late[1]), `end: footage on the left, green on the right: ${late.join(' | ')}`);
    const f0 = pixel(out, 2.1, 100, 100);
    const f1 = pixel(out, 3.0, 100, 100);
    const f2 = pixel(out, 3.9, 100, 100);
    assert.ok(f0[0] > 200 && f0[2] < 50, `fade start: the footage: ${f0}`);
    assert.ok(f1[0] > 80 && f1[0] < 180 && f1[2] > 80 && f1[2] < 180, `half way: half red, half blue: ${f1}`);
    assert.ok(f2[2] > 200 && f2[0] < 50, `fade end: blue: ${f2}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
