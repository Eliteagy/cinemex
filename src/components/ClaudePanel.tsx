import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { projectKey, useChat, type ChatMsg } from '../chat';
import { useEditor } from '../store';
import { Icon } from './Icon';

const SUGGESTIONS = ['Põe legendas no estilo Felipe', 'Mete música emotiva baixinha', 'Corta as pausas', 'Exporta em 9:16'];
const EMPTY: ChatMsg[] = [];

/** "claude-opus-5-5" → "Opus 5.5" */
export function modelName(id: string) {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/i.exec(id);
  if (!m) return id;
  return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
}

// ------------------------------------------------------------------ markdown-lite (no HTML injection)
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let last = 0;
  let i = 0;
  for (let m; (m = re.exec(text)); ) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    out.push(t.startsWith('**') ? <strong key={`${key}b${i++}`}>{t.slice(2, -2)}</strong> : <code key={`${key}c${i++}`}>{t.slice(1, -1)}</code>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, '').split('\n');
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push(<p key={`p${blocks.length}`}>{para.map((l, i) => <Fragment key={i}>{i > 0 && <br />}{inline(l, `p${blocks.length}-${i}`)}</Fragment>)}</p>);
    para = [];
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map((it, i) => <li key={i}>{inline(it, `l${blocks.length}-${i}`)}</li>);
      blocks.push(list.ordered ? <ol key={`o${blocks.length}`}>{items}</ol> : <ul key={`u${blocks.length}`}>{items}</ul>);
    }
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('```')) {
      flushPara();
      flushList();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith('```'); i++) code.push(lines[i]!);
      blocks.push(<pre key={`c${blocks.length}`}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const li = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const ordered = Boolean(li[2]);
      if (list && list.ordered !== ordered) flushList();
      (list ??= { ordered, items: [] }).items.push(li[3]!);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    flushList();
    para.push(line.replace(/^#{1,4}\s+/, ''));
  }
  flushPara();
  flushList();
  return <>{blocks}</>;
}

// ------------------------------------------------------------------ pieces
function Bubble({ m }: { m: ChatMsg }) {
  if (m.role === 'user') return <div className="cl-msg user"><div className="cl-bubble">{m.text}</div></div>;
  const cancelled = m.code === 'cancelled';
  return (
    <div className="cl-msg bot">
      {m.tools.length > 0 && (
        <div className="cl-tools" aria-label="Ferramentas usadas">
          {m.tools.map((t) => (
            <span key={t.id} className={`cl-chip${t.ok === undefined ? ' run' : t.ok ? ' ok' : ' bad'}`} title={t.ok === false ? 'A ferramenta devolveu um erro' : t.ok ? 'Feito' : 'A correr…'}>
              <span className="d" aria-hidden="true" />
              {t.area} <span className="sep">·</span> <span className="t">{t.tool}</span>
            </span>
          ))}
        </div>
      )}
      {m.text && <div className="cl-text"><Markdown text={m.text} /></div>}
      {m.pending && !m.text && <div className="cl-typing" role="status" aria-label="O Claude está a escrever"><i /><i /><i /></div>}
      {m.error && <div className={`cl-note${cancelled ? '' : ' err'}`} role={cancelled ? undefined : 'alert'}>{m.error}</div>}
    </div>
  );
}

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return <span className="cl-elapsed">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>;
}

// ------------------------------------------------------------------ panel
export function ClaudePanel() {
  const open = useChat((s) => s.open);
  const running = useChat((s) => s.running);
  const startedAt = useChat((s) => s.startedAt);
  const model = useChat((s) => s.model);
  const mcp = useChat((s) => s.mcp);
  const installed = useChat((s) => s.installed);
  const threads = useChat((s) => s.threads);
  const filePath = useEditor((s) => s.filePath);
  const name = useEditor((s) => s.project.name);
  const key = useMemo(() => projectKey(), [filePath, name]);
  const msgs = threads[key] ?? EMPTY;
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);
  // keep the newest message in view while it streams
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);
  // grow the input with its text (up to ~6 lines)
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [draft]);

  const send = (text: string) => {
    if (!text.trim() || running) return;
    void useChat.getState().send(text);
    setDraft('');
  };
  const lastErr = [...msgs].reverse().find((m) => m.role === 'assistant')?.code;
  const state = installed === false || lastErr === 'missing' || lastErr === 'auth' ? 'err' : running ? 'run' : 'ok';
  const stateLabel = state === 'err' ? (installed === false || lastErr === 'missing' ? 'Claude Code não instalado' : 'Sem sessão iniciada') : running ? 'A trabalhar' : mcp && mcp !== 'connected' ? 'Editor desligado' : 'Pronto';

  return (
    <aside className={`claude-panel${open ? ' open' : ''}`} aria-label="Chat do Claude" aria-hidden={!open} inert={!open}>
      <header className="cl-head" title={model ? `Modelo: ${modelName(model)}` : undefined}>
        <span className="cl-mark" aria-hidden="true"><Icon name="spark" /></span>
        <div className="cl-title">
          <b>Claude</b>
          <span className={`cl-status ${state}`}>
            <span className="dot" aria-hidden="true" />
            <span className="txt">
              {model && !running ? `${modelName(model)} · ` : ''}
              {stateLabel}
              {running && <> · <Elapsed since={startedAt} /></>}
            </span>
          </span>
        </div>
        <button className="btn ghost sm" onClick={() => useChat.getState().reset()} disabled={!msgs.length && !running} title="Começar uma conversa nova (esquece o contexto)">
          <Icon name="plus" /> Nova conversa
        </button>
        <button className="btn ghost icon sm" onClick={() => useChat.getState().toggle(false)} title="Fechar (Ctrl+K)" aria-label="Fechar o chat">
          <Icon name="close" />
        </button>
      </header>

      <div className="cl-list" ref={listRef} aria-live="polite">
        {msgs.length === 0 ? (
          <div className="cl-empty">
            <span className="orb" aria-hidden="true"><Icon name="spark" /></span>
            <strong>O que queres fazer neste vídeo?</strong>
            <span>O Claude edita o projeto aberto: cortes, legendas, música, cor, efeitos e exportação. Tudo se desfaz com Ctrl+Z.</span>
            {installed === false ? (
              <div className="cl-note err">Não encontrei o Claude Code neste PC. Instala-o e corre <code>claude</code> uma vez num terminal para fazer login.</div>
            ) : (
              <div className="cl-sugs">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="cl-sug" onClick={() => send(s)} disabled={running}>
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          msgs.map((m) => <Bubble key={m.id} m={m} />)
        )}
      </div>

      <form
        className="cl-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          placeholder="Pede uma edição ao Claude…"
          title="Enter envia · Shift+Enter nova linha"
          aria-label="Mensagem para o Claude"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(draft);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              useChat.getState().toggle(false);
            }
          }}
        />
        {running ? (
          <button type="button" className="cl-send stop" onClick={() => useChat.getState().cancel()} title="Parar" aria-label="Parar o Claude">
            <Icon name="stop" />
          </button>
        ) : (
          <button type="submit" className="cl-send" disabled={!draft.trim()} title="Enviar (Enter)" aria-label="Enviar">
            <Icon name="send" />
          </button>
        )}
      </form>
    </aside>
  );
}
