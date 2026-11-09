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
