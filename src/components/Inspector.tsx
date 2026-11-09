import { useState } from 'react';
import { useEditor } from '../store';
import { baseStyle, dur, findClip, fmtShort, projectDuration } from '../lib/project';
import { autoCaptions, cutSilences } from '../actions';
import { Icon } from './Icon';
import { ClipFx } from './ClipFx';
import { CaptionLook, useStyleOptions } from './CaptionStyleEditor';
import { GraphicInspector } from './GraphicInspector';

function Num({ label, value, step = 0.01, min, max, onChange }: { label: string; value: number; step?: number; min?: number; max?: number; onChange: (v: number) => void }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input className="input" type="number" step={step} min={min} max={max} value={Math.round(value * 1000) / 1000} onChange={(e) => e.target.value !== '' && onChange(Number(e.target.value))} />
    </div>
  );
}

function CaptionsCard({ clipId }: { clipId?: string }) {
  const styleOptions = useStyleOptions();
  const busy = useEditor((s) => s.busy);
  const [style, setStyle] = useState('elite');
  const [words, setWords] = useState(3);
  return (
    <div className="card">
      <h4>Legendas automáticas</h4>
      <p>Transcreve no teu PC (Whisper) e cria legendas palavra a palavra, no estilo dos Reels.</p>
      <div className="field">
        <label>Estilo</label>
        <select className="select" value={style} onChange={(e) => setStyle(e.target.value)}>
          {styleOptions.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Palavras por legenda: {words}</label>
        <input className="range" type="range" min={1} max={6} value={words} onChange={(e) => setWords(Number(e.target.value))} />
      </div>
      <button className="btn primary" style={{ width: '100%' }} disabled={busy} onClick={() => void autoCaptions({ clipId, style, maxWords: words }).catch(() => {})}>
        <Icon name="captions" /> {clipId ? 'Legendar este clip' : 'Legendar o vídeo todo'}
      </button>
    </div>
  );
}

export function Inspector() {
  const styleOptions = useStyleOptions();
  const userStyles = useEditor((s) => s.userStyles);
  const selected = useEditor((s) => s.selected);
  const project = useEditor((s) => s.project);
  const busy = useEditor((s) => s.busy);
  const f = selected ? findClip(project, selected) : null;
  const st = useEditor.getState;

  if (!f) {
    return (
      <aside className="panel" aria-label="Inspetor">
        <div className="panel-head">
          <div>
            <div className="panel-title">Projeto</div>
            <div className="panel-sub">Seleciona um clip para o editar</div>
          </div>
        </div>
        <div className="panel-body">
          <div className="stats">
            <div className="stat">
              <b>{fmtShort(projectDuration(project))}</b>
              <span>Duração</span>
            </div>
            <div className="stat">
              <b>{project.tracks.reduce((n, t) => n + t.clips.length, 0)}</b>
              <span>Clips</span>
            </div>
            <div className="stat">
              <b>{project.canvas.fps}</b>
              <span>fps</span>
            </div>
            <div className="stat wide">
              <span>Formato</span>
              <b>
                {project.canvas.w} × {project.canvas.h}
              </b>
            </div>
          </div>
          <CaptionsCard />
          <div className="card">
            <h4>Texto</h4>
            <p>Um título no ponto onde está a cabeça de leitura.</p>
            <button className="btn" style={{ width: '100%' }} onClick={() => st().addText('Cinemex', st().playhead, 3, 'title')}>
              <Icon name="text" /> Acrescentar texto
            </button>
          </div>
        </div>
      </aside>
    );
  }

  const { clip, track } = f;
  const m = project.media.find((x) => x.id === clip.mediaId);
  const isText = track.kind === 'text';
  return (
    <aside className="panel" aria-label="Inspetor">
      <div className="panel-head">
        <div style={{ minWidth: 0 }}>
          <div className="panel-title">{clip.graphic ? 'Grafismo' : isText ? 'Texto' : m?.kind === 'audio' ? 'Áudio' : m?.kind === 'image' ? 'Imagem' : 'Vídeo'}</div>
          <div className="panel-sub" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {isText ? clip.text : m?.name}
          </div>
        </div>
        <div className="spacer" />
        <button className="btn icon danger" title="Apagar (Delete)" aria-label="Apagar" onClick={() => st().deleteClip(clip.id)}>
          <Icon name="trash" />
        </button>
      </div>
      <div className="panel-body">
        <Num label="Início na timeline (s)" value={clip.start} onChange={(v) => st().moveClip(clip.id, v)} min={0} />
        <Num label="Duração (s)" value={dur(clip)} onChange={(v) => st().trimClip(clip.id, { out: clip.in + Math.max(0.1, v) * (clip.speed ?? 1) })} min={0.1} />
        {clip.graphic ? (
          <GraphicInspector clip={clip} />
        ) : isText ? (
          <>
            <div className="field">
              <label>Texto</label>
              <textarea className="textarea" defaultValue={clip.text} key={clip.id} onBlur={(e) => e.target.value !== clip.text && st().updateClip(clip.id, { text: e.target.value, words: undefined })} />
            </div>
            <div className="field">
              <label>Estilo</label>
              <select className="select" value={clip.style ?? 'elite'} onChange={(e) => st().updateClip(clip.id, { style: e.target.value })}>
                {styleOptions.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
              </select>
            </div>
            <div className="field">
              <label>Posição vertical</label>
              <input className="range" type="range" min={0.05} max={0.95} step={0.01} value={clip.y ?? baseStyle(clip, project, userStyles).y} onChange={(e) => st().updateClip(clip.id, { y: Number(e.target.value) })} />
            </div>
            <CaptionLook clip={clip} />
          </>
        ) : (
          <>
            {m?.kind !== 'image' && (
              <div className="kv" style={{ margin: '4px 0 8px' }}>
                <span>Entrada</span>
                <b>{clip.in.toFixed(2)} s</b>
                <span>Saída</span>
                <b>{clip.out.toFixed(2)} s</b>
                <span>Ficheiro</span>
                <b>{m ? fmtShort(m.duration) : '–'}</b>
              </div>
            )}
            {m?.kind !== 'audio' && (
              <div className="field">
                <label>Enquadramento</label>
                <div className="seg">
                  <button className={clip.fit !== 'fit' ? 'on' : ''} onClick={() => st().updateClip(clip.id, { fit: 'fill' })}>
                    Preencher
                  </button>
                  <button className={clip.fit === 'fit' ? 'on' : ''} onClick={() => st().updateClip(clip.id, { fit: 'fit' })}>
                    Mostrar tudo
                  </button>
                </div>
              </div>
            )}
            {m?.kind !== 'audio' && (
              <div className="field">
                <label>Rodar a fonte (filmado de lado)</label>
                <div className="seg">
                  {([0, 90, 180, 270] as const).map((o) => (
                    <button key={o} className={(clip.orient ?? 0) === o ? 'on' : ''} onClick={() => st().updateClip(clip.id, { orient: o || undefined })}>
                      {o}°
                    </button>
                  ))}
                </div>
              </div>
            )}
            {m?.hasAudio && (
              <div className="field">
                <label>Volume: {Math.round((clip.volume ?? 1) * 100)}%</label>
                <input className="range" type="range" min={0} max={2} step={0.01} value={clip.volume ?? 1} onChange={(e) => st().updateClip(clip.id, { volume: Number(e.target.value) })} />
              </div>
            )}
            <ClipFx clip={clip} media={m} />
            {m?.hasAudio && (
              <>
                <CaptionsCard clipId={clip.id} />
                <div className="card">
                  <h4>Cortar pausas</h4>
                  <p>Tira os silêncios entre frases (jump cuts) e junta o resto, pela transcrição.</p>
                  <button className="btn" style={{ width: '100%' }} disabled={busy} onClick={() => void cutSilences(clip.id).catch((e) => st().setStatus((e as Error).message))}>
                    <Icon name="scissors" /> Cortar pausas
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
