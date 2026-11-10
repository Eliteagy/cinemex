// Live link between two (or more) Cinemex: the relay connection, end-to-end encryption and the
// shared Google Drive folder.
//
// - Everyone with the same link code joins the same room on the relay (a small Cloudflare Worker,
//   see relay/). The code never leaves this computer: the room name and the AES key are both
//   derived from it (HKDF), so the relay only ever sees ciphertext and a hash.
// - Messages are JSON, gzipped, encrypted with AES-256-GCM and cut into parts below the relay's
//   message limit.
// - File paths inside the shared folder travel as "@shared/..." (src/lib/collab.js) and become this
//   computer's own paths on arrival.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const CODE_PREFIX = 'cmx1-';
const PART = 192 * 1024; // relay limit is 1 MiB per message; stay well below it
const MAX_MESSAGE = 64 * 1024 * 1024; // a whole project with transcripts and thumbnails
const SALT = Buffer.from('cinemex-relay-v1');

/** A new random link code ("cmx1-" + 32 random bytes). */
function newCode() {
  return CODE_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function validCode(code) {
  return typeof code === 'string' && /^cmx1-[A-Za-z0-9_-]{43}$/.test(code.trim());
}

/** Room id (hex, safe to show to the relay) and AES key, both from the code. */
function deriveKeys(code) {
  if (!validCode(code)) throw new Error('Código de ligação inválido');
  const ikm = Buffer.from(code.trim());
  const room = Buffer.from(crypto.hkdfSync('sha256', ikm, SALT, 'room', 32)).toString('hex');
  const key = Buffer.from(crypto.hkdfSync('sha256', ikm, SALT, 'aes-256-gcm', 32));
  return { room, key };
}

function seal(key, obj) {
  const plain = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  if (plain.length > MAX_MESSAGE) throw new Error('Mensagem grande demais para a ligação');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, body, c.getAuthTag()]);
}

function open(key, buf) {
  if (buf.length < 12 + 16) throw new Error('Mensagem cortada');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
  const json = zlib.gunzipSync(plain, { maxOutputLength: MAX_MESSAGE });
  return JSON.parse(json.toString('utf8'));
}

/** Frames (JSON strings) for one sealed message, each below the relay limit. */
function frames(sealed) {
  const id = crypto.randomBytes(8).toString('hex');
  const b64 = sealed.toString('base64');
  const n = Math.max(1, Math.ceil(b64.length / PART));
  const out = [];
  for (let i = 0; i < n; i++) out.push(JSON.stringify({ t: 'm', id, i, n, d: b64.slice(i * PART, (i + 1) * PART) }));
  return out;
}

/** Puts parts back together; returns the whole sealed buffer once all parts of a message arrived. */
function createAssembler() {
  const pending = new Map();
  return (f) => {
    if (!f || f.t !== 'm' || typeof f.id !== 'string' || typeof f.d !== 'string') return null;
    const n = Number(f.n);
    const i = Number(f.i);
    if (!Number.isInteger(n) || n < 1 || n > Math.ceil((MAX_MESSAGE * 1.4) / PART) || !Number.isInteger(i) || i < 0 || i >= n) return null;
    if (n === 1) return Buffer.from(f.d, 'base64');
    let p = pending.get(f.id);
    if (!p) {
      p = { parts: new Array(n), got: 0, at: Date.now() };
      pending.set(f.id, p);
    }
    if (p.parts[i] === undefined) {
      p.parts[i] = f.d;
      p.got++;
    }
    // Drop messages that never completed (a peer that left mid-send).
    for (const [id, x] of pending) if (Date.now() - x.at > 120000) pending.delete(id);
    if (p.got < n) return null;
    pending.delete(f.id);
    return Buffer.from(p.parts.join(''), 'base64');
  };
}

const DRIVE_NAMES = ['My Drive', 'O meu disco', 'Meu Drive', 'Mi unidad'];

