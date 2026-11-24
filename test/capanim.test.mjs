// Phase 2: caption gallery of 100+ styles and the new caption effects (src/lib/capanim.js),
// drawn by the preview (src/engine/caption.ts) and exported as ASS (electron/render.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ANIMS, CATEGORIES, validateStyle } from '../src/lib/capstyle.js';
import { ANIM_LABELS, INTROS, STEPS, introAt, introAss, stepAt, stepTimes, typedChars, typeTimes, wordScaleAt, wordScaleAss } from '../src/lib/capanim.js';

const require = createRequire(import.meta.url);
const { buildAss, STYLES } = require('../electron/render.cjs');
const { TOOLS } = require('../electron/mcp.cjs');

const ORIGINAL = ['elite', 'clean', 'box', 'title', 'impacto', 'karaoke', 'marcador', 'neon', 'bd', 'caneta', 'deslizar', 'sombra', 'cinema', 'felipe', 'marta'];
const NEW_ANIMS = ['typewriter', 'blur', 'zoom', 'flip', 'stretch', 'drop', 'rise', 'shake', 'glitch', 'colorsweep', 'scaleword', 'popin'];
const WORDS = [
  { w: 'Isto', s: 0, e: 0.3 },
  { w: 'é', s: 0.32, e: 0.45 },
  { w: 'Elite', s: 0.48, e: 0.95 },
];
const style = (anim, extra = {}) => ({ label: 't', font: 'Anton', size: 0.06, color: '#FFFFFF', highlight: '#D4AF37', outline: 0.005, outlineColor: '#000000', box: false, uppercase: true, y: 0.7, anim, ...extra });
const assFor = (st, words = WORDS, dur = 2) => {
  const p = { canvas: { w: 1080, h: 1920, fps: 30 }, media: [], styles: { t: st }, tracks: [{ id: 'tx', kind: 'text', clips: [{ id: 'a', start: 1, in: 0, out: dur, text: 'Isto é Elite', style: 't', ...(words ? { words } : {}) }] }] };
  return buildAss(p, { files: new Set() })
    .split('\n')
    .filter((l) => l.startsWith('Dialogue:'));
};

test('gallery: 100+ styles, every one valid, categorised, original ids kept', () => {
  const entries = Object.entries(STYLES).filter(([k]) => k !== '_comment');
  assert.ok(entries.length >= 100, `${entries.length} styles`);
  for (const id of ORIGINAL) assert.ok(STYLES[id], `original style ${id} kept`);
  const counts = {};
  for (const [id, raw] of entries) {
    const st = validateStyle(raw);
    assert.ok(st, `${id} validates`);
    assert.ok(CATEGORIES.includes(raw.category), `${id}: category ${raw.category}`);
    assert.equal(st.category, raw.category, `${id}: category kept by validateStyle`);
    assert.equal(st.anim, raw.anim, `${id}: anim ${raw.anim} kept by validateStyle`);
    if (raw.emphasis) assert.ok(st.emphasis, `${id}: keyword layers kept`);
    assert.ok(/^[a-z0-9][a-z0-9-]*$/.test(id), `${id}: plain id`);
    counts[raw.category] = (counts[raw.category] ?? 0) + 1;
  }
  for (const c of CATEGORIES) assert.ok(counts[c] >= 5, `${c}: ${counts[c]} styles`);
  const labels = entries.map(([, s]) => s.label);
  assert.equal(new Set(labels).size, labels.length, 'labels are unique');
  assert.ok(entries.some(([, s]) => s.color === '#D4AF37' || s.highlight === '#D4AF37' || s.boxColor === '#D4AF37' || s.marker === '#D4AF37'), 'gold brand options');
});

test('styles only use bundled or Windows fonts, and bundled fonts have their file and licence', () => {
  const src = fs.readFileSync(new URL('../src/engine/caption.ts', import.meta.url), 'utf8');
  const bundled = Object.fromEntries([...src.matchAll(/^\s+'?([A-Za-z0-9 ]+?)'?: '([A-Za-z0-9-]+\.ttf)',$/gm)].map((m) => [m[1], m[2]]));
  assert.ok(Object.keys(bundled).length >= 20, `bundled fonts read: ${Object.keys(bundled).join(', ')}`);
  const system = new Set(['Arial Black', 'Segoe UI', 'Segoe UI Semibold', 'Segoe UI Bold', 'Segoe UI Black', 'Courier New']);
  for (const [family, file] of Object.entries(bundled)) assert.ok(fs.existsSync(new URL(`../public/fonts/${file}`, import.meta.url)), `${family}: ${file}`);
  for (const [id, st] of Object.entries(STYLES)) {
    if (id === '_comment') continue;
    const fonts = st.emphasis ? [st.emphasis.base.font, st.emphasis.keyword.font, st.emphasis.rest?.font].filter(Boolean) : [st.font];
    for (const f of fonts) assert.ok(bundled[f] || system.has(f) || f === 'Birds of Paradise', `${id}: font ${f}`);
  }
  const readme = fs.readFileSync(new URL('../public/fonts/README.md', import.meta.url), 'utf8');
  for (const family of Object.keys(bundled)) assert.ok(readme.includes(family), `README lists the licence of ${family}`);
});

