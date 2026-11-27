// Shorts from a whole folder: scan every video once, resume after a stop, one list best first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBatch } = require('../electron/batch.cjs');

test('folder scan: transcribes each video once, resumes, sorts moments, skips Cinemex shorts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lote-'));
  for (const f of ['a.mp4', 'b.mov', 'clip_01_x.mp4', 'notas.txt']) fs.writeFileSync(path.join(dir, f), f);
  const words = Array.from({ length: 30 }, (_, i) => ({ w: `w${i}`, s: i, e: i + 0.5 }));
  let transcribed = 0;
  let fail = true;
  const b = createBatch({
    transcribe: async (f) => {
      transcribed++;
      return { words };
    },
    findHotclips: async (w) => {
      if (fail) {
        fail = false;
        throw new Error('caiu a meio');
      }
      return [{ start: 1, end: 21, score: 7, title: 'T' }, { start: 3, end: 23, score: 9, title: 'U' }];
    },
    probe: async () => ({ duration: 30, width: 1920, height: 1080, fps: 25, hasAudio: true }),
  });
  await assert.rejects(b.scan(dir), /caiu a meio/);
  assert.equal(transcribed, 1, 'first video transcribed before the stop');
  const list = await b.scan(dir);
  assert.equal(transcribed, 2, 'resumed: only the second video is new');
  assert.equal(list.length, 4);
  assert.deepEqual(list.map((c) => c.score), [9, 9, 7, 7]);
  assert.deepEqual([...new Set(list.map((c) => c.name))].sort(), ['a.mp4', 'b.mov']);
  await b.scan(dir);
  assert.equal(transcribed, 2, 'nothing new');
  fs.writeFileSync(path.join(dir, 'a.mp4'), 'changed file');
  await b.scan(dir);
  assert.equal(transcribed, 3, 'a changed file is done again');
  const m = await b.mediaFor(dir, path.join(dir, 'b.mov'));
  assert.equal(m.transcript.length, 30);
  assert.equal(m.width, 1920);
  await assert.rejects(createBatch({}).scan(fs.mkdtempSync(path.join(os.tmpdir(), 'vazia-'))), /não tem vídeos/);
});
