// Resolve-style edit operations (src/lib/edit.js): trims, three-point edits, locked tracks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendEdit, clipEnd, cutAt, fitToFillEdit, insertEdit, overwriteEdit, placeOnTopEdit, replaceEdit, rippleDeleteRange, rippleTrim, roll, slide, slip } from '../src/lib/edit.js';
import { syncLinks } from '../src/lib/links.js';

const project = () => ({
  media: [
    { id: 'a', kind: 'video', duration: 20, hasAudio: false },
    { id: 'b', kind: 'video', duration: 20, hasAudio: false },
    { id: 'short', kind: 'video', duration: 2, hasAudio: false },
    { id: 'voice', kind: 'video', duration: 20, hasAudio: true },
  ],
  tracks: [
    {
      id: 'v1',
      kind: 'video',
      name: 'V1',
      clips: [
        { id: 'c1', mediaId: 'a', start: 0, in: 2, out: 6 },
        { id: 'c2', mediaId: 'b', start: 4, in: 5, out: 9 },
        { id: 'c3', mediaId: 'a', start: 8, in: 10, out: 12 },
      ],
    },
    { id: 'v2', kind: 'video', name: 'V2', clips: [{ id: 't1', start: 1, in: 0, out: 2, text: 'Olá' }] },
    { id: 'm1', kind: 'audio', name: 'Música', clips: [{ id: 's1', mediaId: 'a', start: 0, in: 0, out: 12 }] },
  ],
});
const clip = (p, id) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
const track = (p, id) => p.tracks.find((t) => t.id === id);
const layout = (p, id) => track(p, id).clips.map((c) => [c.mediaId ?? c.text, c.start, c.in, c.out]);

test('ripple trim of a right edge moves the later clips', () => {
  const p = project();
  assert.equal(rippleTrim(p, 'c1', 'right', -1), -1);
  assert.deepEqual(layout(p, 'v1'), [['a', 0, 2, 5], ['b', 3, 5, 9], ['a', 7, 10, 12]]);
});

test('ripple trim of a left edge keeps the start and closes the gap', () => {
  const p = project();
  rippleTrim(p, 'c2', 'left', 1);
  assert.deepEqual(layout(p, 'v1'), [['a', 0, 2, 6], ['b', 4, 6, 9], ['a', 7, 10, 12]]);
});

test('ripple trim stops at the source', () => {
  const p = project();
  rippleTrim(p, 'c1', 'left', -10);
  assert.equal(clip(p, 'c1').in, 0);
  assert.equal(clip(p, 'c2').start, 6);
});

test('roll moves only the cut', () => {
  const p = project();
  const [l, r] = cutAt(track(p, 'v1'), 4);
  assert.equal(roll(p, l.id, r.id, 0.5), 0.5);
  assert.deepEqual(layout(p, 'v1'), [['a', 0, 2, 6.5], ['b', 4.5, 5.5, 9], ['a', 8, 10, 12]]);
});

test('roll is limited by the right clip source start', () => {
  const p = project();
  assert.equal(roll(p, 'c1', 'c2', -10), -3.9);
});

test('slip changes the part shown, not the place', () => {
  const p = project();
  assert.equal(slip(p, 'c2', 2), 2);
  assert.deepEqual(layout(p, 'v1')[1], ['b', 4, 7, 11]);
  slip(p, 'c2', -50);
  assert.deepEqual(layout(p, 'v1')[1], ['b', 4, 0, 4]);
});

test('slide moves the clip between its neighbours', () => {
  const p = project();
  assert.equal(slide(p, 'c2', 1), 1);
  assert.deepEqual(layout(p, 'v1'), [['a', 0, 2, 7], ['b', 5, 5, 9], ['a', 9, 11, 12]]);
  assert.equal(clipEnd(clip(p, 'c3')), 10);
});

