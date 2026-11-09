// After Effects features: keyframe interpolation, expressions (wiggle / loop / overshoot), effect stack,
// track matte and blend modes. The ffmpeg expressions are evaluated by ffmpeg itself and compared with the JS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const anim = require('../src/lib/anim.js');
const { buildExport, runExport } = require('../electron/render.cjs');
const ffmpegOk = spawnSync('ffmpeg', ['-version']).status === 0;

test('eases: linear, hold, easy ease, custom bezier', () => {
  assert.equal(anim.easeAt({ ease: 'linear' }, 0.3), 0.3);
  assert.equal(anim.easeAt({ ease: 'hold' }, 0.99), 0);
  assert.ok(Math.abs(anim.easeAt({ ease: 'easy' }, 0.5) - 0.5) < 1e-3, 'easy ease is symmetric');
  assert.ok(anim.easeAt({ ease: 'easy' }, 0.1) < 0.05, 'easy ease starts slowly');
  assert.ok(anim.easeAt({ ease: 'easy_in' }, 0.9) > anim.easeAt({ ease: 'easy_out' }, 0.9), 'easy in arrives slowly, so it is further along at 0.9');
  const bz = anim.easeAt({ ease: 'bezier', bz: [0.25, 0.1, 0.25, 1] }, 0.5);
  assert.ok(Math.abs(bz - 0.8024) < 0.01, `css "ease" at 0.5 is ~0.802, got ${bz}`);
});

test('loop and overshoot in JS', () => {
  const clip = { id: 'c', keyframes: { zoom: [{ t: 0, v: 1 }, { t: 1, v: 2, ease: 'linear' }] }, mods: { zoom: { type: 'loop', mode: 'cycle' } } };
  clip.keyframes.zoom[0].ease = 'linear';
  assert.ok(Math.abs(anim.propAt(clip, 'zoom', 1.25, 1) - 1.25) < 1e-9);
  clip.mods.zoom = { type: 'loop', mode: 'pingpong' };
  assert.ok(Math.abs(anim.propAt(clip, 'zoom', 1.25, 1) - 1.75) < 1e-9);
  clip.mods.zoom = { type: 'overshoot', amp: 0.3, freq: 3, decay: 5 };
  assert.ok(anim.propAt(clip, 'zoom', 1.08, 1) > 2, 'overshoots past the last value');
});

