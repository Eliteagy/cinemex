// Live link: project diffs, applying them on the other computer, shared-folder paths, and the
// encrypted frames the relay carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { diffProject, applyOp, mapPaths, toShared, fromShared, SHARED } from '../src/lib/collab.js';

const require = createRequire(import.meta.url);
const { newCode, validCode, deriveKeys, seal, open, frames, createAssembler, relaySocketUrl, createClient, PART } = require('../electron/collab.cjs');

const base = () => ({
  version: 1,
  name: 'Vlog',
  canvas: { w: 1080, h: 1920, fps: 30 },
  media: [
    { id: 'm1', path: 'G:\\My Drive\\Cinemex\\vlog\\a.mp4', name: 'a.mp4', kind: 'video', duration: 10, width: 1920, height: 1080, fps: 30, hasAudio: true },
    { id: 'm2', path: 'D:\\outros\\musica.mp3', name: 'musica.mp3', kind: 'audio', duration: 60, width: 0, height: 0, fps: 0, hasAudio: true },
  ],
  tracks: [
    { id: 'v1', kind: 'video', name: 'V1', clips: [{ id: 'c1', mediaId: 'm1', start: 0, in: 0, out: 4 }, { id: 'c2', mediaId: 'm1', start: 4, in: 5, out: 8, color: { lut: 'G:\\My Drive\\Cinemex\\luts\\film.cube' } }] },
    { id: 'a1', kind: 'audio', name: 'Música', clips: [{ id: 'c3', mediaId: 'm2', start: 0, in: 0, out: 8 }] },
  ],
});
const clone = (v) => JSON.parse(JSON.stringify(v));

test('no change, no op', () => {
  assert.equal(diffProject(base(), base()), null);
});

test('an edit made on one computer gives the same project on the other', () => {
  const a = base();
  const b = clone(a);
  b.name = 'Vlog final';
  b.tracks[0].clips[1].out = 7;
  b.tracks[0].clips.push({ id: 'c4', mediaId: 'm1', start: 7, in: 0, out: 1 });
  b.tracks[1].clips = [];
  b.tracks[1].muted = true;
  b.media = b.media.filter((m) => m.id !== 'm2');
  const op = diffProject(a, b);
  assert.ok(op);
  assert.deepEqual(applyOp(a, op), b);
  // Only what changed travels.
  assert.deepEqual(op.clips.v1.up.map((c) => c.id), ['c2', 'c4']);
  assert.deepEqual(op.media.del, ['m2']);
  assert.equal(op.media.up.length, 0);
});

test('a clip moved to another track leaves the first one', () => {
  const a = base();
  const b = clone(a);
  const [c] = b.tracks[0].clips.splice(0, 1);
  b.tracks[1].clips.push(c);
  const after = applyOp(a, diffProject(a, b));
  assert.deepEqual(after.tracks[0].clips.map((x) => x.id), ['c2']);
  assert.deepEqual(after.tracks[1].clips.map((x) => x.id), ['c3', 'c1']);
});

test('two people editing different clips at once both keep their change', () => {
  const start = base();
  const gui = clone(start);
  gui.tracks[0].clips[0].out = 3;
  const ahlec = clone(start);
  ahlec.tracks[1].clips[0].volume = 0.2;
  const opGui = diffProject(start, gui);
  const opAhlec = diffProject(start, ahlec);
  // Each computer applies the other's change on top of its own.
  const onGui = applyOp(gui, opAhlec);
  const onAhlec = applyOp(ahlec, opGui);
  assert.deepEqual(onGui, onAhlec);
  assert.equal(onGui.tracks[0].clips[0].out, 3);
  assert.equal(onGui.tracks[1].clips[0].volume, 0.2);
});

test('a track change keeps its clips; removed fields are removed', () => {
  const a = base();
  a.audio = { duck: true };
  const b = clone(a);
  b.tracks[0].name = 'Principal';
  delete b.audio;
  const after = applyOp(a, diffProject(a, b));
  assert.equal(after.tracks[0].name, 'Principal');
  assert.equal(after.tracks[0].clips.length, 2);
  assert.equal(after.audio, undefined);
});

