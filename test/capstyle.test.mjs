// v0.9.1: per-caption looks (override), saved caption styles and installed fonts on export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { applyOverride, cleanOverride, resolveCaptionStyle, validateStore, validateStyle, styleIdFor, MY_STYLE_ID } from '../src/lib/capstyle.js';

const require = createRequire(import.meta.url);
const { buildAss, STYLES } = require('../electron/render.cjs');
const { createStyleStore } = require('../electron/styles.cjs');
const { readFaces, findFamily } = require('../electron/fonts.cjs');

const project = (clips, extra = {}) => ({
  canvas: { w: 1080, h: 1920, fps: 30 },
  media: [],
  tracks: [{ id: 'tx', kind: 'text', name: 'Legendas', clips }],
  ...extra,
});

test('override: cleaned, merged over the style, keyword styles route colour and fonts to their layers', () => {
  assert.equal(cleanOverride({ color: 'red', font: '' }), undefined, 'nothing valid = no override');
  assert.deepEqual(cleanOverride({ color: '#ff0000', font: ' Arial ', junk: 1, keywordFont: 'a{\\b}' }), { color: '#FF0000', font: 'Arial' });
  const elite = applyOverride(STYLES.elite, { color: '#D4AF37', font: 'Anton', highlight: '#83163A' });
  assert.equal(elite.color, '#D4AF37');
  assert.equal(elite.font, 'Anton');
  assert.equal(elite.highlight, '#83163A');
  assert.equal(STYLES.elite.color, '#FFFFFF', 'preset untouched');
  const fel = applyOverride(STYLES.felipe, { color: '#FFD60A', keywordColor: '#83163A', keywordFont: 'Anton' });
  assert.equal(fel.emphasis.base.color, '#FFD60A');
  assert.equal(fel.emphasis.keyword.color, '#83163A');
  assert.equal(fel.emphasis.keyword.font, 'Anton');
  assert.equal(fel.emphasis.keyword.color2, undefined, 'a chosen colour replaces the gradient');
  assert.equal(STYLES.felipe.emphasis.keyword.color2, '#3C73BC', 'preset gradient untouched');
  // highlight doubles as the keyword colour of keyword styles
  assert.equal(applyOverride(STYLES.marta, { highlight: '#FFFFFF' }).emphasis.keyword.color, '#FFFFFF');
});

test('style resolution: embedded project style, saved style, old custom style, preset fallback', () => {
  const mine = { ...STYLES.clean, label: 'Meu', color: '#00FF00' };
  assert.equal(resolveCaptionStyle({ style: 'u-meu' }, { styles: { 'u-meu': mine } }, STYLES).color, '#00FF00');
  assert.equal(resolveCaptionStyle({ style: 'u-meu' }, {}, STYLES, { 'u-meu': mine }).color, '#00FF00');
  assert.equal(resolveCaptionStyle({ style: 'custom' }, { captionStyle: mine }, STYLES).color, '#00FF00');
  assert.equal(resolveCaptionStyle({ style: 'nope' }, {}, STYLES).label, STYLES.elite.label);
  assert.equal(resolveCaptionStyle({ style: 'elite', override: { color: '#123456' } }, {}, STYLES).color, '#123456');
});