/** Evaluate an ffmpeg expression of T at frames 0..n-1 of a 10 fps stream (value*100 as luma). */
function ffEval(expr, n = 20, scale = 100, offset = 0) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=s=2x2:r=10:d=${n / 10}`, '-vf', `format=gray,geq=lum='clip((${expr})*${scale}+${offset},0,255)'`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer', maxBuffer: 1 << 20 });
  assert.equal(r.status, 0, String(r.stderr));
  const out = [];
  for (let i = 0; i < n; i++) out.push(r.stdout[i * 4]);
  return out;
}

test('preview and export compute the same values (every ease and modifier)', { skip: !ffmpegOk, timeout: 60000 }, () => {
  const kf = [
    { t: 0.1, v: 0.2, ease: 'easy' },
    { t: 0.6, v: 1.5, ease: 'bezier', bz: [0.7, 0, 0.2, 1.3] },
    { t: 1.1, v: 0.4, ease: 'hold' },
    { t: 1.4, v: 1.0, ease: 'easy_out' },
    { t: 1.8, v: 0.3 },
  ];
  const cases = [
    { id: 'a', keyframes: { zoom: kf } },
    { id: 'b', keyframes: { zoom: kf.slice(0, 3) }, mods: { zoom: { type: 'loop', mode: 'pingpong' } } },
    { id: 'c', keyframes: { zoom: kf }, mods: { zoom: { type: 'wiggle', freq: 3, amp: 0.3 } } },
    { id: 'd', keyframes: { zoom: kf }, mods: { zoom: { type: 'overshoot', amp: 0.4, freq: 4, decay: 4 } } },
  ];
  for (const clip of cases) {
    const vals = ffEval(anim.propExpr(clip, 'zoom', 1, 'T'), 20, 100, 30);
    vals.forEach((got, i) => {
      const want = Math.max(0, Math.min(255, Math.round(anim.propAt(clip, 'zoom', i / 10, 1) * 100 + 30)));
      assert.ok(Math.abs(got - want) <= 1, `${clip.id} t=${i / 10}: export ${got} vs preview ${want}`);
    });
  }
});

test('export graph: blend, matte and effects are in the command', () => {
  const p = {
    canvas: { w: 1080, h: 1920, fps: 30 },
    media: [{ id: 'm', path: 'a.mp4', kind: 'video', duration: 10, hasAudio: false }],
    tracks: [
      { id: 'v1', kind: 'video', clips: [{ id: 'a', mediaId: 'm', start: 0, in: 0, out: 2 }] },
      { id: 'v2', kind: 'video', clips: [{ id: 'b', mediaId: 'm', start: 0.5, in: 0, out: 1, blend: 'screen', matte: { kind: 'media', mediaId: 'm', mode: 'luma' }, effects: [{ id: 'e1', type: 'shadow', color: '#000000', opacity: 0.6, distance: 0.01, angle: 135, softness: 0.01 }, { id: 'e2', type: 'glow', radius: 0.02, intensity: 0.5 }, { id: 'e3', type: 'sweep', color: '#FFFFFF', angle: 20, width: 0.1, intensity: 0.6, start: 0, duration: 1 }, { id: 'e4', type: 'gradient', c0: '#D4AF37', c1: '#83163A', x0: 0.5, y0: 0, x1: 0.5, y1: 1, opacity: 0.3 }] }] },
    ],
  };
  const fc = buildExport(p, 'o.mp4').args.find((a) => a.includes('[base0]'));
  assert.match(fc, /blend=all_mode=screen\[bl1\]/);
  assert.match(fc, /tpad=start_duration=0.5:color=black@0/);
  assert.match(fc, /lutrgb=r=0:g=0:b=0,gblur/);
  assert.match(fc, /blend=all_mode=screen:all_opacity=0.5/);
  assert.match(fc, /geq=r='min\(255,r\(X,Y\)\+255\*/);
  assert.match(fc, /gradients=s=1080x1920/);
  assert.match(fc, /format=gray\[mk1_m\]/);
});

test('real export: text matte, every effect, every blend mode, eased keyframes', { skip: !ffmpegOk, timeout: 240000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec-ae-'));
  try {
    const src = join(dir, 'src.mp4');
    spawnSync('ffmpeg', ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
    const modes = ['multiply', 'screen', 'overlay', 'add', 'lighten', 'darken', 'difference'];
    const p = {
      name: 'ae',
      canvas: { w: 360, h: 640, fps: 30 },
      media: [{ id: 'm', path: src, kind: 'video', duration: 6, width: 640, height: 360, hasAudio: false }],
      tracks: [
        { id: 'v1', kind: 'video', clips: [{ id: 'a', mediaId: 'm', start: 0, in: 0, out: 3.5, keyframes: { zoom: [{ t: 0, v: 1, ease: 'easy' }, { t: 1, v: 1.4, ease: 'bezier', bz: [0.7, 0, 0.2, 1] }, { t: 2, v: 1.1 }], rotate: [{ t: 0, v: -5, ease: 'linear' }, { t: 2, v: 5 }] }, mods: { x: { type: 'wiggle', freq: 2, amp: 0.02 } } }] },
        {
          id: 'v2',
          kind: 'video',
          clips: modes.map((mode, i) => ({ id: `b${i}`, mediaId: 'm', start: i * 0.5, in: 1, out: 1.5, fit: 'fit', blend: mode, ...(i === 0 ? { matte: { kind: 'text', text: 'CASA', size: 0.25, y: 0.5 } } : {}), effects: [{ id: 's', type: 'shadow', color: '#000000', opacity: 0.7, distance: 0.02, angle: 135, softness: 0.01 }, { id: 'g', type: 'glow', radius: 0.02, intensity: 0.5 }, { id: 'w', type: 'sweep', color: '#FFFFFF', angle: 20, width: 0.1, intensity: 0.6, start: 0, duration: 0.5 }, { id: 'r', type: 'gradient', c0: '#D4AF37', c1: '#83163A', x0: 0.5, y0: 0, x1: 0.5, y1: 1, opacity: 0.3 }] })),
        },
      ],
    };
    const out = join(dir, 'out.mp4');
    await runExport(p, out);
    assert.ok(existsSync(out) && statSync(out).size > 5000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
