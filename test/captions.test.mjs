// v0.8: keyword captions (Felipe, Marta) and the AutoSubs grouping options.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pickKeyword, keywordOf, emphasisLines, linePositions, revealDur, riseAt } from '../src/lib/emphasis.js';

const require = createRequire(import.meta.url);
const { buildAss, STYLES } = require('../electron/render.cjs');
const { groupWords, captionClipsFor } = require('../electron/captions.cjs');

const W = (s, step = 0.2) => s.split(' ').map((w, i) => ({ w, s: i * step, e: i * step + 0.15 }));

test('keyword: longest content word, stop-words skipped, clip override wins', () => {
  assert.equal(pickKeyword(['Isto', 'é', 'Elite']), 2);
  assert.equal(pickKeyword(['de', 'um', 'T3']), -1, 'short and stop-words only');
  assert.equal(pickKeyword(['uma', 'cozinha', 'incrível!']), 2, 'punctuation does not count');
  assert.equal(pickKeyword(['para', 'você', 'não']), -1);
  assert.equal(keywordOf({ keyword: 0 }, ['a', 'casa']), 0);
  assert.equal(keywordOf({ keyword: -1 }, ['a', 'casa']), -1);
  assert.equal(keywordOf({ keyword: 9 }, ['a', 'casa']), -1, 'out of range = none');
  assert.equal(keywordOf({}, ['a', 'casa']), 1);
});

test('emphasis layout: Felipe rows, Marta slots with a stack', () => {
  const fel = STYLES.felipe.emphasis;
  const mar = STYLES.marta.emphasis;
  assert.deepEqual(emphasisLines(3, 2, fel).map((l) => l.role), ['base', 'kw']);
  assert.deepEqual(linePositions(emphasisLines(1, 0, fel), fel), [{ dx: 0, dy: fel.pitch }], 'a lone keyword sits on row 2');
  assert.deepEqual(emphasisLines(4, 1, mar).map((l) => [l.role, l.from, l.to]), [['base', 0, 1], ['kw', 1, 2], ['rest', 2, 4]]);
  assert.deepEqual(emphasisLines(4, -1, mar).map((l) => [l.role, l.from, l.to]), [['base', 0, 2], ['rest', 2, 4]], 'no keyword: base + stack');
  assert.equal(revealDur('Elite'), 0.04);
  assert.deepEqual(riseAt(0.05, { dist: 0.02, dur: 0.1, blur: 0.004 }), { dy: 0.01, blur: 0.002, alpha: 0.5 });
});

test('AutoSubs grouping: density, lines, case, punctuation, censored words', () => {
  const words = W('Olá, isto é merda. Uma casa incrível em Lisboa');
  assert.deepEqual(groupWords(words, { censor: ['merda'], textCase: 'upper', stripPunct: true }).map((c) => c.text), ['OLÁ', 'ISTO É M****', 'UMA CASA INCRÍVEL', 'EM LISBOA']);
  assert.deepEqual(groupWords(W('a b c d e'), { density: 'single' }).map((c) => c.text), ['a', 'b', 'c', 'd', 'e']);
  const long = W('a cozinha tem uma ilha enorme e luz natural', 0.1);
  const less = groupWords(long, { density: 'less', maxWords: 12, maxLines: 1 });
  assert.ok(less.every((c) => c.text.length <= 18), less.map((c) => c.text).join('|'));
  assert.deepEqual(groupWords(W('a CASA'), { textCase: 'title' }).map((c) => c.text), ['A Casa']);
  assert.deepEqual(groupWords(W('Olá. Sim'), { textCase: 'lower', stripPunct: true }).map((c) => c.words.map((w) => w.w)), [['olá'], ['sim']], 'punctuation still breaks blocks');
});

test('Felipe blocks keep the keyword at an edge; Marta uses its own word limit unless the Gui picks one', () => {
  const felipe = captionClipsFor({ start: 0, in: 0, out: 9 }, W('a cozinha tem uma ilha enorme e luz natural'), { style: 'felipe' });
  for (const c of felipe) {
    const kw = pickKeyword(c.words.map((w) => w.w));
    assert.ok(kw <= 0 || kw === c.words.length - 1, `keyword in the middle: ${c.text}`);
    assert.ok(c.words.length <= 3);
  }
  const marta = captionClipsFor({ start: 0, in: 0, out: 9 }, W('a cozinha tem uma ilha enorme e luz natural'), { style: 'marta' });
  assert.ok(marta.every((c) => c.words.length <= 3), 'style limit by default');
  const chosen = captionClipsFor({ start: 0, in: 0, out: 9 }, W('a cozinha tem uma ilha enorme e luz natural'), { style: 'marta', maxWords: 6 });
  assert.ok(chosen.every((c) => c.words.length <= 6) && chosen.some((c) => c.words.length > 3), 'the chosen number of words wins');
  const one = captionClipsFor({ start: 0, in: 0, out: 9 }, W('a cozinha tem uma ilha enorme e luz natural'), { style: 'felipe', maxWords: 1 });
  assert.ok(one.every((c) => c.words.length === 1), 'one word per caption');
});

const project = (clips) => ({ canvas: { w: 1080, h: 1920 }, tracks: [{ kind: 'text', clips }] });

