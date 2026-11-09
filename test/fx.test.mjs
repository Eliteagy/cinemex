// v0.10: transitions, rotation/opacity keyframes, graphics, beats and sound effects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { buildExport, buildAss, runExport } = require('../electron/render.cjs');
const { transitionState, blurWindow, blurStages, smooth, smoothInv, motionPreset, pulseKeys, detectBeats, TRANSITION_TYPES } = require('../src/lib/fx.js');
const { graphicEvents, eventAt, graphicOf } = require('../src/lib/graphics.js');
const { SFX, renderSfx, wav } = require('../electron/sfx.cjs');

const ffmpegOk = spawnSync('ffmpeg', ['-version']).status === 0;

test('smoothInv inverts smooth', () => {
  for (const y of [0.1, 0.5, 0.9]) assert.ok(Math.abs(smooth(smoothInv(y)) - y) < 1e-6);
});

test('transition state: every type ends at the plain clip', () => {
  for (const type of TRANSITION_TYPES) {
    const clip = { transitionIn: { type, d: 0.5 }, transitionOut: { type, d: 0.5 } };
    const mid = transitionState(clip, 1, 2);
    assert.deepEqual([mid.alpha, mid.slide, mid.zoom, mid.rotate, mid.white, mid.black, mid.blur], [1, 0, 1, 0, 0, 0, 0], type);
    const start = transitionState(clip, 0, 2);
    assert.ok(start.alpha < 1 || start.slide || start.zoom > 1 || start.white || start.black || start.blur || start.bright, `${type} does something at the start`);
  }
});

test('blur staircase: preview stage count matches the export windows', () => {
  const d = 0.6;
  const dur = 3;
  for (let t = 0.001; t < d; t += 0.013) {
    const n = blurStages(t / d);
    let on = 0;
    for (let k = 0; k < 3; k++) {
      const [a, b] = blurWindow('in', d, dur, k);
      if (t >= a && t <= b) on++;
    }
    assert.equal(on, n, `t=${t}`);
  }
});

test('motion presets and beat pulses', () => {
  const shake = motionPreset('shake', 2, 'c1');
  assert.ok(shake.x.length > 20 && shake.zoom[0].v > 1);
  assert.deepEqual(motionPreset('shake', 2, 'c1'), shake, 'same clip, same shake');
  const keys = pulseKeys([0, 0.5, 0.55, 1], 2, 0.1);
  assert.ok(keys.every((k, i) => !i || k.t > keys[i - 1].t), 'times increase');
  assert.equal(keys.filter((k) => k.v > 1).length, 3, '0.55 is too close to 0.5');
});

test('beat detection finds a steady kick', () => {
  const rate = 100;
  const peaks = new Uint8Array(rate * 6).fill(20);
  for (let t = 0.5; t < 6; t += 0.5) for (let i = 0; i < 8; i++) peaks[Math.round(t * rate) + i] = 230 - i * 20;
  const beats = detectBeats(peaks);
  assert.ok(beats.length >= 10 && beats.length <= 11, String(beats));
  assert.ok(beats.every((b) => Math.abs(b * 2 - Math.round(b * 2)) < 0.05), String(beats));
});