/** The Google Drive folder of this computer ("My Drive"), or null when Google Drive is not installed. */
function findGoogleDrive() {
  const dirs = [];
  if (process.platform === 'win32') {
    for (const letter of 'GHIJKLMNOPQRSTUVWXYZDEF') for (const name of DRIVE_NAMES) dirs.push(`${letter}:\\${name}`);
  } else if (process.platform === 'darwin') {
    const cloud = path.join(os.homedir(), 'Library', 'CloudStorage');
    let entries = [];
    try {
      entries = fs.readdirSync(cloud).filter((d) => d.startsWith('GoogleDrive'));
    } catch {
      /* no CloudStorage folder */
    }
    for (const d of entries) for (const name of DRIVE_NAMES) dirs.push(path.join(cloud, d, name));
  }
  for (const d of dirs) {
    try {
      if (fs.statSync(d).isDirectory()) return d;
    } catch {
      /* not there */
    }
  }
  return null;
}

/** The shared folder: the one chosen in the Ligação panel, else "Cinemex" inside Google Drive. */
function sharedRoot(config) {
  if (config.sharedRoot) return config.sharedRoot;
  const drive = findGoogleDrive();
  return drive ? path.join(drive, 'Cinemex') : null;
}

/** Settings in userData/collab.json; the code in its own file, readable only by this user. */
function createStore(userData) {
  const cfgFile = path.join(userData, 'collab.json');
  const codeFile = path.join(userData, 'collab-code.txt');
  const read = () => {
    try {
      const c = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      return {
        relayUrl: typeof c.relayUrl === 'string' && c.relayUrl ? c.relayUrl : DEFAULT_RELAY,
        name: typeof c.name === 'string' ? c.name.slice(0, 40) : '',
        sharedRoot: typeof c.sharedRoot === 'string' && c.sharedRoot ? c.sharedRoot : null,
        autoConnect: c.autoConnect !== false,
      };
    } catch {
      return { relayUrl: DEFAULT_RELAY, name: '', sharedRoot: null, autoConnect: true };
    }
  };
  return {
    read,
    write(patch) {
      const next = { ...read(), ...patch };
      fs.writeFileSync(cfgFile, JSON.stringify(next, null, 2));
      return next;
    },
    code() {
      try {
        const c = fs.readFileSync(codeFile, 'utf8').trim();
        return validCode(c) ? c : null;
      } catch {
        return null;
      }
    },
    setCode(code) {
      if (code === null) return fs.rmSync(codeFile, { force: true });
      if (!validCode(code)) throw new Error('Código de ligação inválido (começa por cmx1-)');
      fs.writeFileSync(codeFile, code.trim(), { mode: 0o600 });
    },
  };
}

/**
 * The relay the apps use when none was typed in. Filled in once relay/ is published
 * (npx wrangler deploy prints it).
 */
const DEFAULT_RELAY = '';

/** The invite link for a relay and code: https://<relay>/l#<code> (the code stays after "#"). */
function inviteLink(relayUrl, code) {
  if (!validCode(code)) throw new Error('Código de ligação inválido');
  relaySocketUrl(relayUrl, '0'.repeat(64)); // https only
  return `${relayUrl.replace(/\/+$/, '')}/l#${code.trim()}`;
}

/**
 * Relay and code from an invite link: https://<relay>/l#cmx1-… (pasted or opened in the browser)
 * or cinemex://ligar?r=<relay>#cmx1-… (the browser handing it to the app).
 */
function parseInvite(link) {
  let u;
  try {
    u = new URL(String(link || '').trim());
  } catch {
    throw new Error('Isto não é um link de convite do Cinemex');
  }
  const code = decodeURIComponent(u.hash.slice(1));
  if (!validCode(code)) throw new Error('O link de convite está incompleto (falta o código depois de #)');
  let relayUrl;
  if (u.protocol === 'cinemex:') relayUrl = u.searchParams.get('r') || '';
  else if (u.protocol === 'https:' || u.protocol === 'http:') relayUrl = u.origin;
  else throw new Error('Isto não é um link de convite do Cinemex');
  relaySocketUrl(relayUrl, '0'.repeat(64)); // https only (or local while testing)
  return { relayUrl: new URL(relayUrl).origin, code };
}

