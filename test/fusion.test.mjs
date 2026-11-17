import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { runExport } = require('../electron/render.cjs');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('Fusion graph: chroma key over a background, glow, transform, letterbox, media node', { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec-fusion-'));
  try {
    // Green frame with a white square in the middle (the "person").
    const green = join(dir, 'green.mp4');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00FF00:s=320x240:r=30:d=1', '-vf', 'drawbox=x=130:y=90:w=60:h=60:color=white:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', green]).status, 0);
    const blue = join(dir, 'blue.png');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x0000FF:s=64x48', '-frames:v', '1', blue]).status, 0);
    const fusion = (nodes, links) => ({ nodes: [{ id: 'in', type: 'mediaIn', x: 0, y: 0, p: {} }, { id: 'out', type: 'mediaOut', x: 0, y: 0, p: {} }, ...nodes], links });
    const run = async (f) => {
      const p = {
        name: 'f', canvas: { w: 320, h: 240, fps: 30, preset: '16:9' },
        media: [{ id: 'g', path: green, kind: 'video', duration: 1, hasAudio: false }, { id: 'b', path: blue, kind: 'image', duration: 5, hasAudio: false }],
        tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'a', mediaId: 'g', start: 0, in: 0, out: 1, fit: 'fill', fusion: f }] }],
      };
      const out = join(dir, `o${Math.random().toString(36).slice(2)}.mp4`);
      await runExport(p, out);
      return (x, y) => [...spawnSync('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', out, '-frames:v', '1', '-vf', `crop=2:2:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e6 }).stdout];
    };

    // Green screen: key the green out and put the clip over a red background.
    const key = await run(fusion(
      [{ id: 'k', type: 'chroma', x: 0, y: 0, p: { key: '#00FF00', similarity: 0.2, blend: 0.05 } }, { id: 'bg', type: 'background', x: 0, y: 0, p: { color: '#FF0000' } }, { id: 'm', type: 'merge', x: 0, y: 0, p: {} }],
      [{ from: 'in', to: 'k', port: 0 }, { from: 'bg', to: 'm', port: 0 }, { from: 'k', to: 'm', port: 1 }, { from: 'm', to: 'out', port: 0 }],
    ));
    const corner = key(10, 10);
    const centre = key(159, 119);
    assert.ok(corner[0] > 200 && corner[1] < 60, `green replaced by red: ${corner}`);
    assert.ok(centre.every((v) => v > 200), `subject kept: ${centre}`);

    // Media node (image) as background, clip shrunk to half and moved right, letterbox on top.
    const comp = await run(fusion(
      [{ id: 'img', type: 'media', x: 0, y: 0, p: { mediaId: 'b' } }, { id: 't', type: 'transform', x: 0, y: 0, p: { scale: 0.5, x: 0.25 } }, { id: 'm', type: 'merge', x: 0, y: 0, p: {} }, { id: 'lb', type: 'letterbox', x: 0, y: 0, p: { ratio: 2.39 } }, { id: 'gl', type: 'glow', x: 0, y: 0, p: { amount: 0.5 } }],
      [{ from: 'in', to: 't', port: 0 }, { from: 'img', to: 'm', port: 0 }, { from: 't', to: 'm', port: 1 }, { from: 'm', to: 'gl', port: 0 }, { from: 'gl', to: 'lb', port: 0 }, { from: 'lb', to: 'out', port: 0 }],
    ));
    const left = comp(40, 120);
    const right = comp(200, 120);
    const top = comp(160, 4);
    assert.ok(left[2] > 200 && left[1] < 90, `image node behind: ${left}`);
    assert.ok(right[1] > 150, `shrunk clip moved right: ${right}`);
    assert.ok(top.every((v) => v < 20), `letterbox bar: ${top}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PhotoCraft nodes: weights, flare and relight formulas', async () => {
  const F = await import('../src/lib/fusionfx.js');
  // tilt-shift: sharp on the focus line, blurred far from it
  const tp = { y: 0.5, angle: 0, focus: 0.1, transition: 0.1 };
  assert.equal(F.tiltWeight(100, 120, 320, 240, tp), 0);
  assert.equal(F.tiltWeight(100, 5, 320, 240, tp), 1);
  // iris: sharp in the centre, blurred in the corner, superellipse squarer with roundness
  const ip = { x: 0.5, y: 0.5, size: 0.3, aspect: 1, roundness: 0, feather: 0.5 };
  assert.equal(F.irisWeight(160, 120, 320, 240, ip), 0);
  assert.equal(F.irisWeight(2, 2, 320, 240, ip), 1);
  assert.ok(F.irisWeight(160 + 60, 120 + 60, 320, 240, { ...ip, roundness: 1 }) < F.irisWeight(160 + 60, 120 + 60, 320, 240, ip));
  assert.deepEqual(F.levelWeights(0.25), [0.5, 0]);
  assert.deepEqual(F.levelWeights(0.75), [1, 0.5]);
  // flare: bright core at its position, dark far away, streak only when asked
  const fp = { x: 0.3, y: 0.3, brightness: 1 };
  assert.ok(F.flareRGB(96, 72, 320, 240, fp).every((v) => v > 0.9));
  assert.ok(F.flareRGB(300, 230, 320, 240, fp)[0] < 0.1);
  assert.ok(F.flareRGB(200, 72, 320, 240, { ...fp, streak: true })[2] > F.flareRGB(200, 72, 320, 240, fp)[2] + 0.05);
  // relight on a flat grey: n = (0, 0, 1), F = (ambient + intensity·sin e) / S
  const q = F.relightParams({ angle: 0, elevation: 90, intensity: 0.4, ambient: 0.2, softness: 50, warmth: 0, amount: 1 }, 240);
  assert.ok(Math.abs(F.relightFactor(0.5, 0.5, 0.5, 0.5, 0.5, q) - 1.2) < 1e-9);
  assert.ok(Math.abs(F.relightJS(0.5, 1.2, 0, q) - 0.6) < 1e-9);
});

