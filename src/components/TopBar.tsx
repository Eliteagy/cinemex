import { useEffect, useState } from 'react';
import { useEditor } from '../store';
import { PRESETS } from '../lib/project';
import type { CanvasPreset } from '../types';
import { exportVideo, importCapcut, openProject, saveProject } from '../actions';
import { Icon } from './Icon';
import { AI_NAMES, useChat } from '../chat';

export function TopBar() {
  const name = useEditor((s) => s.project.name);
  const preset = useEditor((s) => s.project.canvas.preset);
  const dirty = useEditor((s) => s.dirty);
  const exporting = useEditor((s) => s.exportProgress !== null);
  const chatOpen = useChat((s) => s.open);
  const chatRunning = useChat((s) => s.running);
  const provider = useChat((s) => s.provider);
  const runProvider = useChat((s) => s.runProvider);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);

  return (
    <header className="topbar">
      <div className="brand">
        <img className="logo" src="logo.png" alt="Cinemex" />
      </div>
      <span className="crumb" aria-hidden="true">/</span>
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

      <select className="select" value={preset} aria-label="Formato" onChange={(e) => useEditor.getState().setCanvas(e.target.value as CanvasPreset)}>
        {Object.entries(PRESETS).map(([k, v]) => (
          <option key={k} value={k}>
            {v.label}
          </option>
        ))}
      </select>
      <span className="tb-sep" aria-hidden="true" />
      <button className="btn ghost" onClick={() => void importCapcut().catch(() => {})} title="Abrir um projeto do CapCut (vídeos, textos, velocidades)">
        <Icon name="import" /> Importar CapCut
      </button>
      <button className="btn ghost" onClick={() => void openProject()} title="Abrir projeto (Ctrl+O)">
        <Icon name="folder" /> Abrir
      </button>
      <span className="tb-sep" aria-hidden="true" />
      <button className="btn" onClick={() => void saveProject()} title="Guardar (Ctrl+S)">
        <Icon name="save" /> Guardar
      </button>
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
      <button className="btn primary" disabled={exporting} onClick={() => void exportVideo().catch(() => {})} title="Exportar MP4 (Ctrl+E)">
        <Icon name="export" /> Exportar
      </button>
    </header>
  );
}
