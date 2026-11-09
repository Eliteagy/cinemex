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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'cinemex-relay' }), { headers: { 'content-type': 'application/json' } });
    }
    const m = url.pathname.match(/^\/room\/([0-9a-f]{64})$/);
    if (!m) return new Response('not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a websocket', { status: 426 });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
    return stub.fetch(request);
  },
};

export class Room {
  constructor(state) {
    this.state = state;
  }

  peers() {
    return this.state.getWebSockets().map((ws) => ws.deserializeAttachment()?.id).filter(Boolean);
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
    if (this.state.getWebSockets().length >= MAX_PEERS) return new Response('room full', { status: 429 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID();
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ id, window: Date.now(), count: 0 });
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