test('every effect has a PT-PT name and survives validation', () => {
  for (const a of NEW_ANIMS) assert.ok(ANIMS.includes(a), a);
  for (const a of ANIMS) {
    assert.ok(ANIM_LABELS[a], `label for ${a}`);
    assert.equal(validateStyle(style(a)).anim, a);
  }
  assert.equal(validateStyle(style('wobble')).anim, undefined, 'unknown effects are dropped');
});

test('preview timing: intros, steps, typewriter and word scales at start, middle and end', () => {
  for (const [a, I] of Object.entries(INTROS)) {
    const s0 = introAt(a, 0);
    const mid = introAt(a, I.dur / 2000);
    const end = introAt(a, I.dur / 1000);
    assert.deepEqual(end, { sx: 1, sy: 1, dy: 0, alpha: 1, blur: 0, bord: 1 }, `${a} lands on the plain caption`);
    for (const k of ['sx', 'sy', 'dy', 'blur']) {
      assert.ok(Number.isFinite(s0[k]) && Number.isFinite(mid[k]), `${a}.${k}`);
      assert.ok(Math.abs(mid[k] - (s0[k] + end[k]) / 2) < 1e-9, `${a}.${k} is linear (like ASS \\t)`);
    }
    if (I.fade) assert.equal(s0.alpha, 0, `${a} starts transparent`);
  }
  assert.equal(introAt('zoom', 0).sx, 1.6);
  assert.equal(introAt('flip', 0).sy, 0);
  assert.ok(introAt('drop', 0).dy < 0 && introAt('rise', 0).dy > 0, 'drop comes from above, rise from below');
  assert.deepEqual(introAt('words', 0.01), { sx: 1, sy: 1, dy: 0, alpha: 1, blur: 0, bord: 1 }, 'no intro');

  for (const a of Object.keys(STEPS)) {
    assert.notEqual(stepAt(a, 0).dx, 0, `${a} moves at once`);
    const times = stepTimes(a);
    assert.deepEqual(stepAt(a, times[times.length - 1] + 0.001), { dx: 0, dy: 0, flash: null }, `${a} settles`);
  }
  assert.equal(stepAt('glitch', 0).flash, '#00F0FF');
  assert.equal(stepAt('glitch', 0.06).flash, '#FF2D75');

  assert.equal(typedChars(WORDS, 0, -0.1), 0);
  assert.equal(typedChars(WORDS, 0, 0), 1);
  assert.equal(typedChars(WORDS, 0, 0.3), 4, 'whole word typed before the next word');
  assert.equal(typedChars(WORDS, 2, 0.48 + 0.04 * 2.5), 3);
  assert.equal(typeTimes(WORDS).length, 'IstoéElite'.length);

  assert.equal(wordScaleAt('popin', 0), 0.4);
  assert.ok(Math.abs(wordScaleAt('popin', 0.06) - 0.7) < 1e-9);
  assert.equal(wordScaleAt('popin', 1), 1);
  assert.equal(wordScaleAt('scaleword', 0), 1);
  assert.equal(wordScaleAt('scaleword', 1), 1.25);
  assert.equal(wordScaleAt('pop', 0.05), 1);
});

test('export tags carry the same numbers as the preview, also when an event starts mid-animation', () => {
  const o = { x: 540, y: 1344, H: 1920, size: 115, bord: 10, glowBlur: 0 };
  const z0 = introAss('zoom', 0, o);
  assert.equal(z0.scale, '\\fscx160\\fscy160\\t(0,200,\\fscx100\\fscy100)');
  assert.equal(z0.fade, '\\fade(255,0,0,0,200,200,200)');
  const z = introAss('zoom', 100, o);
  assert.equal(z.scale, `\\fscx${introAt('zoom', 0.1).sx * 100}\\fscy${introAt('zoom', 0.1).sy * 100}\\t(0,100,\\fscx100\\fscy100)`, 'continues from where the preview is');
  assert.equal(z.fade, '\\fade(128,0,0,0,100,100,100)');
  assert.equal(introAss('zoom', 250, o).scale, '\\fscx100\\fscy100', 'done');
  const d = introAss('drop', 0, o);
  assert.equal(d.pos, `\\move(540,${Math.round(1344 - 0.08 * 1920)},540,1344,0,220)`);
  const r = introAss('rise', 160, o);
  assert.equal(r.pos, `\\move(540,${Math.round(1344 + 0.03 * 1920)},540,1344,0,160)`);
  assert.equal(r.bord, '\\bord5\\t(0,160,\\bord10)');
  assert.equal(wordScaleAss('popin', 0), '\\fscx40\\fscy40\\t(0,120,\\fscx100\\fscy100)');
  assert.equal(wordScaleAss('scaleword', 0.05), '\\fscx112.5\\fscy112.5\\t(0,50,\\fscx125\\fscy125)');
});