test('insert pushes every unlocked track and splits at the point', () => {
  const p = project();
  insertEdit(p, { mediaId: 'short' }, 2);
  assert.deepEqual(layout(p, 'v1'), [['a', 0, 2, 4], ['short', 2, 0, 2], ['a', 4, 4, 6], ['b', 6, 5, 9], ['a', 10, 10, 12]]);
  // The text on V2 (1..3) is cut at 2 and its second half moves.
  assert.deepEqual(layout(p, 'v2'), [['Olá', 1, 0, 1], ['Olá', 4, 0, 1]]);
  assert.equal(track(p, 'm1').clips.length, 2);
});

test('insert leaves locked tracks alone', () => {
  const p = project();
  track(p, 'm1').locked = true;
  insertEdit(p, { mediaId: 'short' }, 2);
  assert.deepEqual(layout(p, 'm1'), [['a', 0, 0, 12]]);
});

test('overwrite covers what was there', () => {
  const p = project();
  overwriteEdit(p, { mediaId: 'short' }, 3);
  assert.deepEqual(layout(p, 'v1'), [['a', 0, 2, 5], ['short', 3, 0, 2], ['b', 5, 6, 9], ['a', 8, 10, 12]]);
  assert.equal(clipEnd(clip(p, 'c3')), 10);
});

test('three-point overwrite with a length', () => {
  const p = project();
  overwriteEdit(p, { mediaId: 'b', length: 1.5 }, 0);
  assert.deepEqual(layout(p, 'v1')[0], ['b', 0, 0, 1.5]);
});

test('replace keeps place and length', () => {
  const p = project();
  replaceEdit(p, { mediaId: 'b' }, 5);
  assert.deepEqual(layout(p, 'v1')[1], ['b', 4, 0, 4]);
  assert.throws(() => replaceEdit(p, { mediaId: 'short' }, 5), /mais curto/);
});

test('fit to fill sets the speed', () => {
  const p = project();
  const id = fitToFillEdit(p, { mediaId: 'short' }, 0, 4);
  const c = clip(p, id);
  assert.equal(c.speed, 0.5);
  assert.equal(clipEnd(c), 4);
  assert.equal(track(p, 'v1').clips[1].start, 4);
});

test('place on top uses a free track above, or a new one', () => {
  const p = project();
  placeOnTopEdit(p, { mediaId: 'short' }, 5);
  assert.equal(track(p, 'v2').clips.length, 2);
  placeOnTopEdit(p, { mediaId: 'short' }, 1);
  assert.equal(p.tracks.filter((t) => t.kind === 'video').length, 3);
});

test('append goes after the last clip', () => {
  const p = project();
  const id = appendEdit(p, { mediaId: 'short' });
  assert.equal(clip(p, id).start, 10);
});

test('ripple delete of a range closes the gap on every unlocked track', () => {
  const p = project();
  assert.equal(rippleDeleteRange(p, 3, 5), 2);
  assert.deepEqual(layout(p, 'v1'), [['a', 0, 2, 5], ['b', 3, 6, 9], ['a', 6, 10, 12]]);
  assert.deepEqual(layout(p, 'm1'), [['a', 0, 0, 3], ['a', 3, 5, 12]]);
});

test('locked track refuses trims', () => {
  const p = project();
  track(p, 'v1').locked = true;
  assert.throws(() => rippleTrim(p, 'c1', 'right', 1), /bloqueada/);
  assert.throws(() => slip(p, 'c1', 1), /bloqueada/);
});

test('linked sound follows an insert (links.js after the edit)', () => {
  const p = project();
  p.tracks[0].clips = [{ id: 'v', mediaId: 'voice', start: 0, in: 0, out: 6 }];
  syncLinks(null, p);
  const before = structuredClone(p);
  insertEdit(p, { mediaId: 'short' }, 2);
  syncLinks(before, p);
  const sound = p.tracks.find((t) => t.of === 'v1').clips.map((c) => [c.start, c.in, c.out]);
  assert.deepEqual(sound, [[0, 0, 2], [4, 2, 6]]);
});
