// What the app learned from the Gui's corrections (electron/learn.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLearnStore } = require('../electron/learn.cjs');

test('learn store: word fixes count up, keywords need the word in the block, bad entries dropped', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'learn-')), 'learned.json');
  const l = createLearnStore(file);
  l.addWord('tios', 'planos');
  const d = l.addWord('Tios', 'planos');
  assert.deepEqual(d.words, [{ from: 'tios', to: 'planos', n: 2 }]);
  assert.equal(l.addWord('casa', 'Casa').words.length, 1, 'only case: not a fix');
  assert.equal(l.addKeyword('a casa vendida', 'vendida').keywords.length, 1);
  assert.equal(l.addKeyword('a casa vendida', 'casa').keywords[0].word, 'casa', 'same block: replaced');
  fs.writeFileSync(file, JSON.stringify({ words: [{ from: 'a\u0000b', to: 'c' }, { from: '', to: 'x' }], keywords: [{ block: 'x y', word: 'z' }] }));
  assert.deepEqual(l.get(), { version: 1, words: [{ from: 'a b', to: 'c', n: 1 }], keywords: [] });
  assert.equal(l.remove('words', 0).words.length, 0);
  assert.deepEqual(l.clear(), { version: 1, words: [], keywords: [] });
});