test('graphics: events, timing and ASS', () => {
  for (const kind of ['lower', 'title', 'label', 'progress']) {
    const ev = graphicEvents({ kind, title: 'Sala', subtitle: 'T3' }, 3, 1080, 1920);
    assert.ok(ev.length, kind);
    for (const e of ev) {
      const a = eventAt(e, e.t0 + 0.001);
      assert.ok(a, `${kind} visible at its start`);
      assert.equal(eventAt(e, e.t1 + 0.1), null);
    }
  }
  assert.equal(graphicOf({ kind: 'nope', accent: 'red' }).kind, 'title');
  assert.equal(graphicOf({ kind: 'lower', accent: 'red' }).accent, '#D4AF37');
  const ass = buildAss({
    canvas: { w: 1080, h: 1920, fps: 30 },
    tracks: [{ id: 't', kind: 'text', clips: [{ id: 'g', start: 1, in: 0, out: 3, text: 'Nome', graphic: { kind: 'lower', title: 'Marta', subtitle: 'Consultora' } }, { id: 'p', start: 0, in: 0, out: 4, graphic: { kind: 'progress' } }] }],
  }, { userFonts: false });
  assert.match(ass, /Style: GfxBox,.*,3,0,0,5/);
  assert.match(ass, /\\p1}m 0 0 l 1080 0 1080 14 0 14/);
  assert.match(ass, /\\move\(/);
  assert.match(ass, /\\t\(0,4000,\\fscx100\\fscy100\)/, 'progress bar grows over the clip');
  assert.match(ass, /GfxBox,,0,0,0,,{\\an4.*Consultora/);
});

test('export graph: zoom/spin go into zoompan and rotate, blur stages and flash fades', () => {
  const p = {
    canvas: { w: 1080, h: 1920, fps: 30 },
    media: [{ id: 'm', path: 'a.mp4', kind: 'video', duration: 10, hasAudio: false }],
    tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'c', mediaId: 'm', start: 0, in: 0, out: 3, transitionIn: { type: 'spin', d: 0.5 }, transitionOut: { type: 'flash', d: 0.3 }, keyframes: { opacity: [{ t: 0, v: 0.5 }, { t: 3, v: 1 }] } }] }],
  };
  const fc = buildExport(p, 'o.mp4').args.find((a) => a.includes('[base0]'));
  assert.match(fc, /zoompan=z='max\(1,1\)\*\(1\+0\.25/);
  assert.match(fc, /rotate=a='\(180\*\(1-/);
  assert.match(fc, /gblur=sigma=[\d.]+:enable='between\(t,0,/);
  assert.match(fc, /fade=t=out:st=2\.7:d=0\.3:color=white/);
  assert.match(fc, /geq=.*a='alpha\(X,Y\)\*clip\(/);
});

test('sound effects: every one renders a short, loud enough WAV', () => {
  for (const [id, def] of Object.entries(SFX)) {
    const pcm = renderSfx(id);
    assert.ok(pcm.length > 100, id);
    let peak = 0;
    for (const v of pcm) peak = Math.max(peak, Math.abs(v));
    assert.ok(peak > 0.2 && peak <= 1, `${id} peak ${peak}`);
    assert.ok(Math.abs(pcm.length / 48000 - def.dur) < 0.01, id);
  }
  const w = wav(new Float32Array([0, 0.5, -0.5]));
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.length, 44 + 6);
});

test('real export with every new transition, keyframes and graphics', { skip: !ffmpegOk, timeout: 180000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec-fx-'));
  try {
    const src = join(dir, 'src.mp4');
    spawnSync('ffmpeg', ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=12', '-f', 'lavfi', '-i', 'sine=f=440:d=12', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
    const types = ['whip', 'zoom', 'spin', 'flash', 'dip', 'blur'];
    const clips = types.map((type, i) => ({ id: `c${i}`, mediaId: 'm', start: i * 1.2, in: i, out: i + 1.2, transitionIn: { type, d: 0.4 }, transitionOut: { type: types[(i + 1) % types.length], d: 0.3 }, ...(i === 2 ? { keyframes: { rotate: [{ t: 0, v: -10 }, { t: 1.2, v: 10 }], opacity: [{ t: 0, v: 0.4 }, { t: 1.2, v: 1 }] } } : {}) }));
    const p = {
      name: 'fx',
      canvas: { w: 540, h: 960, fps: 30 },
      media: [{ id: 'm', path: src, kind: 'video', duration: 12, width: 640, height: 360, hasAudio: true }],
      tracks: [
        { id: 'v1', kind: 'video', clips },
        { id: 't', kind: 'text', clips: [{ id: 'g1', start: 0.2, in: 0, out: 3, text: 'Nome', graphic: { kind: 'lower', title: 'Nome Apelido', subtitle: 'Consultor' } }, { id: 'g2', start: 3.5, in: 0, out: 2, text: 'SALA', graphic: { kind: 'label', title: 'Sala' } }, { id: 'g3', start: 0, in: 0, out: 7.2, graphic: { kind: 'progress' } }] },
      ],
    };
    const out = join(dir, 'out.mp4');
    await runExport(p, out);
    assert.ok(existsSync(out) && statSync(out).size > 10000);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]);
    assert.ok(Math.abs(Number(String(probe.stdout)) - 7.2) < 0.15, String(probe.stdout));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sideways footage: orient 90 turns the source counter-clockwise before framing', () => {
  const p = {
    canvas: { w: 1080, h: 1920, fps: 30 },
    media: [{ id: 'm', path: 'a.mp4', kind: 'video', duration: 10, hasAudio: false }],
    tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'c', mediaId: 'm', start: 0, in: 0, out: 2, orient: 90 }] }],
  };
  const fc = buildExport(p, 'o.mp4').args.find((a) => a.includes('[base0]'));
  assert.match(fc, /fps=30,transpose=2,scale=1080:1920/);
});

test('brightness flash: peaks at the cut, gone at the window edge, geq only on the flash frames', () => {
  const clip = { transitionIn: { type: 'bflash', d: 4 / 30 }, transitionOut: { type: 'bflash', d: 4 / 30 } };
  assert.equal(transitionState(clip, 0, 2).bright, 1);
  assert.ok(transitionState(clip, 2 / 30, 2).bright > 0.4 && transitionState(clip, 2 / 30, 2).bright < 0.6);
  assert.equal(transitionState(clip, 1, 2).bright, 0);
  const p = { canvas: { w: 1080, h: 1920, fps: 30 }, media: [{ id: 'm', path: 'a.mp4', kind: 'video', duration: 10, hasAudio: false }], tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'c', mediaId: 'm', start: 0, in: 0, out: 2, ...clip }] }] };
  const fc = buildExport(p, 'o.mp4').args.find((a) => a.includes('[base0]'));
  assert.match(fc, /geq=r='clip\(r\(X,Y\)\*\(1\+0\.83\*/);
  assert.match(fc, /enable='between\(t,0,0\.1333\)'/);
});
