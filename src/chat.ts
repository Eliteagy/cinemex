// Claude chat panel state. The conversation runs in the main process (local Claude Code CLI);
// this store only keeps what the panel shows, one message list per project.
import { create } from 'zustand';
import type { ClaudeEvent } from './types';
import { useEditor } from './store';

export interface ToolChip {
  id: string;
  tool: string;
  area: string;
  ok?: boolean;
}
export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tools: ToolChip[];
  error?: string;
  code?: string;
  pending?: boolean;
}

interface ChatState {
  open: boolean;
  threads: Record<string, ChatMsg[]>;
  running: boolean;
  runKey: string | null;
  startedAt: number;
  model: string;
  mcp: string;
  installed: boolean | null;
  lastMessageId: string | null;
  toggle(force?: boolean): void;
  send(text: string): Promise<void>;
  cancel(): void;
  reset(): void;
  onEvent(ev: ClaudeEvent): void;
  checkStatus(): Promise<void>;
}

/** One conversation per project: its file, or its name while unsaved. */
export const projectKey = () => {
  const s = useEditor.getState();
  return s.filePath || `sem-ficheiro:${s.project.name}`;
};

let seq = 0;
const mid = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

export const useChat = create<ChatState>((set, get) => {
  /** Update the assistant message of the running turn. */
  const patchRun = (fn: (m: ChatMsg) => ChatMsg) => {
    const key = get().runKey;
    if (!key) return;
    set((s) => {
      const list = s.threads[key] ?? [];
      const i = list.length - 1;
      if (i < 0 || list[i]!.role !== 'assistant') return s;
      const next = list.slice();
      next[i] = fn(list[i]!);
      return { threads: { ...s.threads, [key]: next } };
    });
  };

  return {
    open: false,
    threads: {},
    running: false,
    runKey: null,
    startedAt: 0,
    model: '',
    mcp: '',
    installed: null,
    lastMessageId: null,
    toggle(force) {
      const open = force ?? !get().open;
      set({ open });
      if (open && get().installed === null) void get().checkStatus();
    },
    async checkStatus() {
      try {
        const st = await window.ec.claudeStatus();
        set({ installed: st.installed });
      } catch {
        set({ installed: false });
      }
    },
    async send(raw) {
      const text = raw.trim();
      if (!text || get().running) return;
      const key = projectKey();
      const user: ChatMsg = { id: mid(), role: 'user', text, tools: [] };
      const bot: ChatMsg = { id: mid(), role: 'assistant', text: '', tools: [], pending: true };
      set((s) => ({ threads: { ...s.threads, [key]: [...(s.threads[key] ?? []), user, bot] }, running: true, runKey: key, startedAt: Date.now(), lastMessageId: null }));
      try {
        await window.ec.claudeSend(key, text);
      } catch (e) {
        patchRun((m) => ({ ...m, pending: false, error: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e) }));
        set({ running: false });
      }
    },
    cancel() {
      void window.ec.claudeCancel();
    },
    reset() {
      const key = projectKey();
      if (get().running) void window.ec.claudeCancel();
      void window.ec.claudeReset(key);
      set((s) => ({ threads: { ...s.threads, [key]: [] }, running: false }));
    },
    onEvent(ev) {
      switch (ev.type) {
        case 'init':
          set({ model: ev.model, mcp: ev.mcp });
          break;
        case 'text': {
          const sep = get().lastMessageId && ev.messageId && ev.messageId !== get().lastMessageId;
          set({ lastMessageId: ev.messageId });
          patchRun((m) => ({ ...m, text: m.text + (sep && m.text && !m.text.endsWith('\n') ? '\n\n' : '') + ev.delta }));
          break;
        }
        case 'tool':
          patchRun((m) => (m.tools.some((t) => t.id === ev.id) ? m : { ...m, tools: [...m.tools, { id: ev.id, tool: ev.tool, area: ev.area }] }));
          break;
        case 'tool_result':
          patchRun((m) => ({ ...m, tools: m.tools.map((t) => (t.id === ev.id ? { ...t, ok: ev.ok } : t)) }));
          break;
        case 'done':
          patchRun((m) => ({
            ...m,
            pending: false,
            text: ev.ok && !m.text && ev.text ? ev.text : m.text,
            ...(ev.ok ? {} : { error: ev.error || 'Falhou', code: ev.code }),
          }));
          if (ev.code === 'missing') set({ installed: false });
          break;
        case 'exit':
          patchRun((m) => ({ ...m, pending: false }));
          set({ running: false });
          break;
      }
    },
  };
});
