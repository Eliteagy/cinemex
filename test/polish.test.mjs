// Edited-short touches: beats from the big words, zoom punches, sound effects, progress bar, CTA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { beatsFromCaptions, punchKeyframes, sfxPlan, progressClip, ctaClip } from '../src/lib/polish.js';

const require = createRequire(import.meta.url);

test('beats: spaced, not under the hook or the CTA, accent words preferred', () => {
  const back = [0.2, 1, 2, 2.4, 5, 5.3, 9.5].map((start, i) => ({ start, text: i === 5 ? 'DINHEIRO' : 'CASA', ...(i === 5 ? { override: { color: '#D4AF37' } } : {}) }));
  assert.deepEqual(beatsFromCaptions(back, { duration: 10, tail: 1 }), [1, 5.3]);
  assert.deepEqual(beatsFromCaptions(back, { duration: 12, tail: 1 }), [1, 5.3, 9.5]);
});

test('punch keyframes: in clip time, inside the clip, no overlaps', () => {
  const clip = { start: 0, in: 10, out: 14, speed: 1 };
  const k = punchKeyframes([1, 1.5, 3.8], clip);
  assert.equal(k.length, 4, 'second beat overlaps the first punch, third does not fit');
  assert.deepEqual(k.map((x) => x.v), [1, 1.12, 1.12, 1]);
  assert.equal(k[0].ease, 'apple_out');
});

test('sfx plan, progress bar and CTA', () => {
  assert.deepEqual(sfxPlan([1, 4, 7]).map((s) => s.id), ['whoosh', 'pop', 'pop']);
  assert.deepEqual(progressClip(30).graphic.kind, 'progress');
  const c = ctaClip('Segue para mais', 30);
  assert.deepEqual([c.start, c.out, c.graphic.title], [27.5, 2.5, 'Segue para mais']);
  assert.equal(ctaClip('  ', 30), null);
});

test('short project with punch, sfx, progress and CTA', () => {
  const { shortProject } = require('../electron/shorts.cjs');
  const ws = Array.from({ length: 60 }, (_, i) => ({ w: i % 3 === 2 ? `palavra${i}` : 'de', s: 10 + i * 0.4, e: 10 + i * 0.4 + 0.3 }));
  const c = { start: 10, end: 34, duration: 24, hook: 'Gancho', outro: 'Fim', title: 'T' };
  const sfxList = [{ id: 'whoosh', label: 'Whoosh', path: 'C:/s/whoosh.wav', duration: 0.7 }, { id: 'pop', label: 'Pop', path: 'C:/s/pop.wav', duration: 0.3 }];
  const p = shortProject({ path: 'C:/x/v.mp4', duration: 60, width: 1920, height: 1080, transcript: ws }, c, { layout: 'atras', personMatte: 'C:/m.mp4', punch: true, sfx: true, sfxList, progress: true, cta: 'Fala comigo' });
  const v = p.tracks[0].clips[0];
  assert.ok(v.keyframes.zoom.length >= 8, 'several punches');
  const sx = p.tracks.find((t) => t.id === 'sx');
  assert.ok(sx.clips.length >= 2);
  assert.ok(sx.clips.every((x) => p.media.some((m) => m.id === x.mediaId && m.kind === 'audio')));
  const gx = p.tracks.find((t) => t.id === 'gx').clips;
  assert.ok(gx.some((x) => x.graphic.kind === 'progress'));
  assert.ok(gx.some((x) => x.text === 'Fala comigo'));
  assert.ok(!gx.some((x) => x.text === 'Fim'), 'CTA replaces the closing card');
});
