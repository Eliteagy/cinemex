// Edit packs: validation, the saved-packs store, and the shorts options a pack turns into.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { BUILTIN_PACKS, validatePack, packShortOptions } from '../src/lib/editpacks.js';
import { BUILTIN_MODELS } from '../src/lib/capmodels.js';

const require = createRequire(import.meta.url);
const { createPackStore } = require('../electron/editpacks.cjs');

test('built-in packs are valid and name real caption models', () => {
  for (const [id, p] of Object.entries(BUILTIN_PACKS)) {
    assert.deepEqual(validatePack(p), p, id);
    assert.ok(BUILTIN_MODELS[p.captionModel], `${id}: ${p.captionModel}`);
  }
});

test('validation: model required, punch clamped, unknown music off, effects ids only', () => {
  assert.equal(validatePack({ label: 'x' }), null);
  const p = validatePack({ captionModel: 'vitor', punch: 2, music: 'rock', effects: ['e-ok', '../x', 'e-ok', 5], cta: 'a\u0000b' });
  assert.deepEqual([p.punch, p.music, p.effects, p.cta, p.keywordAI], [0.3, 'off', ['e-ok'], 'a b', true]);
  assert.equal(validatePack({ captionModel: 'vitor', punch: true }).punch, 0.12);
});

test('pack -> shorts options', () => {
  assert.deepEqual(packShortOptions(BUILTIN_PACKS.palestra), { model: 'duas-linhas', keywordAI: true, punch: 0.15, sfx: true, music: 'forte', broll: false, progress: true, cta: 'Segue para mais' });
  assert.equal(packShortOptions({ captionModel: 'vitor', punch: 0, music: 'off' }).punch, false);
});

test('pack store: built-ins untouched, saved packs listed, validated on read', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pk-')), 'edit-packs.json');
  const s = createPackStore(file);
  const r = s.save('vitor', { ...BUILTIN_PACKS.vitor, label: 'Vitor forte', music: 'forte' });
  assert.equal(r.id, 'p-vitor-forte');
  assert.equal(s.resolve('vitor').music, 'calma');
  assert.equal(s.resolve(r.id).music, 'forte');
  assert.equal(s.list().length, Object.keys(BUILTIN_PACKS).length + 1);
  fs.writeFileSync(file, JSON.stringify({ packs: { 'p-ok': BUILTIN_PACKS.imovel, 'p-bad': { label: 'x' }, vitor: BUILTIN_PACKS.vitor } }));
  assert.deepEqual(s.list().filter((p) => !p.builtin).map((p) => p.id), ['p-ok']);
  assert.ok(s.delete('p-ok'));
  assert.throws(() => s.resolve('nada'), /desconhecido/);
});
