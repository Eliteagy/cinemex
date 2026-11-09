// "Entregar" page: export settings on the left, finished exports on the right.
import { useState } from 'react';
import { useEditor } from '../store';
import { PRESETS, fmtTime, projectDuration } from '../lib/project';
import type { CanvasPreset } from '../types';
import { exportVideo } from '../actions';
import { Icon } from './Icon';

export interface DoneExport {
  path: string;
  at: number;
  seconds: number;
}

export function DeliverSettings({ onDone }: { onDone: (d: DoneExport) => void }) {
  const project = useEditor((s) => s.project);
  const audio = project.audio ?? {};
  const progress = useEditor((s) => s.exportProgress);
  const [gpu, setGpu] = useState(false);
  const [quality, setQuality] = useState<'alta' | 'media' | 'leve'>('alta');
  const total = projectDuration(project);
  const run = async () => {
    const t0 = Date.now();
    const out = await exportVideo({ gpu, quality }).catch(() => null);
    if (out) onDone({ path: out, at: Date.now(), seconds: Math.round((Date.now() - t0) / 100) / 10 });
  };
  return (
    <aside className="panel" aria-label="Definições de exportação">
      <div className="ph">Definições de exportação</div>
      <div className="panel-body">
        <div className="field">
          <label>Formato</label>
          <select className="select" value={project.canvas.preset} onChange={(e) => useEditor.getState().setCanvas(e.target.value as CanvasPreset)}>
            {Object.entries(PRESETS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
        <div className="stats" style={{ marginBottom: 16 }}>
          <div className="stat span2">
            <b>{fmtTime(total, project.canvas.fps)}</b>
            <span>Duração</span>
          </div>
          <div className="stat">
            <b>{project.canvas.fps}</b>
            <span>fps</span>
          </div>
          <div className="stat wide">
            <span>Resolução</span>
            <b>
              {project.canvas.w} × {project.canvas.h}
            </b>
          </div>
          <div className="stat wide">
            <span>Ficheiro</span>
            <b>MP4 · H.264 · AAC</b>
          </div>
        </div>
        <div className="field">
          <label>Qualidade</label>
          <div className="seg">
            {(['alta', 'media', 'leve'] as const).map((q) => (
              <button key={q} className={quality === q ? 'on' : ''} onClick={() => setQuality(q)}>
                {q === 'alta' ? 'Alta' : q === 'media' ? 'Média' : 'Leve'}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Codificação</label>
          <div className="seg">
            <button className={!gpu ? 'on' : ''} onClick={() => setGpu(false)}>
              Processador
            </button>
            <button className={gpu ? 'on' : ''} onClick={() => setGpu(true)}>
              Placa NVIDIA
            </button>
          </div>
        </div>
        <div className="field">
          <label>Som</label>
          <label className="check">
            <input type="checkbox" checked={Boolean(audio.normalize)} onChange={(e) => useEditor.getState().setAudio({ normalize: e.target.checked })} />
            <span>Volume certo para redes (-14 LUFS)</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={Boolean(audio.duck)} onChange={(e) => useEditor.getState().setAudio({ duck: e.target.checked })} />
            <span>Baixar a música quando há voz</span>
          </label>
        </div>
        <button className="btn primary block" disabled={progress !== null || total <= 0} onClick={() => void run()}>
          <Icon name="export" /> {progress !== null ? `A exportar ${Math.round(progress * 100)}%` : 'Exportar vídeo'}
        </button>
      </div>
    </aside>
  );
}

export function DeliverQueue({ items }: { items: DoneExport[] }) {
  return (
    <aside className="panel" aria-label="Exportações">
      <div className="ph">Exportações</div>
      <div className="panel-body">
        {!items.length && (
          <div className="empty-state">
            <span className="orb">
              <Icon name="export" />
            </span>
            <strong>Sem exportações</strong>
            As exportações desta sessão aparecem aqui.
          </div>
        )}
        {items.map((d) => (
          <div className="job" key={d.at}>
            <div className="job-name">{d.path.split(/[\\/]/).pop()}</div>
            <div className="panel-sub">
              {new Date(d.at).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })} · {d.seconds} s
            </div>
            <button className="btn sm" onClick={() => void window.ec.reveal(d.path)}>
              <Icon name="folder" /> Mostrar na pasta
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
