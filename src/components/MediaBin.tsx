import { useEditor } from '../store';
import { fmtShort } from '../lib/project';
import { importDialog } from '../actions';
import { Icon } from './Icon';
import { useState } from 'react';
import { FxLibrary } from './FxLibrary';

export function MediaBin() {
  const media = useEditor((s) => s.project.media);
  const [tab, setTab] = useState<'media' | 'fx'>('media');

  return (
    <aside className="panel" aria-label="Média">
      <div className="panel-head">
        <div>
          <div className="panel-title">Média</div>
          <div className="panel-sub">{media.length ? `${media.length} ficheiros` : 'Arrasta ficheiros para a janela'}</div>
        </div>
        <div className="spacer" />
        {tab === 'media' && (
          <button className="btn sm" onClick={() => void importDialog()} title="Importar (Ctrl+I)">
            <Icon name="import" /> Importar
          </button>
        )}
      </div>
      <div className="seg bin-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'media'} className={tab === 'media' ? 'on' : ''} onClick={() => setTab('media')}>
          Média
        </button>
        <button role="tab" aria-selected={tab === 'fx'} className={tab === 'fx' ? 'on' : ''} onClick={() => setTab('fx')}>
          Efeitos
        </button>
      </div>
      <div className="panel-body">
        {tab === 'fx' ? (
          <FxLibrary />
        ) : !media.length ? (
          <div className="drop-hint empty-state">
            <span className="orb">
              <Icon name="import" />
            </span>
            <strong>Sem média</strong>
            Vídeos, música e imagens.
            <br />
            Arrasta para aqui ou carrega em Importar.
          </div>
        ) : (
          <div className="media-grid">
            {media.map((m) => (
              <div
                key={m.id}
                className="media-card"
                draggable
                title={`${m.name}\nDuplo clique: pôr no fim da timeline`}
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-ec-media', m.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onDoubleClick={() => useEditor.getState().addClip(m.id)}
              >
                <div className={`media-thumb ${m.kind}${m.kind === 'audio' && m.duration < 8 ? ' fx' : ''}`} style={m.thumb ? { backgroundImage: `url(${m.thumb})` } : undefined}>
                  {m.kind === 'audio' && <Icon name="sound" className="icon" />}
                  {m.kind === 'video' && !m.thumb && <Icon name="play" className="icon" />}
                  <span className="kind">{m.kind === 'video' ? 'Vídeo' : m.kind === 'audio' ? 'Áudio' : 'Imagem'}</span>
                  {m.kind !== 'image' && <span className="badge">{fmtShort(m.duration)}</span>}
                </div>
                <div className="media-name">{m.name}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
