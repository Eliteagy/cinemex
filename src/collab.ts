// Ligação: the editor side of the live link (the connection itself lives in electron/collab.cjs).
//
// - Hello: each Cinemex tells the others its name, system, version and the shared project it has open.
// - Session: "Partilhar" sends the open project to the others; "Entrar" asks for it and opens it.
//   From then on every change is sent as a small op (src/lib/collab.js) and applied on arrival.
// - Presence: playhead, selected clip and page, drawn on the timeline in the other person's colour.
import { create } from 'zustand';
import { useEditor } from './store';
import { applyOp, diffProject } from './lib/collab';
import type { CollabIn, CollabStatus, CollabView, PeerHello, PeerPresence, Project, UpdateInfo } from './types';

export interface Peer {
  id: string;
  hello: PeerHello | null;
  presence: PeerPresence | null;
  seen: number;
}

export interface Invite {
  from: string;
  session: string;
  name: string;
}

interface CollabState {
  ready: boolean;
  open: boolean;
  view: CollabView | null;
  status: CollabStatus;
  peers: Record<string, Peer>;
  session: { id: string; name: string } | null;
  joining: string | null;
  invite: Invite | null;
  update: UpdateInfo | null;
  updating: string | null;
  error: string | null;
  setOpen(v: boolean): void;
  refresh(): Promise<void>;
}

const OFF: CollabStatus = { state: 'off', error: null, me: null, peers: [] };

export const useCollab = create<CollabState>((set) => ({
  ready: false,
  open: false,
  view: null,
  status: OFF,
  peers: {},
  session: null,
  joining: null,
  invite: null,
  update: null,
  updating: null,
  error: null,
  setOpen(open) {
    set({ open });
  },
  async refresh() {
    set({ view: await window.ec.collabGet() });
  },
}));

const S = () => useCollab.getState();
const E = () => useEditor.getState();
const ec = () => window.ec;

/** The version this computer runs (short commit), sent in hello. */
const version = () => {
  const u = S().update;
  return u && u.git ? (u.local?.hash ?? null) : null;
};

function myName() {
  const v = S().view;
  return v?.config.name || v?.defaultName || 'Cinemex';
}

function hello(reply = false) {
  const v = S().view;
  void ec().collabSend({ kind: 'hello', reply, name: myName(), os: v?.os ?? '', version: version(), session: S().session });
}

// ------------------------------------------------------------------ sending changes
let lastSynced: Project | null = null;
let applying = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  timer = null;
  const s = S().session;
  if (!s || !lastSynced) return;
  const now = E().project;
  const op = diffProject(lastSynced, now);
  if (!op) return;
  lastSynced = now;
  void ec().collabSend({ kind: 'op', session: s.id, op });
}

function schedule() {
  if (timer) return;
  timer = setTimeout(flush, 120);
}

// ------------------------------------------------------------------ presence
let presenceTimer: ReturnType<typeof setTimeout> | null = null;
let lastPresence = '';
function sendPresence() {
  presenceTimer = null;
  const e = E();
  const p: PeerPresence = { session: S().session?.id ?? null, playhead: Math.round(e.playhead * 100) / 100, selected: e.selected, page: e.page, playing: e.playing };
  const key = JSON.stringify(p);
  if (key === lastPresence) return;
  lastPresence = key;
  void ec().collabSend({ kind: 'presence', ...p });
}
function schedulePresence() {
  if (presenceTimer || S().status.state !== 'online') return;
  presenceTimer = setTimeout(sendPresence, 80);
}

// ------------------------------------------------------------------ sessions
const newId = () => crypto.randomUUID();

/** Shares the open project with everyone connected: they get an invite to join. */
export function shareProject() {
  const project = E().project;
  const session = { id: newId(), name: project.name };
  lastSynced = project;
  useCollab.setState({ session, invite: null, joining: null });
  void ec().collabSend({ kind: 'snapshot', session: session.id, name: project.name, project });
  hello();
}

/** Asks for the shared project and opens it when it arrives (replaces the open one). */
export function joinInvite() {
  const inv = S().invite;
  if (!inv) return;
  useCollab.setState({ joining: inv.session, invite: null });
  void ec().collabSend({ kind: 'want', session: inv.session });
}

/** Stops sending and receiving changes; the project stays open here. */
export function leaveSession() {
  const s = S().session;
  if (s) void ec().collabSend({ kind: 'stop', session: s.id });
  lastSynced = null;
  useCollab.setState({ session: null, joining: null });
  hello();
}

function applyRemote(next: Project) {
  applying = true;
  try {
    useEditor.setState({ project: next, dirty: true });
  } finally {
    applying = false;
  }
}

