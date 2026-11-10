import { useEffect } from 'react';
import { TopBar } from './components/TopBar';
import { useEditor } from './store';
import { exportVideo, importDialog, importPaths, openProject, saveProject } from './actions';
import { handleMcp } from './mcpHandler';
import { useState } from 'react';
import type { DoneExport } from './components/Deliver';
import { DeliverContext, Dock, resetDock } from './components/Dock';
import { Icon } from './components/Icon';
import { ClaudePanel } from './components/ClaudePanel';
import { LigacaoPanel } from './components/Ligacao';
import { initCollab } from './collab';
import { useChat } from './chat';

const PAGES = [
  { id: 'media', label: 'Média', icon: 'import' },
  { id: 'edit', label: 'Editar', icon: 'scissors' },
  { id: 'fusion', label: 'Fusion', icon: 'nodes' },
  { id: 'color', label: 'Cor', icon: 'color' },
  { id: 'captions', label: 'Legendas', icon: 'captions' },
  { id: 'deliver', label: 'Entregar', icon: 'export' },
] as const;

export function App() {
  const page = useEditor((s) => s.page);
  const [done, setDone] = useState<DoneExport[]>([]);
  // Bumped by "Repor painéis": the dock of this page is mounted again with its default arrangement.
  const [dockRev, setDockRev] = useState(0);
  const [mcp, setMcp] = useState('');
  useEffect(() => {
    void window.ec.mcpInfo().then((i) => setMcp(i.url));
  }, []);
  useEffect(() => window.ec.onMcpCall(handleMcp), []);
  useEffect(() => initCollab(), []);
  useEffect(() => void useEditor.getState().loadUserStyles(), []);
  useEffect(() => window.ec.onClaudeEvent((ev) => useChat.getState().onEvent(ev)), []);
  // Ctrl+K opens/closes the Claude chat, also while typing in it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopPropagation();
        useChat.getState().toggle();
      }
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, []);

  // Keyboard shortcuts (not while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select')) return;
      const s = useEditor.getState();
      const ctrl = e.ctrlKey || e.metaKey;
      const fps = s.project.canvas.fps;
      const k = e.key.toLowerCase();
      if (ctrl && k === 'z') s[e.shiftKey ? 'redo' : 'undo']();
      else if (ctrl && k === 'y') s.redo();
      else if (ctrl && k === 's') void saveProject();
      else if (ctrl && k === 'o') void openProject();
      else if (ctrl && k === 'i') void importDialog();
      else if (ctrl && k === 'e') void exportVideo().catch(() => {});
      else if (ctrl) return;
      else if (e.key === ' ') s.setPlaying(!s.playing);
      else if (k === 's' || k === 'c') s.splitAt(s.playhead, s.selected);
      else if (e.key === 'Delete' || e.key === 'Backspace') s.selected && s.deleteClip(s.selected, e.shiftKey);
      else if (k === 't') s.addText('Texto', s.playhead, 3, 'title');
      else if (k === 'm') s.addMarker(s.playhead);
      else if (e.key === 'Home') s.seek(0);
      else if (e.key === 'End') s.seek(1e9);
      else if (e.key === 'ArrowLeft') s.seek(s.playhead - (e.shiftKey ? 1 : 1 / fps));
      else if (e.key === 'ArrowRight') s.seek(s.playhead + (e.shiftKey ? 1 : 1 / fps));
      else if (e.key === '+' || e.key === '=') s.setZoom(s.zoom * 1.4);
      else if (e.key === '-') s.setZoom(s.zoom / 1.4);
      else if (e.key === 'Escape') s.select(null);
      else if (e.shiftKey && /^Digit[1-6]$/.test(e.code)) s.setPage(PAGES[Number(e.code.slice(5)) - 1]!.id);
      else return;
      e.preventDefault();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  // Drop files from Explorer anywhere on the window.
  useEffect(() => {
    const over = (e: DragEvent) => e.dataTransfer?.types.includes('Files') && e.preventDefault();
    const drop = (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      // Electron gives the real path of dropped files through webUtils (preload).
      const paths = files.map((f) => window.ec.pathForFile(f)).filter((p): p is string => Boolean(p));
      if (paths.length) void importPaths(paths);
    };
    addEventListener('dragover', over);
    addEventListener('drop', drop);
    return () => {
      removeEventListener('dragover', over);
      removeEventListener('drop', drop);
    };
  }, []);

  return (
    <div className={`app docked page-${page}`}>
      <TopBar />
      <DeliverContext.Provider value={{ done, add: (d) => setDone((x) => [d, ...x]) }}>
        <Dock key={`${page}:${dockRev}`} page={page} />
      </DeliverContext.Provider>
      <ClaudePanel />
      <LigacaoPanel />
      <nav className="pagebar" aria-label="Páginas">
        <div className="pages">
        {PAGES.map((p) => (
          <button key={p.id} className={page === p.id ? 'on' : ''} aria-pressed={page === p.id} onClick={() => useEditor.getState().setPage(p.id)} title={p.label}>
            <Icon name={p.icon} />
            <span>{p.label}</span>
          </button>
        ))}
        </div>
        <button
          className="pill dock-reset"
          title="Põe os painéis desta página como vieram (tamanhos e posições)"
          onClick={() => {
            resetDock(page);
            setDockRev((r) => r + 1);
          }}
        >
          Repor painéis
        </button>
        <span className={`pill mcp${mcp ? ' on' : ''}`} title={mcp ? `Servidor MCP: ${mcp}` : 'Servidor MCP desligado'}>
          <span className="dot" />
          {mcp ? 'Claude pode editar' : 'MCP desligado'}
        </span>
      </nav>
    </div>
  );
}
