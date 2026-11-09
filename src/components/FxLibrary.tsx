// "Efeitos" tab of the left panel: sound effects, graphics templates and beat tools.
import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../store';
import { addSfx, autoSfx, detectBeats, sfxLibrary } from '../actions';
import { GRAPHICS, GRAPHIC_KINDS } from '../lib/graphics.js';
import { mediaUrl, projectDuration } from '../lib/project';
import { Icon } from './Icon';

const st = useEditor.getState;
const fail = (e: unknown) => st().setStatus((e as Error).message);

function Sounds() {
  const [list, setList] = useState<{ id: string; label: string; path: string; duration: number }[]>([]);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    void sfxLibrary().then(setList).catch(fail);
  }, []);
  const play = (path: string) => {
    audio.current?.pause();
    audio.current = new Audio(mediaUrl(path));
    void audio.current.play().catch(() => {});
  };
  return (
    <div className="card">
      <h4>Efeitos sonoros</h4>
      <p>Ouve com ▶ e carrega no nome para pôr na cabeça de leitura (pista SFX).</p>
      <div className="fx-list">
        {list.map((x) => (
          <div className="fx-row" key={x.id}>
            <button className="btn icon sm" title="Ouvir" aria-label={`Ouvir ${x.label}`} onClick={() => play(x.path)}>
              <Icon name="play" />
            </button>
            <button className="btn sm fx-name" onClick={() => void addSfx(x.id).catch(fail)} title="Pôr na timeline">
              {x.label}
              <span className="panel-sub">{x.duration.toFixed(1)} s</span>
            </button>
          </div>
        ))}
      </div>
      <button className="btn sm primary" style={{ width: '100%', marginTop: 8 }} onClick={() => void autoSfx(['transitions', 'graphics']).catch(fail)}>
        <Icon name="sound" /> SFX automáticos (transições e grafismos)
      </button>
      <button className="btn sm" style={{ width: '100%', marginTop: 6 }} onClick={() => void autoSfx(['cuts']).catch(fail)}>
        Swoosh em todos os cortes
      </button>
    </div>
  );
}

function Graphics() {
  const add = (kind: (typeof GRAPHIC_KINDS)[number]) => {
    const s = st();
    const start = kind === 'progress' ? 0 : s.playhead;
    const len = kind === 'progress' ? Math.max(1, projectDuration(s.project)) : 3;
    s.addGraphic(kind, start, len);
  };
  return (
    <div className="card">
      <h4>Grafismos</h4>
      <p>Títulos e etiquetas animados. Ficam na pista Grafismos; muda o texto e as cores no inspetor.</p>
      <div className="seg grid" style={{ gridAutoFlow: 'row', gridTemplateColumns: '1fr 1fr' }}>
        {GRAPHIC_KINDS.map((k) => (
          <button key={k} onClick={() => add(k)}>
            {GRAPHICS[k].label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Beats() {
  const beats = useEditor((s) => (s.project.markers ?? []).filter((m) => m.beat).length);
  const [amount, setAmount] = useState(0.08);
  return (
    <div className="card">
      <h4>Batidas da música</h4>
      <p>{beats ? `${beats} batidas marcadas na régua.` : 'Deteta as batidas da música da pista de áudio e marca-as na régua.'}</p>
      <button className="btn sm" style={{ width: '100%' }} onClick={() => void detectBeats().catch(fail)}>
        Detetar batidas
      </button>
      {beats > 0 && (
        <>
          <div className="field">
            <label className="row-label">
              <span>Zoom por batida</span>
              <b className="val">{Math.round(amount * 100)}%</b>
            </label>
            <input className="range" type="range" min={0.02} max={0.25} step={0.01} value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
          </div>
          <div className="row" style={{ marginTop: 0 }}>
            <button className="btn sm" onClick={() => {
              try {
                st().setStatus(`${st().beatPulse(st().selected ? [st().selected!] : 'all', amount)} clips a pulsar`);
              } catch (e) {
                fail(e);
              }
            }}>
              Pulsar no beat
            </button>
            <button className="btn sm" onClick={() => {
              try {
                st().setStatus(`${st().snapCutsToBeats()} cortes encostados ao beat`);
              } catch (e) {
                fail(e);
              }
            }}>
              Cortes no beat
            </button>
          </div>
          <button className="btn sm ghost" style={{ width: '100%', marginTop: 6 }} onClick={() => st().clearMarkers(true)}>
            Tirar as batidas
          </button>
        </>
      )}
    </div>
  );
}

export function FxLibrary() {
  return (
    <>
      <Graphics />
      <Sounds />
      <Beats />
    </>
  );
}