test('an op from another version is refused', () => {
  assert.throws(() => applyOp(base(), { v: 99 }), /versão/);
});

test('shared-folder paths: Windows in, Mac out, and back', () => {
  const win = 'G:\\My Drive\\Cinemex';
  const mac = '/Users/ahlec/Library/CloudStorage/GoogleDrive-a@b.com/My Drive/Cinemex';
  assert.equal(toShared('g:\\my drive\\cinemex\\vlog\\a.mp4', win), `${SHARED}vlog/a.mp4`);
  assert.equal(toShared('D:\\outros\\musica.mp3', win), 'D:\\outros\\musica.mp3');
  assert.equal(toShared('G:\\My Drive\\CinemexOutro\\x.mp4', win), 'G:\\My Drive\\CinemexOutro\\x.mp4');
  assert.equal(fromShared(`${SHARED}vlog/a.mp4`, mac), `${mac}/vlog/a.mp4`);
  assert.equal(fromShared(`${SHARED}vlog/a.mp4`, win, '\\'), 'G:\\My Drive\\Cinemex\\vlog\\a.mp4');
  // A Mac path is compared with case; ".." never escapes the folder.
  assert.equal(toShared(`${mac}/../segredo.txt`, mac), `${mac}/../segredo.txt`);
  assert.equal(fromShared(`${SHARED}../segredo.txt`, mac), `${SHARED}../segredo.txt`);
  assert.equal(fromShared(`${SHARED}x.mp4`, null), `${SHARED}x.mp4`);
});

test('mapPaths turns media and LUT paths of a project and of an op', () => {
  const root = 'G:\\My Drive\\Cinemex';
  const p = mapPaths(base(), (f) => toShared(f, root));
  assert.equal(p.media[0].path, `${SHARED}vlog/a.mp4`);
  assert.equal(p.media[1].path, 'D:\\outros\\musica.mp3');
  assert.equal(p.tracks[0].clips[1].color.lut, `${SHARED}luts/film.cube`);
  const a = base();
  const b = clone(a);
  b.tracks[0].clips[1].out = 6;
  const op = mapPaths(diffProject(a, b), (f) => toShared(f, root));
  assert.equal(op.clips.v1.up[0].color.lut, `${SHARED}luts/film.cube`);
});

test('link code: both computers get the same room and key; the room is not the code', () => {
  const code = newCode();
  assert.ok(validCode(code));
  assert.ok(!validCode('cmx1-curto'));
  const a = deriveKeys(code);
  const b = deriveKeys(`  ${code} `);
  assert.equal(a.room, b.room);
  assert.ok(a.key.equals(b.key));
  assert.match(a.room, /^[0-9a-f]{64}$/);
  assert.ok(!a.room.includes(code.slice(5, 15)));
  assert.notEqual(deriveKeys(newCode()).room, a.room);
});

test('encrypted messages: same code opens them, another code or a changed byte does not', () => {
  const { key } = deriveKeys(newCode());
  const msg = { kind: 'op', op: { v: 1, set: { name: 'olá' } } };
  assert.deepEqual(open(key, seal(key, msg)), msg);
  assert.throws(() => open(deriveKeys(newCode()).key, seal(key, msg)));
  const s = seal(key, msg);
  s[20] ^= 1;
  assert.throws(() => open(key, s));
});

test('a big project is cut in parts and put back together, in any order', () => {
  const { key } = deriveKeys(newCode());
  const big = { kind: 'snapshot', project: { ...base(), media: base().media.map((m) => ({ ...m, thumb: require('node:crypto').randomBytes(300_000).toString('base64') })) } };
  const parts = frames(seal(key, big)).map((f) => JSON.parse(f));
  assert.ok(parts.length > 2);
  assert.ok(parts.every((p) => p.d.length <= PART));
  const put = createAssembler();
  let whole = null;
  for (const p of [...parts].reverse()) whole = put(p) ?? whole;
  assert.deepEqual(open(key, whole), big);
});