test('every effect exports a caption (timed and untimed) with its tags', () => {
  for (const a of ANIMS) {
    for (const words of [WORDS, null]) {
      const ev = assFor(style(a), words);
      assert.ok(ev.length >= 1, `${a}: events`);
      for (const e of ev) assert.ok(!/NaN|undefined|Infinity/.test(e), `${a}: ${e}`);
    }
  }
  const has = (a, re, extra) => assert.ok(assFor(style(a, extra)).some((e) => re.test(e)), `${a} ${re}`);
  has('zoom', /\\fscx160\\fscy160\\t\(0,200,\\fscx100\\fscy100\)/);
  has('flip', /\\fscx100\\fscy0\\t\(0,220,/);
  has('stretch', /\\fscx160\\fscy50\\t\(0,240,/);
  has('drop', /\\move\(540,1190,540,1344,0,220\)\\fade\(255,/);
  has('rise', /\\move\(540,1459,540,1344,0,320\).*\\blur[\d.]+\\t\(0,320,\\blur0\)\\bord0\\t\(0,320,\\bord10\)/);
  has('blur', /\\blur23\\t\(0,300,\\blur0\)\\bord0\\t\(0,300,\\bord10\)/);
  has('blur', /\\blur23\\t\(0,300,\\blur14\)/, { glow: true });
  has('glitch', /\\c&H00FFF000/);
  has('glitch', /\\c&H00752DFF/);
  has('scaleword', /\\t\(0,100,\\fscx125\\fscy125\)/);
  has('popin', /\\fscx40\\fscy40\\t\(0,120,\\fscx100\\fscy100\)/);

  // Shake: one event per step, each at its own place, then still.
  const shake = assFor(style('shake'));
  const pos = shake.map((e) => e.match(/\\pos\((\d+),(\d+)\)/)?.slice(1).join(','));
  assert.ok(new Set(pos).size >= 8, pos.join(' '));
  assert.equal(pos[pos.length - 1], '540,1344');

  // Typewriter: one event per letter; hidden letters are transparent but keep their place.
  const tw = assFor(style('typewriter'));
  assert.equal(tw.length, 'ISTOÉELITE'.length);
  assert.ok(tw[0].includes('}I{\\1a&HFF&\\3a&HFF&\\4a&HFF&}STO{'), tw[0]);
  assert.ok(!tw[tw.length - 1].includes('\\1a&HFF&'), 'everything typed at the end');
  const untimed = assFor(style('typewriter'), null);
  assert.equal(untimed.length, 'Isto é Elite'.length, 'untimed captions are typed letter by letter too');

  // Colour sweep: the spoken words keep the highlight.
  const sweep = assFor(style('colorsweep'));
  assert.equal((sweep[sweep.length - 1].match(/\\c&H0037AFD4/g) ?? []).length, 3);
  // Highlight-based effects only colour the current word.
  const pop = assFor(style('pop'));
  assert.equal((pop[pop.length - 1].match(/\\c&H0037AFD4/g) ?? []).length, 1);
});

test('the gallery styles all export', () => {
  for (const [id, st] of Object.entries(STYLES)) {
    if (id === '_comment') continue;
    const p = { canvas: { w: 1080, h: 1920, fps: 30 }, media: [], tracks: [{ id: 'tx', kind: 'text', clips: [{ id: 'a', start: 0, in: 0, out: 2, text: 'Isto é Elite', style: id, words: WORDS }] }] };
    const ass = buildAss(p, { files: new Set(), userFonts: false });
    assert.ok(ass && ass.includes(`Style: ${id},`), id);
    assert.ok(!/NaN|undefined/.test(ass), id);
  }
});

test('MCP tool descriptions list the styles from styles.json', () => {
  const desc = TOOLS.find((t) => t.name === 'add_text').inputSchema.properties.style.description;
  for (const id of ['elite', 'felipe', 'marta', 'viral', 'kw-dourado', 'pixel']) assert.ok(desc.includes(id), id);
  for (const c of CATEGORIES) assert.ok(desc.includes(c), c);
  const save = TOOLS.find((t) => t.name === 'save_caption_style').inputSchema.properties.style.description;
  for (const a of NEW_ANIMS) assert.ok(save.includes(a), a);
});
