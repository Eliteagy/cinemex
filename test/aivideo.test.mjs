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

test('short project following the face: plays the cropped file from 0, words moved to its time', () => {
  const { shortProject, canFollowFace } = require('../electron/shorts.cjs');
  const c = ai.parseHotclips({ clips: [{ start: '00:00:10', end: '00:00:40', hook: 'Gancho', score: 8 }] }, words)[0];
  const media = { path: 'C:/x/video.mp4', duration: 120, width: 1920, height: 1080, transcript: words };
  const plain = shortProject(media, c, { style: 'felipe' });
  const p = shortProject(media, c, { style: 'felipe', framed: { path: 'C:/cache/abc.mp4', width: 1080, height: 1920 } });
  const v = p.tracks[0].clips[0];
  assert.deepEqual([v.in, v.out, v.fit], [0, c.duration, 'fill']);
  assert.equal(p.media[0].path, 'C:/cache/abc.mp4');
  assert.deepEqual([p.media[0].width, p.media[0].height], [1080, 1920]);
  assert.ok(p.media[0].transcript.length > 0 && p.media[0].transcript.every((w) => w.s >= 0 && w.e <= c.duration + 0.1), 'transcript on the segment time');
  assert.deepEqual(p.tracks[2].clips.map((x) => [x.start, x.text]), plain.tracks[2].clips.map((x) => [x.start, x.text]), 'same captions as the centre crop');
  assert.equal(canFollowFace(media, '9:16'), true);
  assert.equal(canFollowFace(media, '16:9'), false, '16:9 short from 16:9 source: nothing to follow');
  assert.equal(canFollowFace({ width: 1080, height: 1920 }, '9:16'), false, 'already vertical');
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

test('legendas atrás: main word big behind the person, the rest in front on the chest', () => {
  const { shortProject, behindCaptions } = require('../electron/shorts.cjs');
  const { buildExport } = require('../electron/render.cjs');
  const c = ai.parseHotclips({ clips: [{ start: '00:00:10', end: '00:00:40', hook: 'Gancho', score: 8 }] }, words)[0];
  const media = { path: 'C:/x/video.mp4', duration: 120, width: 1920, height: 1080, transcript: words };
  const p = shortProject(media, c, { layout: 'atras', personMatte: 'C:/m/matte.mp4', face: { y: 0.3, h: 0.08 }, framed: { path: 'C:/cache/abc.mp4', width: 1080, height: 1920 } });
  const back = p.tracks.find((t) => t.id === 'tx');
  const front = p.tracks.find((t) => t.id === 'tf');
  assert.ok(back.clips.length > 3 && back.clips.every((x) => x.style === 'atras-grande' && x.text === x.text.toUpperCase() && !/\s/.test(x.text)));
  assert.ok(back.clips.every((x) => x.size >= 0.06 && x.size <= 0.2 && x.y < 0.3), 'big, above the face centre');
  assert.equal(front.front, true);
  assert.ok(front.clips.every((x) => x.style === 'frente-peito' && x.y > 0.3), 'small words below the face');
  const mk = p.tracks[0].clips[0].masks[0];
  assert.deepEqual([mk.shape, mk.mode, mk.matte.file], ['person', 'front', 'C:/m/matte.mp4']);
  assert.equal(p.tracks.find((t) => t.id === 'gx').front, true, 'cards over the person too');
  // Longer words get smaller so they stay inside 85 % of the width.
  const v = { start: 0, in: 0, out: 3 };
  const two = behindCaptions(v, [{ w: 'casa', s: 0, e: 1 }, { w: 'extraordinariamente', s: 1.2, e: 2 }], 1080, 1920, null);
  const long = two.back.find((x) => x.text === 'EXTRAORDINARIAMENTE');
  const short = two.back.find((x) => x.text === 'CASA');
  assert.ok(long && short && long.size < 0.1 && short.size > long.size * 2);
  // Export: only the front masks' layer separates the two caption files (needs the matte on disk, so
  // without it the person mask is not ready and everything stays in one file).
  const ex = buildExport(p, 'C:/x/out.mp4');
  assert.ok(ex.ass && !ex.extraFiles.some((f) => f.name === 'capsf.ass'));
});

test('clips start and end on sentence boundaries', () => {
  const W = (list) => list.map(([w, s, e]) => ({ w, s, e }));
  const ws = W([['junto?', 0, 0.4], ['Por', 2.1, 2.4], ['isso', 2.4, 2.5], ['é', 2.5, 2.6], ['com', 2.65, 2.8], ['o', 2.8, 2.9], ['dinheiro.', 2.9, 3.2], ['Porquê?', 4.5, 4.7], ['Porque', 5.5, 5.7], ['muda', 5.7, 5.9], ['tudo', 5.9, 6.1], ['na', 6.1, 6.2], ['vida.', 6.2, 6.5]]);
  assert.deepEqual(ai.snapToSentence(ws, 4, 9), { from: 1, to: 12 }, 'back to "Por", on to "vida."');
  assert.deepEqual(ai.snapToSentence(ws, 1, 6), { from: 1, to: 6 }, 'already clean');
  const far = W([['a', 0, 0.2], ['b', 0.2, 0.4], ...Array.from({ length: 30 }, (_, i) => [`w${i}`, 0.4 + i * 0.2, 0.6 + i * 0.2])]);
  assert.equal(ai.snapToSentence(far, 25, 26).from, 25, 'no break within 4 s: unchanged');
});

test('spell fixes: phrase runs replaced, times spread, punctuation and caps kept', () => {
  const W = (list) => list.map(([w, s, e]) => ({ w, s, e }));
  const ws = W([['Não', 0, 0.2], ['contes', 0.2, 0.5], ['os', 0.5, 0.6], ['teus', 0.6, 0.8], ['tios', 0.8, 1.1], ['para', 1.1, 1.3], ['ninguém.', 1.3, 1.7], ['TIVONE,', 2, 2.4], ['tomahawk', 2.5, 3]]);
  const fixes = ai.parseSpellFixes({ fixes: [{ wrong: 'teus tios', right: 'teus planos' }, { wrong: 'tivone', right: 'T-bone' }, { wrong: 'para', right: 'para', sure: true }, { wrong: 'x', right: 'y', sure: false }] });
  assert.deepEqual(fixes, [{ wrong: 'teus tios', right: 'teus planos' }, { wrong: 'tivone', right: 'T-bone' }]);
  const { words, applied } = ai.applySpellFixes(ws, fixes);
  assert.deepEqual(words.map((w) => w.w), ['Não', 'contes', 'os', 'teus', 'planos', 'para', 'ninguém.', 'T-BONE,', 'tomahawk']);
  assert.equal(words[4].e, 1.1);
  assert.equal(applied.length, 2);
  const split = ai.applySpellFixes(W([['um', 0, 1]]), [{ wrong: 'um', right: 'um dois' }]).words;
  assert.deepEqual(split.map((w) => [w.w, w.s, w.e]), [['um', 0, 0.5], ['dois', 0.5, 1]]);
});

test('keyword picks: checked per block, null when the model is off', () => {
  const blocks = [['a', 'casa', 'vendida'], ['em', 'dois']];
  assert.match(ai.keywordPrompt(blocks), /0: a casa vendida/);
  assert.deepEqual(ai.parseKeywordPicks({ pick: [1, 7] }, blocks), [1, null]);
  assert.deepEqual(ai.parseKeywordPicks({ pick: [-1] }, blocks), [-1, null]);
});

test('short project: AI keyword picks choose the big word of each block', () => {
  const { shortProject } = require('../electron/shorts.cjs');
  const ws = [['a', 10], ['casa', 10.3], ['vendida', 10.6], ['em', 11.5], ['dois', 11.8], ['semanas', 12.1]].map(([w, s]) => ({ w, s, e: s + 0.25 }));
  const c = { start: 10, end: 13, duration: 3, hook: '', outro: '' };
  const media = { path: 'C:/x/v.mp4', duration: 60, width: 1920, height: 1080, transcript: ws };
  const auto = shortProject(media, c, { layout: 'atras', personMatte: 'C:/m.mp4', cards: false });
  const picked = shortProject(media, c, { layout: 'atras', personMatte: 'C:/m.mp4', cards: false, keywords: [1, 1] });
  assert.deepEqual(auto.tracks.find((t) => t.id === 'tx').clips.map((x) => x.text), ['VENDIDA', 'SEMANAS']);
  assert.deepEqual(picked.tracks.find((t) => t.id === 'tx').clips.map((x) => x.text), ['CASA', 'DOIS']);
  assert.deepEqual(picked.tracks.find((t) => t.id === 'tf').clips.map((x) => x.text), ['a vendida', 'em semanas']);
});

test('publish pack: one text per network, YouTube title short, #shorts, warnings by length', () => {
  const long = 'x'.repeat(120);
  const p = ai.publishPosts({ title: long, hook: 'Gancho', outro: 'Segue', hashtags: ['#a', '#b', '#c', '#d', '#e', '#f'], duration: 200 });
  assert.ok(p.youtube.title.length <= 95);
  assert.match(p.youtube.description, /#shorts$/);
  assert.equal(p.instagram.split('\n').pop(), '#a #b #c #d #e', 'five hashtags');
  assert.equal(p.tiktok.split(' ').filter((w) => w.startsWith('#')).length, 4);
  assert.equal(p.warnings.length, 2);
  assert.deepEqual(ai.publishPosts({ title: 'T', duration: 40 }).warnings, []);
  assert.match(ai.publishText({ title: 'T', hook: 'H', outro: 'O', why: 'W', text: 'x', hashtags: [], duration: 30, score: 8 }), /## TikTok/);
});