test('style store: validation drops bad entries and unsafe values; saves round-trip', () => {
  const store = validateStore({
    styles: {
      'u-ok': { label: 'Ok', font: 'Anton', size: 0.06, color: '#ffffff', anim: 'bounce', y: 2, evil: '<script>' },
      'bad id!': { label: 'x', font: 'Anton', size: 0.06, color: '#ffffff' },
      'u-nofont': { label: 'x', size: 0.06, color: '#ffffff' },
      'u-inject': { label: 'x', font: 'Arial,0,&H00', size: 0.06, color: '#ffffff' },
      'u-badanim': { label: 'x', font: 'Anton', size: 0.06, color: '#ffffff', anim: 'explode', emphasis: { mode: 'rows' } },
    },
  });
  assert.deepEqual(Object.keys(store.styles), ['u-ok', 'u-badanim']);
  assert.equal(store.styles['u-ok'].color, '#FFFFFF');
  assert.equal(store.styles['u-ok'].y, 1, 'clamped');
  assert.equal(store.styles['u-ok'].evil, undefined);
  assert.equal(store.styles['u-badanim'].anim, undefined);
  assert.equal(store.styles['u-badanim'].emphasis, undefined, 'incomplete emphasis dropped');
  assert.ok(validateStyle(STYLES.marta).emphasis.keyword, 'real keyword styles survive');
  assert.deepEqual(validateStore(null), { version: 1, styles: {} });
  assert.equal(styleIdFor('Legenda Ação!', new Set(['u-legenda-acao'])), 'u-legenda-acao-2');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-styles-'));
  const file = path.join(dir, 'caption-styles.json');
  const s = createStyleStore(file);
  const a = s.save(null, { ...STYLES.elite, label: 'Dourado' });
  assert.equal(a.id, 'u-dourado');
  s.save(MY_STYLE_ID, { ...STYLES.clean, label: 'O meu estilo' });
  assert.deepEqual(Object.keys(s.list()).sort(), [MY_STYLE_ID, 'u-dourado']);
  assert.throws(() => s.save(null, { label: 'x' }), /inválido/);
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(s.list(), {}, 'a damaged file reads as empty, never throws');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ASS: a caption override gets its own style line with the chosen font and colours', () => {
  const ass = buildAss(
    project([
      { id: 'a', start: 0, in: 0, out: 1, text: 'olá mundo', style: 'elite' },
      { id: 'b', start: 1, in: 0, out: 1, text: 'isto é elite', style: 'elite', override: { color: '#D4AF37', font: 'Anton', highlight: '#83163A' } },
      { id: 'c', start: 2, in: 0, out: 1, text: 'meu estilo', style: 'u-meu' },
    ], { styles: { 'u-meu': { ...STYLES.clean, label: 'Meu', font: 'Bebas Neue', color: '#00FF00' } } }),
    { userFonts: false },
  );
  const styles = ass.split('\n').filter((l) => l.startsWith('Style: '));
  assert.ok(styles.some((l) => l.startsWith('Style: elite,Arial Black,')));
  const o = styles.find((l) => l.startsWith('Style: elite_o1,'));
  assert.ok(o, 'override style line');
  assert.match(o, /^Style: elite_o1,Anton,\d+,&H0037AFD4,&H003A1683,/, 'font, text colour (BGR) and highlight');
  assert.ok(styles.some((l) => l.startsWith('Style: u-meu,Bebas Neue,') && l.includes('&H0000FF00')), 'embedded saved style');
  assert.ok(ass.includes(',elite_o1,,0,0,0,,'), 'the event uses the override style');
  // keyword captions: keyword colour/font go into the inline tags of the keyword line
  const fel = buildAss(project([{ id: 'k', start: 0, in: 0, out: 1, text: 'uma casa incrível', style: 'felipe', keyword: 2, override: { keywordColor: '#83163A', keywordFont: 'Anton' } }]), { userFonts: false });
  assert.ok(fel.includes('\\fnAnton') && fel.includes('\\1c&H003A1683'), 'keyword font and colour');
});

test('installed fonts: family read from the file, and the export copies the files of a chosen PC font', { skip: !fs.existsSync('C:\\Windows\\Fonts\\arial.ttf') }, () => {
  assert.equal(readFaces('C:\\Windows\\Fonts\\arial.ttf')[0].family, 'Arial');
  const cache = path.join(os.tmpdir(), `ec-font-cache-${process.pid}.json`);
  assert.ok(findFamily('arial', cache).files.some((f) => /arial\.ttf$/i.test(f)));
  const files = new Set();
  const { setFontCache } = require('../electron/render.cjs');
  setFontCache(cache);
  buildAss(project([{ id: 'a', start: 0, in: 0, out: 1, text: 'olá', style: 'clean', override: { font: 'Arial' } }]), { files });
  assert.ok([...files].some((f) => /arial\.ttf$/i.test(f)), 'Arial copied next to caps.ass');
  const none = new Set();
  buildAss(project([{ id: 'a', start: 0, in: 0, out: 1, text: 'olá', style: 'clean', override: { font: 'Anton' } }]), { files: none });
  assert.ok(![...none].some((f) => /anton/i.test(f)), 'bundled fonts are not looked up on the PC');
  fs.rmSync(cache, { force: true });
});
