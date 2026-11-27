// Background music: the Gui's folder by mood, ElevenLabs once per mood, clips that cover a short.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { musicClips, moodFromText } from '../src/lib/polish.js';

const require = createRequire(import.meta.url);
const { createMusic, moodOf } = require('../electron/music.cjs');
const { FFMPEG } = require('../electron/bin.cjs');

const tone = (file, secs) => spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `sine=f=220:d=${secs}`, '-y', file]);

test('mood from names and from what is said', () => {
  assert.equal(moodOf('lofi/Sunset piano.mp3'), 'calma');
  assert.equal(moodOf('EPIC trailer.wav'), 'forte');
  assert.equal(moodOf('track01.mp3'), null);
  assert.equal(moodFromText('nunca vais ganhar dinheiro se tens medo agora!'), 'forte');
  assert.equal(moodFromText('a casa da família, o vosso sonho'), 'calma');
});

test('music clips repeat a short track and fade out at the end', () => {
  const c = musicClips({ duration: 20 }, 45, { mediaId: 'm' });
  assert.deepEqual(c.map((x) => [x.start, x.out]), [[0, 20], [20, 20], [40, 5]]);
  assert.equal(c[2].transitionOut.type, 'fade');
  assert.equal(musicClips({ duration: 120 }, 30).length, 1);
});

test('library: folder tracks by mood, stable pick, ElevenLabs only when nothing fits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mus-'));
  const folder = path.join(root, 'Cinemex');
  fs.mkdirSync(path.join(folder, 'calma'), { recursive: true });
  tone(path.join(folder, 'calma', 'a.wav'), 2);
  tone(path.join(folder, 'calma', 'b.wav'), 3);
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    return { ok: false, status: 402, text: async () => 'paid_plan_required' };
  };
  const lib = createMusic({ folder, cacheDir: path.join(root, 'cache'), env: { ELEVENLABS_API_KEY: 'x' }, fetchFn });
  const a = await lib.pick('calma', { seed: 'short-1' });
  const b = await lib.pick('calma', { seed: 'short-1' });
  assert.equal(a.path, b.path, 'same short, same track');
  assert.equal(a.mood, 'calma');
  assert.ok(a.duration > 1.5);
  const f = await lib.pick('forte');
  assert.equal(f.mood, 'calma', 'no forte track and no ElevenLabs: a folder track anyway');
  assert.equal(calls, 1);
  const empty = createMusic({ folder: path.join(root, 'vazia'), cacheDir: path.join(root, 'c2'), env: { ELEVENLABS_API_KEY: 'x' }, fetchFn });
  await assert.rejects(empty.pick('forte'), /Música\\Cinemex.*planos pagos/);
  assert.equal(await empty.pick('forte', { generate: false }), null);
});
