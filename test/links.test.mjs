// Sound on its own track: a video clip and its sound clip stay in step (src/lib/links.js), and a real export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { audioTrackFor, partnersOf, separateAudio, syncLinks, textToVideo, unlink } from '../src/lib/links.js';

const require = createRequire(import.meta.url);
const { runExport, buildExport } = require('../electron/render.cjs');

const project = () => ({
  media: [
    { id: 'm', kind: 'video', duration: 10, hasAudio: true },
    { id: 'mute', kind: 'video', duration: 10, hasAudio: false },
    { id: 'song', kind: 'audio', duration: 30, hasAudio: true },
  ],
  tracks: [
    { id: 'v1', kind: 'video', name: 'V1', clips: [] },
    { id: 'v2', kind: 'video', name: 'V2', clips: [] },
    { id: 'tx', kind: 'text', name: 'Legendas', clips: [] },
    { id: 'a1', kind: 'audio', name: 'Música', clips: [] },
  ],
});
const track = (p, id) => p.tracks.find((t) => t.id === id);
const soundOf = (p, id) => p.tracks.find((t) => t.of === id);
/** One edit, as the store does it. */
const edit = (p, fn, linked = true) => {
  const next = structuredClone(p);
  fn(next);
  return syncLinks(p, next, { linked });
};
const withClip = () => {
  const p = project();
  track(p, 'v1').clips.push({ id: 'c1', mediaId: 'm', start: 2, in: 1, out: 6, volume: 1 });
  return syncLinks(null, p);
};

test('a video with sound becomes two linked clips: picture on V1, sound on A1', () => {
  const p = withClip();
  const v = track(p, 'v1').clips[0];
  const a1 = soundOf(p, 'v1');
  assert.equal(a1.name, 'A1');
  assert.equal(a1.clips.length, 1);
  const a = a1.clips[0];
  assert.equal(v.silent, true);
  assert.ok(v.link && v.link === a.link);
  assert.deepEqual([a.mediaId, a.start, a.in, a.out, a.volume], ['m', 2, 1, 6, 1]);
  // Sound tracks come before the music, and nothing is separated twice.
  assert.deepEqual(p.tracks.filter((t) => t.kind === 'audio').map((t) => t.name), ['A1', 'Música']);
  assert.equal(separateAudio(p), 0);
});

test('footage without sound, music and text are left alone', () => {
  const p = project();
  track(p, 'v1').clips.push({ id: 'c1', mediaId: 'mute', start: 0, in: 0, out: 5 });
  track(p, 'a1').clips.push({ id: 's1', mediaId: 'song', start: 0, in: 0, out: 20, volume: 0.5 });
  syncLinks(null, p);
  assert.equal(p.tracks.length, 4);
  assert.equal(track(p, 'v1').clips[0].silent, undefined);
  assert.equal(track(p, 'a1').clips[0].link, undefined);
});

test('moving or trimming the picture moves its sound, and the other way round', () => {
  let p = withClip();
  p = edit(p, (q) => Object.assign(track(q, 'v1').clips[0], { start: 5, in: 2 }));
  let a = soundOf(p, 'v1').clips[0];
  assert.deepEqual([a.start, a.in, a.out], [5, 2, 6]);
  p = edit(p, (q) => Object.assign(soundOf(q, 'v1').clips[0], { start: 1, out: 4 }));
  const v = track(p, 'v1').clips[0];
  assert.deepEqual([v.start, v.in, v.out], [1, 2, 4]);
});

test('linked selection off: each half on its own, and the offset stays when they move together again', () => {
  let p = withClip();
  p = edit(p, (q) => void (soundOf(q, 'v1').clips[0].start = 3), false);
  assert.equal(track(p, 'v1').clips[0].start, 2);
  p = edit(p, (q) => void (track(q, 'v1').clips[0].start = 10));
  assert.equal(soundOf(p, 'v1').clips[0].start, 11);
});

