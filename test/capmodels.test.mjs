// Caption models ("Modelos de legendas"): validation, the saved-models store and the caption layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { BUILTIN_MODELS, validateModel, modelCaptions, isAccent, fitSize, validateModelStore } from '../src/lib/capmodels.js';

const require = createRequire(import.meta.url);
const { createModelStore } = require('../electron/capmodels.cjs');
const W = 1080;
const H = 1920;
const g = (start, ...ws) => ({ start, in: 0, out: 1.2, text: ws.join(' '), words: ws.map((w, i) => ({ w, s: i * 0.3, e: i * 0.3 + 0.25 })) });
const face = { y: 0.3, h: 0.08 };

test('built-in models are valid and keep their values', () => {
  for (const [id, m] of Object.entries(BUILTIN_MODELS)) assert.deepEqual(validateModel(m), m, id);
  assert.equal(Object.keys(BUILTIN_MODELS).length, 4);
});

test('validation clamps numbers and drops unsafe fonts, colours and unknown kinds', () => {
  assert.equal(validateModel({ kind: 'nope' }), null);
  const m = validateModel({ kind: 'atras-frente', label: 'X\u0000', back: { font: 'Evil}{\b1', color: 'red', width: 9, maxSize: -1 }, front: { size: 1 }, accent: { color: '#00ff00', words: ['Casa!', 'casa'] } });
  assert.equal(m.label, 'X');
  assert.equal(m.back.font, 'Inter Black');
  assert.equal(m.back.color, '#FFFFFF');
  assert.equal(m.back.width, 0.98);
  assert.equal(m.back.maxSize, 0.06);
  assert.equal(m.front.size, 0.1);
  assert.deepEqual(m.accent, { color: '#00FF00', numbers: false, words: ['casa'] });
  assert.equal(validateModel({ kind: 'gigante', maxWords: 4 }).maxWords, 1);
  assert.equal(validateModel({ kind: 'gigante' }).front, undefined);
});

test('atras-frente: keyword big behind the head, the rest small on the chest', () => {
  const { back, front } = modelCaptions(BUILTIN_MODELS.vitor, [g(0, 'a', 'casa', 'vendida'), g(2, 'em', 'dois', 'semanas')], W, H, face);
  assert.deepEqual(back.map((c) => c.text), ['VENDIDA', 'SEMANAS']);
  assert.ok(back.every((c) => c.style === 'atras-grande' && c.y < face.y && c.size > 0.1));
  assert.deepEqual(front.map((c) => c.text), ['a casa', 'em dois']);
  assert.ok(front.every((c) => c.style === 'frente-peito' && c.y > face.y + face.h));
});

test('atras-cor: accent words and numbers get the accent colour', () => {
  const { back } = modelCaptions(BUILTIN_MODELS['atras-cor'], [g(0, 'muita', 'gente'), g(2, 'casa', 'vendida'), g(4, 'por', '300', 'mil')], W, H, face);
  const colour = (t) => back.find((c) => c.text === t)?.override?.color;
  assert.equal(colour('GENTE'), undefined);
  assert.equal(colour('VENDIDA'), '#D4AF37', 'casa/vendida are accent words');
  assert.equal(back.find((c) => c.text === 'VENDIDA').override.highlight, '#D4AF37', 'the spoken word too');
  assert.ok(isAccent('300', BUILTIN_MODELS['atras-cor'].accent));
  assert.ok(isAccent('15%', BUILTIN_MODELS['atras-cor'].accent));
});

test('gigante: every word big behind, nothing in front; duas-linhas: two lines, top bigger', () => {
  const gig = modelCaptions(BUILTIN_MODELS.gigante, [g(0, 'nunca'), g(1, 'desistas')], W, H, face);
  assert.deepEqual(gig.back.map((c) => c.text), ['NUNCA', 'DESISTAS']);
  assert.equal(gig.front.length, 0);
  const two = modelCaptions(BUILTIN_MODELS['duas-linhas'], [g(0, 'a', 'pobreza', 'é', 'coletiva')], W, H, face);
  assert.deepEqual(two.back.map((c) => c.text), ['A POBREZA', 'É COLETIVA']);
  assert.ok(two.back[0].y < two.back[1].y && two.back[0].size >= two.back[1].size);
});

test('fitSize: longer words smaller, capped by maxSize, inside the width', () => {
  assert.equal(fitSize('SIM', 'Inter Black', 0.85, 0.2, W, H), 0.2);
  const long = fitSize('EXTRAORDINARIAMENTE', 'Inter Black', 0.85, 0.2, W, H);
  assert.ok(long < 0.06 && long >= 0.05);
});

test('model store: saves, never overwrites a built-in, validates on read, deletes', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-')), 'caption-models.json');
  const store = createModelStore(file);
  const a = store.save('vitor', { ...BUILTIN_MODELS.vitor, label: 'Vitor dourado', back: { ...BUILTIN_MODELS.vitor.back, color: '#D4AF37' } });
  assert.equal(a.id, 'u-vitor-dourado');
  assert.equal(store.resolve('vitor').back.color, '#FFFFFF', 'built-in untouched');
  assert.equal(store.resolve(a.id).back.color, '#D4AF37');
  const b = store.save(null, { ...BUILTIN_MODELS.gigante, label: 'Vitor dourado' });
  assert.equal(b.id, 'u-vitor-dourado-2');
  assert.equal(store.list().filter((m) => !m.builtin).length, 2);
  fs.writeFileSync(file, JSON.stringify({ models: { 'u-bad': { kind: 'x' }, vitor: BUILTIN_MODELS.gigante, '../x': BUILTIN_MODELS.vitor, 'u-ok': BUILTIN_MODELS.vitor } }));
  assert.deepEqual(Object.keys(validateModelStore(JSON.parse(fs.readFileSync(file, 'utf8'))).models), ['u-ok']);
  assert.equal(store.delete('u-ok'), true);
  assert.equal(store.delete('vitor'), false);
  assert.throws(() => store.resolve('nada'), /desconhecido/);
});