test('the relay address must be https (or local while testing)', () => {
  const room = 'a'.repeat(64);
  assert.equal(relaySocketUrl('https://cinemex-relay.x.workers.dev', room), `wss://cinemex-relay.x.workers.dev/room/${room}`);
  assert.equal(relaySocketUrl('http://127.0.0.1:8787/', room), `ws://127.0.0.1:8787/room/${room}`);
  assert.throws(() => relaySocketUrl('http://exemplo.com', room), /https/);
  assert.throws(() => relaySocketUrl('nada', room), /inválido/);
});

test('client: two apps with the same code exchange messages through a relay', async () => {
  // A tiny in-memory relay with the same frames as relay/src/index.js.
  const sockets = new Set();
  let n = 0;
  class FakeWS {
    constructor() {
      this.readyState = 0;
      this.id = `p${++n}`;
      queueMicrotask(() => {
        this.readyState = 1;
        sockets.add(this);
        this.onopen?.();
        this.onmessage?.({ data: JSON.stringify({ t: 'peers', you: this.id, ids: [...sockets].map((s) => s.id) }) });
        for (const s of sockets) if (s !== this) s.onmessage?.({ data: JSON.stringify({ t: 'join', id: this.id }) });
      });
    }
    send(text) {
      const f = JSON.parse(text);
      f.from = this.id;
      for (const s of sockets) if (s !== this) s.onmessage?.({ data: JSON.stringify(f) });
    }
    close() {
      sockets.delete(this);
      this.readyState = 3;
      this.onclose?.();
    }
  }
  const code = newCode();
  const got = [];
  const statuses = [];
  const gui = createClient({ onMessage: () => {}, onStatus: (s) => statuses.push(s), WebSocketImpl: FakeWS });
  const ahlec = createClient({ onMessage: (m) => got.push(m), onStatus: () => {}, WebSocketImpl: FakeWS });
  gui.start('https://relay.test', code);
  ahlec.start('https://relay.test', code);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(gui.status().state, 'online');
  assert.equal(gui.status().peers.length, 1);
  assert.ok(gui.send({ kind: 'presence', playhead: 3.5 }));
  await new Promise((r) => setTimeout(r, 10));
  const presence = got.find((m) => m.kind === 'presence');
  assert.equal(presence.playhead, 3.5);
  assert.equal(presence.from, gui.status().me);
  gui.stop();
  ahlec.stop();
  assert.equal(gui.status().state, 'off');
});

test('invite link: one link carries the relay and the code; bad links are refused', async () => {
  const { inviteLink, parseInvite } = require('../electron/collab.cjs');
  const code = newCode();
  const link = inviteLink('https://cinemex-relay.x.workers.dev/', code);
  assert.equal(link, `https://cinemex-relay.x.workers.dev/l#${code}`);
  assert.deepEqual(parseInvite(link), { relayUrl: 'https://cinemex-relay.x.workers.dev', code });
  assert.deepEqual(parseInvite(`  ${link}  `), { relayUrl: 'https://cinemex-relay.x.workers.dev', code });
  // What the invite page hands to the app.
  assert.deepEqual(parseInvite(`cinemex://ligar?r=${encodeURIComponent('https://cinemex-relay.x.workers.dev')}#${code}`), { relayUrl: 'https://cinemex-relay.x.workers.dev', code });
  assert.throws(() => parseInvite(`http://outro.com/l#${code}`), /https/);
  assert.throws(() => parseInvite('https://cinemex-relay.x.workers.dev/l#cmx1-curto'), /incompleto/);
  assert.throws(() => parseInvite(`javascript:alert(1)#${code}`), /não é um link/);
  assert.throws(() => parseInvite('olá'), /não é um link/);
  assert.throws(() => inviteLink('http://x.com', code), /https/);
});
