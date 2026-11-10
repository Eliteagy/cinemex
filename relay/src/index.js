// Cinemex relay: passes messages between the Cinemex of one room, and nothing else.
//
// - A room is a Durable Object named by a 64-hex-char id that each app derives from its link code.
//   The code itself never reaches this server.
// - Messages are encrypted end to end by the apps (AES-256-GCM); the relay cannot read them and
//   stores nothing: it forwards each frame to the other sockets of the room.
// - It does announce who is there (random peer ids), so each app knows when the other is online.
// - Limits: 8 sockets per room, 1 MiB per frame, about 400 frames per 10 s per socket.

const MAX_PEERS = 8;
const MAX_FRAME = 1024 * 1024;
const RATE_WINDOW = 10_000;
const RATE_MAX = 400;
const STALE = 60_000; // no ping for this long: the app is gone

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'cinemex-relay' }), { headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/l' || url.pathname === '/ligar') {
      return new Response(INVITE_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" } });
    }
    const m = url.pathname.match(/^\/room\/([0-9a-f]{64})$/);
    if (!m) return new Response('not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a websocket', { status: 426 });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
    return stub.fetch(request);
  },
};

// Invite link page: https://<relay>/l#cmx1-... Opens Cinemex (cinemex://ligar?r=<relay>#code) and,
// if the app is not registered for links (a Mac running from source), shows the link to paste in
// Ligação. The part after "#" stays in the browser.
const INVITE_PAGE = `<!doctype html><html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Convite Cinemex</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(900px 500px at 15% -10%,rgba(212,175,55,.22),transparent 60%),#070605;color:#f2f2f5;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(440px,calc(100% - 32px));padding:28px;border-radius:20px;background:rgba(22,20,17,.85);border:1px solid rgba(255,255,255,.1);box-shadow:0 30px 60px -30px #000}
h1{margin:0 0 6px;font-size:22px}p{margin:0 0 16px;color:#a8a8b3}a.btn{display:block;text-align:center;padding:12px 16px;border-radius:999px;background:linear-gradient(180deg,#e4c252,#d4af37);color:#1a1405;font-weight:600;text-decoration:none}
code{display:block;margin-top:14px;padding:10px;border-radius:10px;background:#0b0a09;border:1px solid rgba(255,255,255,.1);font-size:12px;word-break:break-all;user-select:all;color:#e4c252}small{display:block;margin-top:10px;color:#8a8a95}</style></head>
<body><main><h1>Convite para o Cinemex</h1><p>Abre este convite no Cinemex para editarem os dois ao mesmo tempo.</p>
<a class="btn" id="open" href="#">Abrir no Cinemex</a>
<small>Se não abrir sozinho: no Cinemex, carrega em <b>Ligação</b> e cola este link em "Colar link de convite".</small><code id="link"></code></main>
<script>var c=location.hash.slice(1);var ok=/^cmx1-[A-Za-z0-9_-]{43}$/.test(c);var app='cinemex://ligar?r='+encodeURIComponent(location.origin)+'#'+c;
document.getElementById('link').textContent=ok?location.href:'Link incompleto: pede outro.';
if(ok){document.getElementById('open').href=app;location.href=app;}else{document.getElementById('open').style.display='none';}</script></body></html>`;

export class Room {
  constructor(state) {
    this.state = state;
    // Apps send "ping" every 20 s; the runtime answers "pong" without waking the room.
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** Last sign of life of a socket: its last ping, else its last message, else when it joined. */
  lastSeen(ws) {
    const meta = ws.deserializeAttachment() || {};
    const ping = this.state.getWebSocketAutoResponseTimestamp(ws);
    return Math.max(ping ? ping.getTime() : 0, meta.last || 0, meta.joined || 0);
  }

  /** Closes sockets that stopped answering and tells the others they left. */
  prune() {
    const now = Date.now();
    for (const ws of this.state.getWebSockets()) {
      if (now - this.lastSeen(ws) <= STALE) continue;
      const id = ws.deserializeAttachment()?.id;
      try {
        ws.close(1001, 'gone');
      } catch {
        /* already closed */
      }
      if (id) this.broadcast(JSON.stringify({ t: 'leave', id }), ws);
    }
  }

  peers() {
    const now = Date.now();
    return this.state
      .getWebSockets()
      .filter((ws) => now - this.lastSeen(ws) <= STALE)
      .map((ws) => ws.deserializeAttachment()?.id)
      .filter(Boolean);
  }

  broadcast(text, except) {
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(text);
      } catch {
        /* closing socket */
      }
    }
  }

  async fetch() {
    this.prune();
    if (this.state.getWebSockets().length >= MAX_PEERS) return new Response('room full', { status: 429 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID();
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ id, window: Date.now(), count: 0, joined: Date.now(), last: Date.now() });
    server.send(JSON.stringify({ t: 'peers', you: id, ids: this.peers() }));
    this.broadcast(JSON.stringify({ t: 'join', id }), server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const meta = ws.deserializeAttachment() || {};
    const size = typeof message === 'string' ? message.length : message.byteLength;
    if (size > MAX_FRAME) return ws.close(1009, 'frame too large');
    const now = Date.now();
    if (now - (meta.window || 0) > RATE_WINDOW) {
      meta.window = now;
      meta.count = 0;
    }
    meta.count = (meta.count || 0) + 1;
    meta.last = now;
    ws.serializeAttachment(meta);
    if (meta.count > RATE_MAX) return ws.close(1008, 'too many messages');
    if (typeof message !== 'string') return;
    // Only encrypted frames ({"t":"m",...}) are forwarded, tagged with the sender's peer id.
    let f;
    try {
      f = JSON.parse(message);
    } catch {
      return;
    }
    if (!f || f.t !== 'm') return;
    f.from = meta.id;
    this.broadcast(JSON.stringify(f), ws);
    this.prune();
  }

  async webSocketClose(ws, code) {
    const id = ws.deserializeAttachment()?.id;
    try {
      ws.close(code === 1005 ? 1000 : code, 'bye');
    } catch {
      /* already closed */
    }
    if (id) this.broadcast(JSON.stringify({ t: 'leave', id }), ws);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws, 1011);
  }
}
