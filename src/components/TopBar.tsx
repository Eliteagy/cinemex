import { useEffect, useState } from 'react';
import { useEditor } from '../store';
import { PRESETS } from '../lib/project';
import type { CanvasPreset } from '../types';
import { exportVideo, importCapcut, openProject, saveProject } from '../actions';
import { Icon } from './Icon';
import { AI_NAMES, useChat } from '../chat';
import { LigacaoButton } from './Ligacao';

export function TopBar() {
  const name = useEditor((s) => s.project.name);
  const preset = useEditor((s) => s.project.canvas.preset);
  const dirty = useEditor((s) => s.dirty);
  const exporting = useEditor((s) => s.exportProgress !== null);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const chatOpen = useChat((s) => s.open);
  const chatRunning = useChat((s) => s.running);
  const provider = useChat((s) => s.provider);
  const runProvider = useChat((s) => s.runProvider);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);

  return (
    <header className="topbar">
      <div className="brand">
        <img className="logo" src="logo.png" alt="" />
        <span>Cinemex</span>
      </div>
      <span className="tb-sep" aria-hidden="true" />
      <input
        className="name-input"
        value={draft}
        aria-label="Nome do projeto"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== name && useEditor.getState().setName(draft)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {dirty && <span className="unsaved" title="Alterações por guardar" role="status" aria-label="Alterações por guardar" />}
      <div className="spacer" />

      <select className="select tb-format" value={preset} aria-label="Formato" onChange={(e) => useEditor.getState().setCanvas(e.target.value as CanvasPreset)}>
        {Object.entries(PRESETS).map(([k, v]) => (
          <option key={k} value={k}>
            {v.label}
          </option>
        ))}
      </select>
      <div className="spacer" />

      <button className="btn ghost icon round" onClick={() => void openProject()} title="Abrir projeto (Ctrl+O)" aria-label="Abrir projeto">
        <Icon name="folder" />
      </button>
      <button className="btn ghost icon round" onClick={() => void importCapcut().catch(() => {})} title="Importar um projeto do CapCut (vídeos, textos, velocidades)" aria-label="Importar projeto do CapCut">
        <Icon name="import" />
      </button>
      <LigacaoButton />
      <div className="ai-switch" role="group" aria-label="Assistente de IA">
        {(['claude', 'gemini', 'gpt'] as const).map((p) => (
          <button
            key={p}
            className={`btn claude-btn${chatOpen && provider === p ? ' on' : ''}${chatRunning && runProvider === p ? ' busy' : ''}`}
            aria-pressed={chatOpen && provider === p}
            onClick={() => useChat.getState().openWith(p)}
            title={`Chat com ${AI_NAMES[p]}: pede edições em português${p === 'claude' ? ' (Ctrl+K)' : ''}`}
          >
            {p === 'claude' && <Icon name="spark" />} {AI_NAMES[p]}
          </button>
        ))}
      </div>
      <div className="tb-undo" role="group" aria-label="Desfazer e refazer">
        <button className="btn ghost icon" disabled={!canUndo} onClick={() => useEditor.getState().undo()} title="Desfazer (Ctrl+Z)" aria-label="Desfazer">
          <Icon name="undo" />
        </button>
        <button className="btn ghost icon" disabled={!canRedo} onClick={() => useEditor.getState().redo()} title="Refazer (Ctrl+Shift+Z)" aria-label="Refazer">
          <Icon name="redo" />
        </button>
      </div>
      <button className="btn" onClick={() => void saveProject()} title="Guardar (Ctrl+S)">
        Guardar
      </button>
      <button className="btn primary" disabled={exporting} onClick={() => void exportVideo().catch(() => {})} title="Exportar MP4 (Ctrl+E)">
        Exportar
      </button>
    </header>
  );
}