function onMessage(m: CollabIn) {
  const st = S();
  const from = m.from ?? ('peer' in m ? m.peer : '');
  const touch = (patch: Partial<Peer>) =>
    useCollab.setState((s) => ({ peers: { ...s.peers, [from]: { id: from, hello: null, presence: null, ...s.peers[from], ...patch, seen: Date.now() } } }));

  switch (m.kind) {
    case 'join':
      touch({});
      hello();
      return;
    case 'leave':
      useCollab.setState((s) => {
        const peers = { ...s.peers };
        delete peers[m.peer];
        return { peers, invite: s.invite?.from === m.peer ? null : s.invite };
      });
      return;
    case 'hello': {
      const h: PeerHello = { name: String(m.name || '').slice(0, 40), os: String(m.os || ''), version: m.version ?? null, session: m.session ?? null };
      touch({ hello: h });
      // The same person reconnected (new id): drop the old entry that never said goodbye.
      useCollab.setState((s) => {
        const old = Object.values(s.peers).filter((p) => p.id !== from && p.hello && p.hello.name === h.name && p.hello.os === h.os);
        if (!old.length) return s;
        const peers = { ...s.peers };
        for (const p of old) delete peers[p.id];
        return { peers };
      });
      if (!m.reply) hello(true);
      // Someone already has a shared project open: offer to join it.
      if (h.session && !st.session && st.joining !== h.session.id && st.invite?.session !== h.session.id) useCollab.setState({ invite: { from, session: h.session.id, name: h.session.name } });
      return;
    }
    case 'presence':
      touch({ presence: { session: m.session, playhead: Number(m.playhead) || 0, selected: m.selected ?? null, page: m.page, playing: Boolean(m.playing) } });
      return;
    case 'want':
      // Someone wants the shared project: whoever is in it sends it.
      if (st.session?.id === m.session) void ec().collabSend({ kind: 'snapshot', session: st.session.id, name: st.session.name, project: E().project, to: from });
      return;
    case 'snapshot': {
      if (m.to && m.to !== st.status.me) return;
      if (st.joining === m.session) {
        // Joining: open the shared project (replaces the one open here).
        lastSynced = m.project;
        E().load(m.project, null);
        useEditor.setState({ dirty: true });
        useCollab.setState({ session: { id: m.session, name: m.name }, joining: null, invite: null });
        hello();
      } else if (!st.session && !m.to) useCollab.setState({ invite: { from, session: m.session, name: m.name } });
      return;
    }
    case 'op': {
      if (st.session?.id !== m.session || !lastSynced) return;
      try {
        lastSynced = applyOp(lastSynced, m.op);
        applyRemote(applyOp(E().project, m.op));
      } catch (err) {
        useCollab.setState({ error: String((err as Error).message ?? err) });
      }
      return;
    }
    case 'stop':
      return;
  }
}

/** Starts the Ligação once, when the editor opens. */
export function initCollab() {
  if (S().ready || !window.ec?.collabGet) return;
  useCollab.setState({ ready: true });
  void S().refresh();
  ec().onCollabStatus((status) => {
    const wasOnline = S().status.state === 'online';
    useCollab.setState((s) => {
      // Peers the relay no longer lists are gone.
      const peers = Object.fromEntries(Object.entries(s.peers).filter(([id]) => status.peers.includes(id)));
      for (const id of status.peers) peers[id] ??= { id, hello: null, presence: null, seen: Date.now() };
      if (status.state !== 'online') return { status, peers: {} };
      return { status, peers };
    });
    if (status.state === 'online' && !wasOnline) hello();
  });
  ec().onCollabMessage(onMessage);
  // An invite link opened from the browser: show the panel.
  ec().onCollabOpen(() => {
    useCollab.setState({ open: true });
    void S().refresh();
  });
  // Local edits go out while a project is shared; changes that came in are not sent back.
  useEditor.subscribe((s, prev) => {
    if (s.project !== prev.project && !applying && S().session) schedule();
    if (s.playhead !== prev.playhead || s.selected !== prev.selected || s.page !== prev.page || s.playing !== prev.playing) schedulePresence();
  });
  void checkUpdate();
  setInterval(() => void checkUpdate(), 15 * 60 * 1000);
  // Heartbeat: presence every 15 s even when nothing moved, so the other side knows we are here.
  setInterval(() => {
    if (S().status.state !== 'online') return;
    lastPresence = '';
    sendPresence();
  }, 15000);
  setInterval(() => {
    const now = Date.now();
    useCollab.setState((s) => {
      const alive = Object.values(s.peers).filter((p) => now - p.seen < 60000);
      if (alive.length === Object.keys(s.peers).length) return s;
      return { peers: Object.fromEntries(alive.map((p) => [p.id, p])) };
    });
  }, 10000);
}

export async function checkUpdate(fetch = true) {
  try {
    useCollab.setState({ update: await ec().updateInfo({ fetch }) });
  } catch (err) {
    useCollab.setState({ error: String((err as Error).message ?? err) });
  }
}

export async function applyUpdate() {
  const off = ec().onUpdateStep((step) => useCollab.setState({ updating: step }));
  try {
    useCollab.setState({ updating: 'A começar…', error: null });
    const r = await ec().updateApply();
    if (!r.changed) {
      useCollab.setState({ updating: null });
      await checkUpdate(false);
      return;
    }
    useCollab.setState({ updating: 'Pronto. A reabrir o Cinemex…' });
    if (E().dirty && E().filePath) await window.ec.saveProject(E().project, E().filePath);
    await ec().relaunch();
  } catch (err) {
    useCollab.setState({ updating: null, error: String((err as Error).message ?? err) });
  } finally {
    off();
  }
}

/** Colour of a peer (stable per id): used for their playhead and selection. */
export function peerColor(id: string) {
  const palette = ['#64d2ff', '#ff9f0a', '#bf5af2', '#30d158', '#ff375f'];
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length]!;
}
