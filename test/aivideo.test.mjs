// VideoCraft features: transcript lines, best-moment parsing against the real words, chapters,
// translation matching and caption checks (src/lib/aivideo.js), plus the short project builder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ai = await import('../src/lib/aivideo.js');

// 120 s of speech: one word every 0.5 s, a sentence end every 10 words.
const words = Array.from({ length: 240 }, (_, i) => ({ w: (i + 1) % 10 === 0 ? `p${i}.` : `p${i}`, s: i * 0.5, e: i * 0.5 + 0.4 }));

test('time helpers and sentences', () => {
  assert.equal(ai.hms(3725), '01:02:05');
  assert.equal(ai.parseHms('01:02:05'), 3725);
  assert.equal(ai.parseHms('02:05'), 125);
  assert.equal(ai.parseHms(12.5), 12.5);
  const s = ai.sentences(words);
  assert.equal(s.length, 24);
  assert.equal(s[0].text.split(' ').length, 10);
  assert.match(ai.transcriptLines(words, 0, 10).split('\n')[0], /^\[00:00:00\] p0 /);
});

test('best moments: snapped to real words, text from the transcript, overlaps dropped', () => {
  const json = {
    clips: [
      { start: '00:00:10', end: '00:00:40', hook: 'Gancho A', outro: 'Fim A', why_viral: 'x', score: 7, title: 'A', hashtags: ['a', '#b'] },
      { start: '00:00:20', end: '00:00:50', hook: 'Sobreposto', score: 9, title: 'B' },
      { start: '00:01:00', end: '00:01:03', hook: 'Curto demais', score: 10 },
      { start: 'lixo', end: '00:01:30', score: 5 },
      { start: '00:01:05', end: '00:01:40', hook: 'C', score: 6, title: 'C' },
    ],
  };
  const r = ai.parseHotclips(json, words, { min: 20, max: 60, count: 8 });
  assert.deepEqual(r.map((c) => c.title), ['B', 'C'], 'higher score wins the overlap; too short and unreadable dropped');
  const b = r[0];
  assert.ok(Math.abs(b.start - (20 - 0.15)) < 0.01);
  assert.ok(b.text.startsWith('p40'), b.text.slice(0, 20));
  assert.ok(!b.text.includes('Sobreposto'), 'the text never comes from the model');
  assert.deepEqual(ai.parseHotclips({ clips: [json.clips[0]] }, words)[0].hashtags, ['#a', '#b']);
  assert.match(ai.publishText(r[0]), /^# B/);
  assert.equal(ai.slug('Olá, Mundo! Ação'), 'ola-mundo-acao');
});

test('windows: long transcripts are split, chapters win', () => {
  const long = Array.from({ length: 4000 }, (_, i) => ({ w: 'x', s: i, e: i + 0.5 }));
  assert.equal(ai.hotclipWindows(long, { count: 8 }).length, 4);
  assert.equal(ai.hotclipWindows(words, { count: 8 }).length, 1);
  const ch = ai.hotclipWindows(long, { chapters: [{ start: 0 }, { start: 1000 }], count: 8 });
  assert.deepEqual(ch.map((w) => [w.s, w.count]), [[0, 5], [1000, 5]]);
});

test('chapters, YouTube block, translation by index', () => {
  const r = ai.parseChapters({ titles: ['T1', 'T2'], chapters: [{ start: '00:00:05', title: 'Intro' }, { start: '00:01:00', title: 'Meio', points: ['a'] }, { start: '00:01:03', title: 'Perto demais' }, { start: '99:00:00', title: 'Fora' }] }, 600);
  assert.deepEqual(r.chapters.map((c) => [c.start, c.title]), [[0, 'Intro'], [60, 'Meio']]);
  assert.equal(ai.youtubeChapters(r.chapters), '0:00 Intro\n1:00 Meio');
  const items = [{ i: 0, text: 'olá' }, { i: 1, text: 'adeus' }, { i: 2, text: 'x' }];
  assert.deepEqual(ai.parseTranslation({ items: [{ i: 1, text: '【1】bye' }, { i: 0, text: 'hello' }] }, items), ['hello', 'bye', null]);
  assert.match(ai.translatePrompt(items, 'inglês'), /【2】x/);
});

test('caption checks and fixes', () => {
  const cues = [
    { id: 'a', start: 0, end: 2, text: 'Olá' },
    { id: 'b', start: 1.5, end: 3, text: '【3】mundo' },
    { id: 'c', start: 3, end: 4, text: '' },
    { id: 'd', start: 4, end: 5, text: 'x' },
    { id: 'e', start: 5, end: 6, text: 'x' },
    { id: 'f', start: 6, end: 7, text: 'x' },
    { id: 'g', start: 7, end: 7.2, text: 'uma frase demasiado comprida para ler' },
  ];
  const kinds = ai.checkCaptions(cues).map((i) => `${i.id}:${i.kind}`);
  for (const k of ['a:overlap', 'b:residue', 'c:empty', 'f:duplicate', 'g:long']) assert.ok(kinds.includes(k), k);
  const fixed = ai.fixCaptions(cues);
  assert.deepEqual(fixed.map((c) => c.id), ['a', 'b', 'd', 'e', 'g']);
  assert.equal(fixed[0].end, 1.5);
  assert.equal(fixed[1].text, 'mundo');
});

test('short project: 9:16, source window, captions and cards', () => {
  const { shortProject } = require('../electron/shorts.cjs');
  const c = ai.parseHotclips({ clips: [{ start: '00:00:10', end: '00:00:40', hook: 'Gancho', outro: 'Segue o método', score: 8, title: 'T' }] }, words)[0];
  const p = shortProject({ path: 'C:/x/video.mp4', duration: 120, width: 1920, height: 1080, transcript: words }, c, { style: 'felipe' });
  assert.deepEqual([p.canvas.w, p.canvas.h], [1080, 1920]);
  const v = p.tracks[0].clips[0];
  assert.equal(v.in, c.start);
  assert.equal(v.out, c.end);
  assert.ok(p.tracks[2].clips.length > 5, 'captions');
  assert.ok(p.tracks[2].clips.every((x) => x.start >= 0 && x.start < c.duration), 'captions on the short timeline');
  assert.deepEqual(p.tracks[3].clips.map((x) => x.graphic.title), ['Gancho', 'Segue o método']);
  assert.equal(shortProject({ path: 'v.mp4', transcript: words }, c, { cards: false, reframe: 'fit' }).tracks[0].clips[0].fit, 'fit');
});

test('dub fitting: speed only when a line does not fit before the next caption', () => {
  const { fitPlan, atempo } = require('../electron/dub.cjs');
  const cues = [{ start: 0, end: 2 }, { start: 2, end: 4 }, { start: 10, end: 11 }];
  const p = fitPlan(cues, [1.5, 3, 1], { maxSpeed: 1.5, total: 12 });
  assert.deepEqual(p.map((x) => x.speed), [1, 1, 1], 'the 3 s line has until the next caption (8 s)');
  const q = fitPlan([{ start: 0, end: 1 }, { start: 1, end: 2 }], [3, 1], { maxSpeed: 1.5, total: 3 });
  assert.equal(q[0].speed, 1.5);
  assert.equal(q[0].overflow, true);
  assert.equal(atempo(3), 'atempo=2,atempo=1.5000');
});
