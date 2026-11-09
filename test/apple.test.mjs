// apple.com techniques: cubic-bezier eases, gradient-sweep headline, mask reveal and frosted glass card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { buildExport, buildAss, runExport } = require('../electron/render.cjs');
const { graphicEvents, eventAt, colorAt, mixColor, roundRectPath, SWEEP, GRAPHIC_KINDS } = require('../src/lib/graphics.js');
const { EASES, easeAt, kfAt, kfExpr } = require('../src/lib/anim.js');

const ffmpegOk = spawnSync('ffmpeg', ['-version']).status === 0;

test('apple eases: calm in-out, fast reveal, overshoot', () => {
  for (const e of ['apple', 'apple_out', 'apple_pop']) assert.ok(EASES.includes(e), e);
  const k = (ease) => ({ t: 0, v: 0, ease });
  assert.ok(Math.abs(easeAt(k('apple'), 0.5) - 0.5) < 0.01, 'symmetric');
  assert.ok(easeAt(k('apple'), 0.2) < 0.15, 'starts slowly');
  assert.ok(easeAt(k('apple_out'), 0.2) > 0.5, 'reveal starts fast');
  const peak = Math.max(...Array.from({ length: 50 }, (_, i) => easeAt(k('apple_pop'), i / 49)));
  assert.ok(peak > 1.05, 'pop goes past the value');
  assert.equal(easeAt(k('apple_pop'), 1), 1);
  // The export expression uses the same curve numbers as the preview.
  assert.match(kfExpr([{ t: 0, v: 1, ease: 'apple_out' }, { t: 2, v: 2 }], 1), /0\.165/);
  assert.ok(Math.abs(kfAt([{ t: 0, v: 0, ease: 'apple' }, { t: 2, v: 1 }], 1, 0) - 0.5) < 0.01);
});

test('apple graphics: kinds, sweep colours, reveal mask, glass card', () => {
  for (const k of ['headline', 'reveal', 'glass']) assert.ok(GRAPHIC_KINDS.includes(k), k);
  const head = graphicEvents({ kind: 'headline', title: 'Feito para criar.', accent: '#5326E3', color: '#FFFFFF' }, 4, 1920, 1080);
  assert.equal(head.length, SWEEP.strips);
  // Every strip ends on the text colour; at the start the strips differ (a gradient across the text).
  for (const e of head) assert.equal(colorAt(e.colors, 99999), '#FFFFFF');
  assert.notEqual(colorAt(head[0].colors, 0), colorAt(head[head.length - 1].colors, 0));
  assert.equal(mixColor('#000000', '#FFFFFF', 0.5), '#808080');
  const rev = graphicEvents({ kind: 'reveal', title: 'Pequeno.', subtitle: 'Gigante.' }, 4, 1920, 1080);
  assert.equal(rev.length, 2);
  assert.ok(rev[1].t0 > rev[0].t0, 'second line comes after the first');
  const shut = eventAt(rev[0], 0).clip;
  const open = eventAt(rev[0], 1).clip;
  assert.ok(shut[3] - shut[1] < 2 && open[3] - open[1] > 100, 'mask opens upwards');
  const gl = graphicEvents({ kind: 'glass', title: 'T3 em Lisboa', subtitle: 'Vista rio' }, 4, 1920, 1080);
  assert.equal(gl[0].kind, 'glass');
  assert.ok(gl[0].w % 2 === 0 && gl[0].h % 2 === 0);
  assert.match(roundRectPath(100, 50, 10), /^m 10 0 l 90 0 b /);
});

const project = (graphic) => ({
  canvas: { w: 640, h: 360, fps: 30 },
  media: [{ id: 'm', path: 'color', kind: 'image', duration: 3 }],
  tracks: [{ id: 't', kind: 'text', clips: [{ id: 'g', start: 0, in: 0, out: 3, text: '', graphic }] }],
});

test('apple graphics -> ASS and filter graph', () => {
  const ass = buildAss(project({ kind: 'headline', title: 'Olá', accent: '#5326E3' }), { userFonts: false });
  assert.match(ass, /\\clip\(\d+,0,\d+,360\)/);
  assert.match(ass, /\\t\(\d+,\d+,\\1c&H00FFFFFF\)/, 'sweep ends on white');
  assert.match(ass, /\\t\(0,1000,0\.35,\\fscx100\\fscy100\)/, 'eased scale-in');
  const rev = buildAss(project({ kind: 'reveal', title: 'Olá', subtitle: 'Mundo' }), { userFonts: false });
  assert.match(rev, /\\t\(0,700,0\.4,\\clip\(0,\d+,640,\d+\)\)/);
  const gl = buildAss(project({ kind: 'glass', title: 'Olá', subtitle: 'Mundo' }), { userFonts: false });
  assert.match(gl, /\\an7\\pos\(.*\\1a&HFF&\\3c&H00FFFFFF.*\\p1}m /, 'light border');
});

test('glass card blurs the picture under it (real ffmpeg export)', { skip: !ffmpegOk }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec-apple-'));
  try {
    const src = join(dir, 'bg.mp4');
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=3:r=30', '-pix_fmt', 'yuv420p', src]);
    const p = {
      canvas: { w: 640, h: 360, fps: 30 },
      media: [{ id: 'm', path: src, kind: 'video', duration: 3, hasAudio: false }],
      tracks: [
        { id: 'v1', kind: 'video', clips: [{ id: 'c', mediaId: 'm', start: 0, in: 0, out: 3 }] },
        { id: 't', kind: 'text', clips: [{ id: 'g', start: 0, in: 0, out: 3, text: '', graphic: { kind: 'glass', title: 'Olá', subtitle: 'Mundo' } }, { id: 'h', start: 0, in: 0, out: 3, text: '', graphic: { kind: 'headline', title: 'Topo', y: 0.15 } }] },
      ],
    };
    const fc = buildExport(p, join(dir, 'o.mp4')).args.find((a) => a.includes('gblur'));
    assert.ok(fc, 'glass filters in the graph');
    const out = join(dir, 'o.mp4');
    await runExport(p, out, () => {});
    assert.ok(existsSync(out) && statSync(out).size > 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
