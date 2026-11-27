// Automatic B-roll: planning, matching the folder, splitting the main clip around the cut-aways.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tokens, brollPrompt, parseInserts, matchLibrary, splitAround } from '../src/lib/broll.js';

const require = createRequire(import.meta.url);

test('inserts: after the hook, inside the clip, 1.2-2.5 s, no overlaps', () => {
  const json = { inserts: [{ at: 1, pt: 'casa' }, { at: 12, len: 4, pt: 'carro de luxo', en: 'luxury car' }, { at: 13, pt: 'praia' }, { at: 20, len: 2, pt: 'Maldivas', en: 'maldives beach' }, { at: 39, pt: 'fim' }, { at: 25, pt: '' }] };
  assert.deepEqual(parseInserts(json, { from: 0, to: 40 }).map((x) => [x.at, x.len]), [[12, 2.5], [20, 2]]);
  assert.match(brollPrompt('[12] carro', { library: ['carros/porsche.mp4 (carro desportivo)'] }), /porsche/);
});

test('folder match by shared words (accents ignored), used clips less likely', () => {
  const lib = [{ path: 'a', name: 'carros/Porsche na estrada.mp4', desc: 'carro desportivo' }, { path: 'b', name: 'praia maldivas.mov', desc: '' }, { path: 'c', name: 'escritório.mp4', desc: 'pessoas a trabalhar' }];
  assert.equal(matchLibrary({ pt: 'carro de luxo', en: 'luxury car' }, lib).path, 'a');
  assert.equal(matchLibrary({ pt: 'férias nas Maldivas', en: '' }, lib).path, 'b');
  assert.equal(matchLibrary({ pt: 'avião', en: 'plane' }, lib), null);
  assert.deepEqual(tokens('Escritório_de-Lisboa.MP4'), ['escritorio', 'lisboa']);
});

test('main clip split around B-roll: pieces keep time, lose the person mask under the B-roll', () => {
  const clip = { id: 'v', start: 0, in: 10, out: 30, speed: 1, masks: [{ mode: 'front' }, { mode: 'blur' }], keyframes: { zoom: [{ t: 5, v: 1.1 }] } };
  const p = splitAround(clip, [{ start: 4, end: 6 }, { start: 12, end: 14 }]);
  assert.deepEqual(p.map((x) => [x.start, x.in, x.out]), [[0, 10, 14], [4, 14, 16], [6, 16, 22], [12, 22, 24], [14, 24, 30]]);
  assert.deepEqual(p.map((x) => x.masks.length), [2, 1, 2, 1, 2]);
  assert.equal(p[1].keyframes.zoom[0].t, 1, 'keyframes move with the piece');
  assert.ok(p.every((x) => x.id === undefined));
});

test('short project with B-roll: own track, V1 split when the person is cut out', () => {
  const { shortProject } = require('../electron/shorts.cjs');
  const ws = Array.from({ length: 60 }, (_, i) => ({ w: `w${i}`, s: 10 + i * 0.4, e: 10 + i * 0.4 + 0.3 }));
  const c = { start: 10, end: 34, duration: 24, hook: 'Gancho' };
  const brolls = [{ at: 8, len: 2, path: 'C:/b/carro.mp4', name: 'carro', duration: 6, width: 1080, height: 1920 }];
  const p = shortProject({ path: 'C:/x/v.mp4', duration: 60, width: 1920, height: 1080, transcript: ws }, c, { layout: 'atras', personMatte: 'C:/m.mp4', brolls });
  const br = p.tracks.find((t) => t.id === 'br');
  assert.deepEqual(br.clips.map((x) => [x.start, x.out - x.in, x.volume]), [[8, 2, 0]]);
  assert.equal(p.tracks.findIndex((t) => t.id === 'br'), 1, 'right above V1');
  const v1 = p.tracks[0].clips;
  assert.equal(v1.length, 3);
  assert.equal(v1[1].masks.length, 0);
  assert.ok(p.media.some((m) => m.path === 'C:/b/carro.mp4' && m.hasAudio === false));
});

test('broll source: folder index by name when Gemini is not there; Pexels portrait file downloaded once', async () => {
  const { createBroll } = require('../electron/broll.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brs-'));
  const calls = [];
  const fetchFn = async (u, o) => {
    calls.push(u);
    if (String(u).includes('api.pexels.com')) {
      assert.equal(o.headers.authorization, 'k');
      return { ok: true, json: async () => ({ videos: [{ id: 7, duration: 9, user: { name: 'Ana' }, video_files: [{ file_type: 'video/mp4', link: 'https://v/land.mp4', width: 1920, height: 1080 }, { file_type: 'video/mp4', link: 'https://v/port.mp4', width: 1080, height: 1920 }] }] }) };
    }
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  const b = createBroll({ folder: path.join(root, 'B'), cacheDir: path.join(root, 'c'), keyFile: path.join(root, 'k.txt'), env: {}, fetchFn, describe: async () => '' });
  assert.deepEqual(await b.library(), []);
  assert.equal(b.hasPexels(), false);
  assert.equal(await b.pexels('car'), null);
  fs.writeFileSync(path.join(root, 'k.txt'), 'k\n');
  const v = await b.pexels('luxury car');
  assert.equal(v.source, 'pexels');
  assert.equal(calls[1], 'https://v/port.mp4', 'portrait file');
  assert.equal(v.credit, 'Ana / Pexels');
  await b.pexels('luxury car');
  assert.equal(calls.filter((u) => u === 'https://v/port.mp4').length, 1, 'downloaded once');
});