test('PhotoCraft nodes in the export: tilt-shift, iris, lens flare, relight', { skip: !hasFfmpeg }, async () => {
  const F = await import('../src/lib/fusionfx.js');
  const dir = mkdtempSync(join(tmpdir(), 'ec-fusion2-'));
  try {
    const pattern = join(dir, 'p.mp4');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=1', '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', pattern]).status, 0);
    const greyF = join(dir, 'g.png');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x808080:s=320x240', '-frames:v', '1', greyF]).status, 0);
    const ramp = join(dir, 'r.png');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240,format=gray,geq=lum=40+X/2', '-frames:v', '1', ramp]).status, 0);
    const node = (type, p) => ({ nodes: [{ id: 'in', type: 'mediaIn', x: 0, y: 0, p: {} }, { id: 'out', type: 'mediaOut', x: 0, y: 0, p: {} }, { id: 'n', type, x: 0, y: 0, p }], links: [{ from: 'in', to: 'n', port: 0 }, { from: 'n', to: 'out', port: 0 }] });
    const frame = async (file, kind, f) => {
      const p = {
        name: 'f', canvas: { w: 320, h: 240, fps: 30 },
        media: [{ id: 'm', path: file, kind, duration: 1, hasAudio: false }],
        tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'a', mediaId: 'm', start: 0, in: 0, out: 0.5, fit: 'fill', ...(f ? { fusion: f } : {}) }] }],
      };
      const out = join(dir, `o${Math.random().toString(36).slice(2)}.mp4`);
      await runExport(p, out);
      const raw = spawnSync('ffmpeg', ['-v', 'error', '-ss', '0.2', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 }).stdout;
      return { at: (x, y) => [...raw.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)], raw };
    };
    // fine detail of a horizontal band of rows
    const fine = (fr, y0, y1) => {
      let s = 0;
      for (let y = y0; y < y1; y++) for (let x = 0; x < 319; x++) for (let c = 0; c < 3; c++) s += Math.abs(fr.raw[(y * 320 + x + 1) * 3 + c] - fr.raw[(y * 320 + x) * 3 + c]);
      return s / ((y1 - y0) * 319 * 3);
    };
    const ref = await frame(pattern, 'video', null);
    const ts = await frame(pattern, 'video', node('tiltshift', { blur: 1, y: 0.5, focus: 0.08, transition: 0.1 }));
    assert.ok(fine(ts, 110, 130) > fine(ref, 110, 130) * 0.85, 'focus band stays sharp');
    assert.ok(fine(ts, 0, 30) < fine(ref, 0, 30) * 0.6, `top blurred ${fine(ts, 0, 30)} vs ${fine(ref, 0, 30)}`);
    const ir = await frame(pattern, 'video', node('irisblur', { blur: 1, size: 0.25, feather: 0.4 }));
    assert.ok(fine(ir, 0, 20) < fine(ref, 0, 20) * 0.6, 'outside the iris blurred');
    // flare: the export equals screen(picture, flareRGB) at a few pixels
    const fl = await frame(greyF, 'image', node('lensflare', { x: 0.3, y: 0.3, brightness: 1.2 }));
    for (const [x, y] of [[96, 72], [200, 150], [300, 20], [160, 120]]) {
      const f = F.flareRGB(x + 0.5, y + 0.5, 320, 240, { x: 0.3, y: 0.3, brightness: 1.2 });
      const exp = f.map((v) => 255 * (1 - (1 - 128 / 255) * (1 - v)));
      fl.at(x, y).forEach((v, i) => assert.ok(Math.abs(v - exp[i]) < 14, `flare at ${x},${y}: ${fl.at(x, y)} vs ${exp.map(Math.round)}`));
    }
    // relight: flat grey lit from straight above -> × 1.2
    const rl = await frame(greyF, 'image', node('relight', { elevation: 90, intensity: 0.4, ambient: 0.2 }));
    assert.ok(rl.at(160, 120).every((v) => Math.abs(v - 154) < 6), `flat grey relit: ${rl.at(160, 120)}`);
    const warm = await frame(greyF, 'image', node('relight', { elevation: 90, warmth: 1 }));
    assert.ok(warm.at(160, 120)[0] > warm.at(160, 120)[2] + 30, `warm light: ${warm.at(160, 120)}`);
    // on a ramp (brighter to the right) a light from the left lights the slope more than one from the right
    const fromLeft = await frame(ramp, 'image', node('relight', { angle: 180, elevation: 20, intensity: 1, softness: 30 }));
    const fromRight = await frame(ramp, 'image', node('relight', { angle: 0, elevation: 20, intensity: 1, softness: 30 }));
    assert.ok(fromLeft.at(160, 120)[0] > fromRight.at(160, 120)[0] + 5, `${fromLeft.at(160, 120)} vs ${fromRight.at(160, 120)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
