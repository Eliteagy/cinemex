// IA panel helpers (src/lib/autoedit.js): breath cut edges, split screen, suggestions, voice commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySplit, parseSuggestions, parseVoice, partnerForSplit, refineEdges, splitLayout, timelineWords, voicePrompt, wordLines, zoomKeys } from '../src/lib/autoedit.js';
import { cropOf } from '../src/lib/crop.js';

test('refineEdges keeps loud sound at the edges and merges', () => {
  // 100 levels/s: loud from 0.90 to 1.30 s and from 1.35 to 2.0 s.
  const peaks = new Uint8Array(300);
  for (let i = 90; i < 130; i++) peaks[i] = 200;
  for (let i = 135; i < 200; i++) peaks[i] = 200;
  const out = refineEdges([{ in: 1.0, out: 1.2 }, { in: 1.5, out: 1.8 }], peaks, { thr: 40, maxExtend: 0.3 });
  assert.equal(out.length, 1);
  assert.ok(out[0].in <= 0.91 && out[0].in >= 0.89, `in ${out[0].in}`);
  assert.ok(out[0].out >= 1.99 && out[0].out <= 2.01, `out ${out[0].out}`);
});

test('refineEdges never goes past maxExtend or the clip', () => {
  const peaks = new Uint8Array(1000).fill(255);
  const [s] = refineEdges([{ in: 5, out: 6 }], peaks, { maxExtend: 0.2, min: 4.9, max: 9 });
  assert.equal(s.in, 4.9);
  assert.ok(s.out <= 6.21);
  assert.deepEqual(refineEdges([{ in: 1, out: 2 }], null), [{ in: 1, out: 2 }]);
});

test('split layout puts the middle band of each clip in its half', () => {
  const L = splitLayout('top-bottom', 0.5);
  // A: rows 0.25..0.75 kept, moved up by 0.25 -> 0..0.5.
  assert.equal(L.a.crop.top, 0.25);
  assert.equal(L.a.crop.bottom, 0.25);
  assert.equal(L.a.py, -0.25);
  assert.equal(L.b.py, 0.25);
  const R = splitLayout('left-right', 0.6);
  assert.ok(Math.abs(R.a.px + 0.2) < 1e-9);
  assert.ok(Math.abs(R.b.crop.left - 0.3) < 1e-9);
});

const project = () => ({
  media: [
    { id: 'm1', kind: 'video', duration: 20, transcript: [{ w: 'Olá', s: 1, e: 1.4 }, { w: 'mundo', s: 1.5, e: 2 }, { w: 'fora', s: 15, e: 16 }] },
    { id: 'm2', kind: 'video', duration: 20 },
  ],
  tracks: [
    { id: 'v1', kind: 'video', name: 'V1', clips: [{ id: 'a', mediaId: 'm1', start: 10, in: 0, out: 8 }] },
    { id: 'v2', kind: 'video', name: 'V2', clips: [{ id: 'b', mediaId: 'm2', start: 12, in: 0, out: 3 }] },
  ],
});

test('split screen applies crop and position to both clips', () => {
  const p = project();
  assert.equal(partnerForSplit(p, 'a').id, 'b');
  applySplit(p, 'a', 'b', 'top-bottom', 0.5);
  const a = p.tracks[0].clips[0];
  const b = p.tracks[1].clips[0];
  assert.equal(cropOf(a).top, 0.25);
  assert.equal(a.keyframes.py[0].v, -0.25);
  assert.equal(cropOf(b).bottom, 0.25);
  assert.throws(() => applySplit(p, 'a', 'a'), /pistas/);
});

test('timeline words follow the clip place, in and speed', () => {
  const p = project();
  const w = timelineWords(p);
  assert.deepEqual(w.map((x) => [x.w, x.s]), [['Olá', 11], ['mundo', 11.5]]);
  p.tracks[0].clips[0].speed = 2;
  assert.equal(timelineWords(p)[1].s, 10.75);
  assert.match(wordLines(w), /^\[11\.0\] Olá mundo$/);
});

test('suggestions are cleaned', () => {
  const list = parseSuggestions({ moments: [{ t: 5, kind: 'punch', why: 'forte' }, { t: 5.5, kind: 'punch' }, { t: 99, kind: 'punch' }, { t: 8, kind: 'title', text: 'Isto muda tudo hoje mesmo' }, { t: 12, kind: 'title' }, { t: 3, kind: 'weird' }] }, 20);
  assert.deepEqual(list.map((x) => [x.t, x.kind]), [[3, 'punch'], [5, 'punch'], [8, 'title']]);
  assert.equal(list[2].text, 'Isto muda tudo hoje');
});

test('zoom keys stay inside the clip', () => {
  const k = zoomKeys('punch', 0, 5);
  assert.equal(k[0].t, 0);
  assert.equal(Math.max(...k.map((x) => x.v)), 1.16);
  assert.ok(zoomKeys('zoom_in', 4, 5).every((x) => x.t <= 5));
});

test('voice commands only reach allowed tools', () => {
  const r = parseVoice({ actions: [{ tool: 'split_clip', args: { time: 3 } }, { tool: 'export_video', args: {} }, { tool: 'save_project' }, { tool: 'seek', args: [1] }], say: 'Cortei' });
  assert.deepEqual(r.actions, [{ tool: 'split_clip', args: { time: 3 } }, { tool: 'seek', args: {} }]);
  assert.equal(r.say, 'Cortei');
  assert.deepEqual(parseVoice(null), { actions: [], say: '' });
  const prompt = voicePrompt('corta aqui', { playhead: 2, selected: null, under: 'a', clips: 'a V1 0-8' });
  assert.match(prompt, /corta aqui/);
  assert.doesNotMatch(prompt, /export_video/);
});