test('the picture goes to V2: its sound goes to A2', () => {
  let p = withClip();
  p = edit(p, (q) => track(q, 'v2').clips.push(...track(q, 'v1').clips.splice(0, 1)));
  assert.equal(soundOf(p, 'v1').clips.length, 0);
  assert.equal(soundOf(p, 'v2').name, 'A2');
  assert.equal(soundOf(p, 'v2').clips.length, 1);
  assert.deepEqual(p.tracks.filter((t) => t.kind === 'audio').map((t) => t.name), ['A1', 'A2', 'Música']);
});

test('deleting one half deletes the other; unlinked or with linked selection off it stays', () => {
  const p = withClip();
  const gone = edit(p, (q) => void (track(q, 'v1').clips = []));
  assert.equal(soundOf(gone, 'v1').clips.length, 0);
  const gone2 = edit(p, (q) => void (soundOf(q, 'v1').clips = []));
  assert.equal(track(gone2, 'v1').clips.length, 0);
  const kept = edit(p, (q) => void (soundOf(q, 'v1').clips = []), false);
  assert.equal(track(kept, 'v1').clips.length, 1);
  assert.equal(track(kept, 'v1').clips[0].link, undefined);
  assert.equal(track(kept, 'v1').clips[0].silent, true, 'the picture stays without sound');
  const un = edit(p, (q) => void unlink(q, 'c1'));
  const un2 = edit(un, (q) => void (track(q, 'v1').clips = []));
  assert.equal(soundOf(un2, 'v1').clips.length, 1);
});

test('cutting the picture cuts the sound, piece by piece', () => {
  let p = withClip();
  // split c1 (2..7 on the timeline, source 1..6) at 4
  p = edit(p, (q) => {
    const c = track(q, 'v1').clips[0];
    track(q, 'v1').clips.push({ ...structuredClone(c), id: 'c2', start: 4, in: 3 });
    c.out = 3;
  });
  const v = track(p, 'v1').clips;
  const a = soundOf(p, 'v1').clips;
  assert.equal(a.length, 2);
  assert.deepEqual(a.map((c) => [c.start, c.in, c.out]), [[2, 1, 3], [4, 3, 6]]);
  assert.notEqual(v[0].link, v[1].link);
  assert.deepEqual(v.map((c) => c.link), a.map((c) => c.link));
  // The second piece now moves on its own pair.
  p = edit(p, (q) => void (track(q, 'v1').clips[1].start = 9));
  assert.deepEqual(soundOf(p, 'v1').clips.map((c) => c.start), [2, 9]);
});

test('a cut through every track pairs the pieces again', () => {
  let p = withClip();
  p = edit(p, (q) => {
    for (const t of [track(q, 'v1'), soundOf(q, 'v1')]) {
      const c = t.clips[0];
      t.clips.push({ ...structuredClone(c), id: `${c.id}b`, start: 4, in: 3 });
      c.out = 3;
    }
  });
  const v = track(p, 'v1').clips;
  const a = soundOf(p, 'v1').clips;
  assert.equal(a.length, 2);
  assert.notEqual(v[0].link, v[1].link);
  assert.deepEqual(v.map((c) => c.link), a.map((c) => c.link));
});

test('speed, volume and transitions reach the sound', () => {
  let p = withClip();
  p = edit(p, (q) => Object.assign(track(q, 'v1').clips[0], { speed: 2, volume: 0.4, transitionIn: { type: 'slide', d: 0.5 } }));
  const a = soundOf(p, 'v1').clips[0];
  assert.equal(a.speed, 2);
  assert.equal(a.volume, 0.4);
  assert.deepEqual(a.transitionIn, { type: 'fade', d: 0.5 });
  p = edit(p, (q) => void (soundOf(q, 'v1').clips[0].volume = 1.5));
  assert.equal(track(p, 'v1').clips[0].volume, 1.5);
});

test('partnersOf and audioTrackFor', () => {
  const p = withClip();
  assert.deepEqual(partnersOf(p, 'c1').map((c) => c.mediaId), ['m']);
  assert.equal(audioTrackFor(p, track(p, 'v1')), soundOf(p, 'v1'));
  assert.equal(partnersOf(p, 'nope').length, 0);
});