/** Only https relays (or a local one while testing). */
function relaySocketUrl(relayUrl, room) {
  let u;
  try {
    u = new URL(relayUrl);
  } catch {
    throw new Error('Endereço do servidor de ligação inválido');
  }
  const local = ['127.0.0.1', 'localhost'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('O servidor de ligação tem de usar https');
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `/room/${room}`;
  u.search = '';
  return u.toString();
}

/**
 * The connection. `onMessage(msg)` gets each decrypted message, `onStatus(s)` the state
 * (off / connecting / online / error) and the peers the relay reports.
 */
function createClient({ onMessage, onStatus, WebSocketImpl = globalThis.WebSocket }) {
  let ws = null;
  let keys = null;
  let url = '';
  let stopped = true;
  let retry = 0;
  let timer = null;
  let me = null;
  let peers = [];
  const assemble = createAssembler();
  let state = { state: 'off', error: null };
  let beat = null;
  let lastHeard = 0;

  const status = (patch) => {
    state = { ...state, ...patch };
    onStatus({ ...state, me, peers: [...peers] });
  };

  function connect() {
    clearTimeout(timer);
    if (stopped) return;
    status({ state: 'connecting', error: null });
    let sock;
    try {
      sock = new WebSocketImpl(url);
    } catch (err) {
      return fail(err);
    }
    ws = sock;
    sock.onopen = () => {
      retry = 0;
      lastHeard = Date.now();
      status({ state: 'online', error: null });
      clearInterval(beat);
      beat = setInterval(() => {
        if (ws !== sock) return clearInterval(beat);
        if (Date.now() - lastHeard > 50000) {
          // No pong: the network dropped without closing; reconnect (the relay drops the old one).
          try { sock.close(4000, 'no answer'); } catch { /* closed */ }
          return;
        }
        try { sock.send('ping'); } catch { /* closing */ }
      }, 20000);
    };
    sock.onmessage = (ev) => {
      lastHeard = Date.now();
      if (ev.data === 'pong') return;
      let f;
      try {
        f = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (f.t === 'peers') {
        me = typeof f.you === 'string' ? f.you : me;
        peers = Array.isArray(f.ids) ? f.ids.filter((x) => typeof x === 'string' && x !== me) : [];
        return status({});
      }
      if (f.t === 'join' && typeof f.id === 'string' && f.id !== me) {
        if (!peers.includes(f.id)) peers.push(f.id);
        status({});
        return onMessage({ kind: 'join', peer: f.id });
      }
      if (f.t === 'leave' && typeof f.id === 'string') {
        peers = peers.filter((p) => p !== f.id);
        status({});
        return onMessage({ kind: 'leave', peer: f.id });
      }
      const whole = assemble(f);
      if (!whole) return;
      try {
        const msg = open(keys.key, whole);
        if (msg && typeof msg === 'object') onMessage({ ...msg, from: typeof f.from === 'string' ? f.from : msg.peer });
      } catch {
        /* not for us (another code) or damaged: ignored */
      }
    };
    sock.onclose = () => {
      clearInterval(beat);
      if (ws === sock) ws = null;
      peers = [];
      if (!stopped) {
        status({ state: 'connecting' });
        schedule();
      } else status({ state: 'off' });
    };
    sock.onerror = () => {
      /* onclose follows and retries */
    };
  }

  function fail(err) {
    status({ state: 'error', error: String(err && err.message ? err.message : err) });
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    if (stopped) return;
    const wait = Math.min(30000, 1000 * 2 ** retry++);
    timer = setTimeout(connect, wait);
  }

  return {
    start(relayUrl, code) {
      this.stop();
      keys = deriveKeys(code);
      url = relaySocketUrl(relayUrl, keys.room);
      stopped = false;
      retry = 0;
      connect();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      const s = ws;
      ws = null;
      peers = [];
      if (s) try { s.close(1000, 'bye'); } catch { /* already closed */ }
      status({ state: 'off', error: null });
    },
    /** Sends one message to everyone else in the room. False when not connected. */
    send(msg) {
      if (!ws || ws.readyState !== 1 || !keys) return false;
      for (const f of frames(seal(keys.key, msg))) ws.send(f);
      return true;
    },
    status: () => ({ ...state, me, peers: [...peers] }),
  };
}

module.exports = { DEFAULT_RELAY, inviteLink, parseInvite, newCode, validCode, deriveKeys, seal, open, frames, createAssembler, findGoogleDrive, sharedRoot, createStore, relaySocketUrl, createClient, PART };