test('ASS: Felipe reveal is a karaoke sweep, keyword rises in a second font', () => {
  const ass = buildAss(project([{ id: 'a', start: 1, in: 0, out: 1.5, text: 'o que falta', style: 'felipe', words: [{ w: 'o', s: 0, e: 0.2 }, { w: 'que', s: 0.25, e: 0.4 }, { w: 'falta', s: 0.45, e: 0.9 }] }]), { userFonts: false });
  const ev = ass.split('\n').filter((l) => l.startsWith('Dialogue'));
  const base = ev.filter((l) => /\\fnInter Black/.test(l) && /\\1c&H00FFFFFF/.test(l));
  assert.equal(base.length, 2, 'one fill event per spoken base word');
  assert.match(base[0], /\{\\2a&HFF&\\kf1\}o\{\\k0\\alpha&HFF&\} que/);
  assert.match(base[1], /^Dialogue: 5,0:00:01\.25,/);
  const kw = ev.filter((l) => /\\fnGreat Vibes/.test(l));
  assert.ok(kw.length >= 10, 'shadow, glow and gradient bands');
  assert.ok(kw.every((l) => /\\fscx80/.test(l) && /\\move\(/.test(l) && /\\fad\(100,0\)/.test(l) && /falta$/.test(l)));
  assert.ok(kw.every((l) => l.startsWith('Dialogue: 9,') || l.startsWith('Dialogue: 10,') || l.startsWith('Dialogue: 11,')), 'keyword drawn over the base words');
  assert.ok(kw.some((l) => /\\clip\(0,\d+,1080,\d+\)/.test(l)), 'gradient as bands');
});

test('ASS: Marta keyword uses the installed font or the bundled fallback, override and none respected', () => {
  const clip = (extra) => ({ id: 'b', start: 0, in: 0, out: 1.5, text: 'de um T3 em Benfica', style: 'marta', words: W('de um T3 em Benfica', 0.1), ...extra });
  const fallback = buildAss(project([clip({})]), { userFonts: false });
  assert.match(fallback, /\\fnGreat Vibes[^}]*\}Benfica/);
  assert.match(fallback, /\\fnInter Black[^}]*\}de um T3 em$/m);
  const files = new Set();
  const real = buildAss(project([clip({})]), { files });
  if (files.size) assert.match(real, /\\fnBirds of Paradise/, 'installed user font is used and reported for copying');
  const forced = buildAss(project([clip({ keyword: 2 })]), { userFonts: false });
  assert.match(forced, /\}T3$/m);
  assert.match(forced, /\}em Benfica$/m, 'words after the keyword go to the stack');
  const none = buildAss(project([clip({ keyword: -1 })]), { userFonts: false });
  assert.ok(!/Great Vibes/.test(none));
  assert.match(none, /\}de um$/m);
  assert.match(none, /\}T3 em Benfica$/m);
});

test('ASS: Felipe lines move apart (clip.lines), each by its own offset in frame fractions', () => {
  const words = [{ w: 'o', s: 0, e: 0.2 }, { w: 'que', s: 0.25, e: 0.4 }, { w: 'falta', s: 0.45, e: 0.9 }];
  const base = { id: 'a', start: 1, in: 0, out: 1.5, text: 'o que falta', style: 'felipe', words };
  const posOf = (ass, font) => {
    const line = ass.split('\n').find((l) => l.startsWith('Dialogue') && l.includes(`\\fn${font}`));
    const m = /\\pos\(([\d.]+),([\d.]+)\)|\\move\(([\d.]+),[\d.]+,[\d.]+,([\d.]+)/.exec(line);
    return m[1] ? [Number(m[1]), Number(m[2])] : [Number(m[3]), Number(m[4])];
  };
  const before = buildAss(project([base]), { userFonts: false });
  const after = buildAss(project([{ ...base, lines: { kw: { x: 0.1, y: -0.05 } } }]), { userFonts: false });
  const [bx, by] = posOf(before, 'Inter Black');
  const [ax, ay] = posOf(after, 'Inter Black');
  assert.deepEqual([ax, ay], [bx, by], 'the top words stay put');
  const [kx, ky] = posOf(before, 'Great Vibes');
  const [mx, my] = posOf(after, 'Great Vibes');
  const { w, h } = project([]).canvas;
  assert.ok(Math.abs(mx - kx - 0.1 * w) < 0.6 && Math.abs(my - ky + 0.05 * h) < 0.6, 'the keyword moves by its own offset');
});

test('ASS: one-line layout puts every word in one event per pass; line gap and anim follow the override', async () => {
  const { applyOverride } = await import('../src/lib/capstyle.js');
  const words = [{ w: 'o', s: 0, e: 0.2 }, { w: 'que', s: 0.25, e: 0.4 }, { w: 'falta', s: 0.45, e: 0.9 }];
  const clip = { id: 'a', start: 1, in: 0, out: 1.5, text: 'o que falta', style: 'felipe', words, override: { layout: 'line', textAnim: 'none' } };
  const ass = buildAss(project([clip]), { userFonts: false });
  const fills = ass.split('\n').filter((l) => l.startsWith('Dialogue: 2,'));
  assert.equal(fills.length, 1, 'one fill event for the whole line');
  assert.ok(fills[0].includes('Inter Black') && fills[0].includes('Great Vibes') && /o.*que.*falta/.test(fills[0]), 'both fonts inline, words in order');
  const st = applyOverride(STYLES.felipe, { lineGap: 2, keywordAnim: 'rise' });
  assert.ok(Math.abs(st.emphasis.pitch - STYLES.felipe.emphasis.pitch * 2) < 1e-9);
  assert.equal(st.emphasis.keyword.anim, 'rise');
});