test('real export: the sound of a video is heard from its audio track, once', { skip: spawnSync('ffmpeg', ['-version']).status !== 0, timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ec-links-'));
  try {
    const src = join(dir, 'tone.mp4');
    assert.equal(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]).status, 0);
    const base = () => ({
      name: 'links', canvas: { w: 320, h: 240, fps: 30, preset: '16:9' },
      media: [{ id: 'm', path: src, kind: 'video', duration: 2, hasAudio: true }],
      tracks: [{ id: 'v1', kind: 'video', name: 'V1', clips: [{ id: 'c1', mediaId: 'm', start: 0, in: 0, out: 2, volume: 1, fit: 'fill' }] }],
    });
    const level = async (p, name) => {
      const out = join(dir, name);
      await runExport(p, out);
      const r = spawnSync('ffmpeg', ['-v', 'info', '-i', out, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8' });
      const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr);
      return m ? (m[1] === '-inf' ? -200 : Number(m[1])) : -200;
    };
    const old = await level(base(), 'old.mp4');
    const split = syncLinks(null, base());
    assert.equal(split.tracks.find((t) => t.of === 'v1').clips.length, 1);
    const now = await level(split, 'new.mp4');
    assert.ok(old > -40, `the old way has sound: ${old} dB`);
    assert.ok(Math.abs(now - old) < 1.5, `same loudness with the sound on its own track: ${now} dB vs ${old} dB`);
    // Without the sound clip the video is silent.
    const silent = structuredClone(split);
    silent.tracks.find((t) => t.of === 'v1').clips = [];
    assert.ok((await level(silent, 'silent.mp4')) < -60, 'no sound clip, no sound');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('texts are clips on video tracks: old captions tracks become video tracks, on top, in the same order', () => {
  const p = project();
  p.tracks.splice(3, 0, { id: 'gx', kind: 'text', name: 'Grafismos', clips: [] });
  track(p, 'tx').clips.push({ id: 't1', start: 0, in: 0, out: 2, text: 'Olá' });
  assert.equal(textToVideo(p), 2);
  assert.deepEqual(p.tracks.map((t) => `${t.kind}:${t.name}`), ['video:V1', 'video:V2', 'video:Grafismos', 'video:Legendas', 'audio:Música']);
  // On screen video tracks are listed last first: Legendas stays above Grafismos, both above V2.
  assert.equal(track(p, 'tx').clips[0].text, 'Olá');
  assert.equal(textToVideo(p), 0);
  // Any edit that still makes a track of kind 'text' ends with a video track.
  const q = edit(p, (n) => void n.tracks.push({ id: 'wm', kind: 'text', name: 'Marca de água', clips: [] }));
  assert.equal(q.tracks.some((t) => t.kind === 'text'), false);
  assert.equal(q.tracks.findLast((t) => t.kind === 'video').id, 'wm');
});

test('export: a text on a video track, next to a picture clip, is written like one on an old captions track', () => {
  const base = (kind) => ({
    name: 't', canvas: { w: 320, h: 240, fps: 30, preset: '16:9' },
    media: [{ id: 'm', path: 'x.mp4', kind: 'video', duration: 4, hasAudio: false }],
    tracks: [
      { id: 'v1', kind: 'video', name: 'V1', clips: [{ id: 'c1', mediaId: 'm', start: 0, in: 0, out: 4, fit: 'fill' }] },
      { id: 'tx', kind, name: 'Legendas', clips: [{ id: 't1', start: 1, in: 0, out: 2, text: 'Olá mundo', style: 'clean' }] },
    ],
  });
  const old = buildExport(base('text'), 'o.mp4');
  const now = buildExport(base('video'), 'o.mp4');
  assert.match(now.ass, /Olá mundo/);
  assert.equal(now.ass, old.ass);
  assert.deepEqual(now.args, old.args);
  // Same track as the picture: still one picture input, and the text is there.
  const mixed = base('video');
  mixed.tracks[0].clips.push(mixed.tracks[1].clips.pop());
  const one = buildExport(mixed, 'o.mp4');
  assert.match(one.ass, /Olá mundo/);
  assert.equal(one.args.filter((a) => a === '-i').length, now.args.filter((a) => a === '-i').length);
});
