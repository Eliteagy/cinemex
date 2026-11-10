// Inspector sections for media clips: speed, transitions and keyframe animation.
import { useEditor } from '../store';
import { dur, kfValue } from '../lib/project';
import type { Clip, KeyProp, Mask, MaskMode, Media, TransitionType } from '../types';
import { Icon } from './Icon';
import { TRANSITIONS, TRANSITION_TYPES } from '../lib/fx.js';
import type { MotionPreset } from '../lib/fx.js';
import { freezeFrame, personMatte } from '../actions';
import { CompositeCard, EaseCard, EffectsCard, ExpressionsCard } from './AeFx';

const st = useEditor.getState;

function Speed({ clip }: { clip: Clip }) {
  const speed = clip.speed ?? 1;
  return (
    <div className="card">
      <h4>Velocidade · {speed.toFixed(2).replace(/\.?0+$/, '')}×</h4>
      <p>Câmara lenta ou acelerado. O som mantém o tom.</p>
      <div className="seg" style={{ marginBottom: 8 }}>
        {[0.5, 1, 1.5, 2, 3].map((v) => (
          <button key={v} className={Math.abs(speed - v) < 0.001 ? 'on' : ''} onClick={() => st().setSpeed(clip.id, v)}>
            {v}×
          </button>
        ))}
      </div>
      <input className="range" type="range" min={0.25} max={4} step={0.05} value={speed} onChange={(e) => st().setSpeed(clip.id, Number(e.target.value))} aria-label="Velocidade" />
    </div>
  );
}

function TransitionRow({ clip, side }: { clip: Clip; side: 'in' | 'out' }) {
  const tr = side === 'in' ? clip.transitionIn : clip.transitionOut;
  const set = (type: TransitionType | null, d = tr?.d ?? 0.5) => st().setTransition(clip.id, side, type ? { type, d } : null);
  return (
    <div className="field">
      <label>{side === 'in' ? 'Entrada' : 'Saída'}</label>
      <div className="seg grid" style={{ gridAutoFlow: 'row', gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <button className={!tr ? 'on' : ''} onClick={() => set(null)}>
          Nenhuma
        </button>
        {TRANSITION_TYPES.map((k) => (
          <button key={k} className={tr?.type === k ? 'on' : ''} onClick={() => set(k)}>
            {TRANSITIONS[k].label}
          </button>
        ))}
      </div>
      {tr && (
        <div className="row">
          <input className="range" type="range" min={0.1} max={Math.max(0.2, Math.min(3, dur(clip)))} step={0.05} value={tr.d} onChange={(e) => set(tr.type, Number(e.target.value))} aria-label="Duração da transição" />
          <span className="panel-sub" style={{ width: 44, textAlign: 'right' }}>
            {tr.d.toFixed(2)} s
          </span>
        </div>
      )}
    </div>
  );
}

export function Transitions({ clip }: { clip: Clip }) {
  return (
    <div className="card">
      <h4>Transições</h4>
      <p>Fade, slide, whip (com motion blur), zoom, spin, flash branco, mergulho a preto e desfocar. O som também faz fade.</p>
      <TransitionRow clip={clip} side="in" />
      <TransitionRow clip={clip} side="out" />
      <button className="btn sm" style={{ width: '100%' }} onClick={() => void Promise.resolve().then(() => st().dissolveWithPrevious(clip.id, 0.5)).catch((e) => st().setStatus((e as Error).message))}>
        Dissolver com o clip anterior
      </button>
    </div>
  );
}

const PROPS: { key: KeyProp; label: string; min: number; max: number; step: number; def: number }[] = [
  { key: 'zoom', label: 'Zoom', min: 1, max: 3, step: 0.01, def: 1 },
  { key: 'x', label: 'Posição horizontal', min: -0.5, max: 0.5, step: 0.005, def: 0 },
  { key: 'y', label: 'Posição vertical', min: -0.5, max: 0.5, step: 0.005, def: 0 },
  { key: 'rotate', label: 'Rotação', min: -180, max: 180, step: 0.5, def: 0 },
  { key: 'opacity', label: 'Opacidade', min: 0, max: 1, step: 0.01, def: 1 },
];

const PRESETS: { k: MotionPreset; label: string }[] = [
  { k: 'zoom_in', label: 'Zoom in' },
  { k: 'zoom_out', label: 'Zoom out' },
  { k: 'ken_burns', label: 'Ken Burns' },
  { k: 'punch', label: 'Punch' },
  { k: 'shake', label: 'Tremer' },
  { k: 'pulse', label: 'Pulsar' },
  { k: 'spin_in', label: 'Entrar a rodar' },
  { k: 'fade_in_out', label: 'Aparecer/sumir' },
];

const fmtProp = (k: KeyProp, v: number) => (k === 'zoom' ? `${v.toFixed(2)}×` : k === 'rotate' ? `${v.toFixed(1)}°` : `${Math.round(v * 100)}%`);

function Animation({ clip }: { clip: Clip }) {
  const playhead = useEditor((s) => s.playhead);
  const local = Math.max(0, Math.min(dur(clip), playhead - clip.start));
  const inside = playhead >= clip.start && playhead <= clip.start + dur(clip);
  const count = Object.values(clip.keyframes ?? {}).reduce((n, l) => n + (l?.length ?? 0), 0);
  return (
    <div className="card">
      <h4>Animação · keyframes</h4>
      <p>{inside ? 'Mexe nos controlos: fica um keyframe onde está a cabeça de leitura. Entre keyframes o movimento é suave.' : 'Põe a cabeça de leitura em cima deste clip para criar keyframes.'}</p>
      <div className="seg grid" style={{ marginBottom: 6, gridAutoFlow: 'row', gridTemplateColumns: '1fr 1fr' }}>
        {PRESETS.map((p) => (
          <button key={p.k} onClick={() => st().animate(clip.id, p.k)}>
            {p.label}
          </button>
        ))}
      </div>
      {PROPS.map((p) => {
        const list = clip.keyframes?.[p.key];
        const v = kfValue(list, local, p.def);
        const here = list?.find((k) => Math.abs(k.t - local) < 0.02);
        return (
          <div className="field" key={p.key}>
            <label>
              {p.label}: {fmtProp(p.key, v)} {list?.length ? `· ${list.length} keyframes` : ''}
            </label>
            <div className="row">
              <input className="range" type="range" min={p.min} max={p.max} step={p.step} value={v} disabled={!inside} onChange={(e) => st().setKeyframe(clip.id, p.key, playhead, Number(e.target.value))} aria-label={p.label} />
              <button
                className={`btn icon sm${here ? ' on' : ''}`}
                disabled={!inside}
                title={here ? 'Tirar este keyframe' : 'Pôr keyframe aqui'}
                aria-label="Keyframe"
                onClick={() => (here ? st().removeKeyframe(clip.id, p.key, here.t) : st().setKeyframe(clip.id, p.key, playhead, v))}
              >
                ◆
              </button>
            </div>
          </div>
        );
      })}
      {count > 0 && (
        <button className="btn sm danger" style={{ width: '100%' }} onClick={() => st().clearKeyframes(clip.id)}>
          <Icon name="trash" /> Tirar animação ({count} keyframes)
        </button>
      )}
    </div>
  );
}

const MODES: { k: MaskMode; label: string }[] = [
  { k: 'front', label: 'Legendas atrás' },
  { k: 'blur', label: 'Desfocar' },
  { k: 'pixelate', label: 'Pixelizar' },
  { k: 'darken', label: 'Escurecer' },
  { k: 'cut', label: 'Recortar' },
];

const SHAPE_NAME: Record<Mask['shape'], string> = { ellipse: 'Elipse', rect: 'Retângulo', pen: 'Caneta', person: 'Pessoa' };

/** Pessoa: click on the person (or again), progress, redo after a trim. Caneta: draw / redraw the points. */
function ShapeTools({ clip, m }: { clip: Clip; m: Mask }) {
  const tool = useEditor((s) => s.maskTool);
  const busy = useEditor((s) => s.busy);
  const active = tool?.maskId === m.id;
  if (m.shape === 'person') {
    const stale = m.matte && (Math.abs(m.matte.in - clip.in) > 0.01 || Math.abs(m.matte.out - clip.out) > 0.01);
    return (
      <div className="shape-tools">
        <p className="panel-sub">{active ? 'Clica na pessoa no visor.' : !m.matte ? 'Ainda sem pessoa escolhida.' : stale ? 'O clip foi cortado: volta a recortar para cobrir o clip todo.' : 'Pessoa recortada em todo o clip. As legendas passam por trás dela.'}</p>
        <div className="row">
          <button className={`btn sm${active ? ' on' : ''}`} disabled={busy} onClick={() => st().setMaskTool(active ? null : { clipId: clip.id, maskId: m.id, kind: 'pick' })}>
            {m.matte ? 'Escolher outra pessoa' : 'Escolher a pessoa'}
          </button>
          {m.matte && stale && (
            <button className="btn sm" disabled={busy} onClick={() => void personMatte(clip.id, m.id, m.x, m.y).catch(() => {})}>
              Recortar outra vez
            </button>
          )}
        </div>
      </div>
    );
  }
  if (m.shape === 'pen') {
    const n = m.points?.length ?? 0;
    return (
      <div className="shape-tools">
        <p className="panel-sub">{active ? 'Clica no visor para pôr pontos; fecha clicando no primeiro ponto ou com Enter. Esc cancela.' : n >= 3 ? `${n} pontos · arrasta os pontos no visor para acertar.` : 'Desenha a forma no visor.'}</p>
        <div className="row">
          <button className={`btn sm${active ? ' on' : ''}`} onClick={() => (active ? st().setMaskTool(null) : (st().updateMask(clip.id, m.id, { points: [] }), st().setMaskTool({ clipId: clip.id, maskId: m.id, kind: 'pen' })))}>
            {active ? 'Terminar' : n ? 'Desenhar outra vez' : 'Desenhar'}
          </button>
        </div>
      </div>
    );
  }
  return null;
}

export function Masks({ clip }: { clip: Clip }) {
  const masks = clip.masks ?? [];
  const pct = (v: number) => Math.round(v * 100);
  return (
    <div className="card">
      <h4>Efeitos · Máscaras</h4>
      <p>Põe as legendas atrás da pessoa, desfoca uma cara ou matrícula, escurece à volta ou recorta o vídeo numa forma.</p>
      <div className="mask-add">
        <button className="btn sm primary" onClick={() => st().addMask(clip.id, 'person', 'front')} title="Clica na pessoa no visor: ela é recortada sozinha em todo o clip (como a seleção de objeto do Premiere)">
          <Icon name="plus" /> Pessoa
        </button>
        <button className="btn sm" onClick={() => st().addMask(clip.id, 'pen', 'front')} title="Desenha a forma no visor com pontos (caneta)">
          <Icon name="plus" /> Caneta
        </button>
        <button className="btn sm" onClick={() => st().addMask(clip.id, 'ellipse')}>
          <Icon name="plus" /> Elipse
        </button>
        <button className="btn sm" onClick={() => st().addMask(clip.id, 'rect')}>
          <Icon name="plus" /> Retângulo
        </button>
      </div>
      {masks.map((m, i) => {
        const set = (patch: Partial<Mask>) => st().updateMask(clip.id, m.id, patch);
        return (
          <div className="mask" key={m.id}>
            <div className="row-label">
              <b>
                {SHAPE_NAME[m.shape]} {i + 1}
              </b>
              <button className="btn icon sm" title="Apagar máscara" onClick={() => st().removeMask(clip.id, m.id)}>
                <Icon name="trash" />
              </button>
            </div>
            <div className="seg">
              {MODES.map((x) => (
                <button key={x.k} className={m.mode === x.k ? 'on' : ''} onClick={() => set({ mode: x.k })}>
                  {x.label}
                </button>
              ))}
            </div>
            <ShapeTools clip={clip} m={m} />
            {m.mode !== 'cut' && m.mode !== 'front' && (
              <div className="field">
                <label className="row-label">
                  <span>Intensidade</span>
                  <b className="val">{pct(m.amount)}</b>
                </label>
                <input className="range" type="range" min={0} max={1} step={0.01} value={m.amount} onPointerDown={() => st().startSlide()} onChange={(e) => set({ amount: Number(e.target.value) })} />
              </div>
            )}
            <div className="field">
              <label className="row-label">
                <span>Suavizar bordas</span>
                <b className="val">{pct(m.feather / 0.2)}</b>
              </label>
              <input className="range" type="range" min={0} max={0.2} step={0.002} value={m.feather} onPointerDown={() => st().startSlide()} onChange={(e) => set({ feather: Number(e.target.value) })} />
            </div>
            <label className="check">
              <input type="checkbox" checked={m.invert} onChange={(e) => set({ invert: e.target.checked })} />
              <span>Inverter (efeito fora da forma)</span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={m.toX !== undefined}
                onChange={(e) => set(e.target.checked ? { toX: m.x, toY: m.y } : { toX: undefined, toY: undefined })}
              />
              <span>Mexer ao longo do clip (arrasta o ponto final no visor)</span>
            </label>
          </div>
        );
      })}
    </div>
  );
}

export function Freeze({ clip }: { clip: Clip }) {
  const playhead = useEditor((s) => s.playhead);
  const inside = playhead > clip.start && playhead < clip.start + dur(clip);
  return (
    <div className="card">
      <h4>Congelar imagem</h4>
      <p>{inside ? 'O vídeo pára na imagem da cabeça de leitura; o resto da pista anda para a frente.' : 'Põe a cabeça de leitura em cima deste clip.'}</p>
      <div className="row" style={{ marginTop: 0 }}>
        {[1, 1.5, 2, 3].map((s) => (
          <button key={s} className="btn sm" disabled={!inside} onClick={() => void freezeFrame(playhead, s, clip.id).catch(() => {})}>
            {s} s
          </button>
        ))}
      </div>
    </div>
  );
}

export function ClipFx({ clip, media }: { clip: Clip; media?: Media }) {
  return (
    <>
      {media && media.kind !== 'image' && <Speed clip={clip} />}
      {media && media.kind === 'video' && <Freeze clip={clip} />}
      <Transitions clip={clip} />
      {media && media.kind !== 'audio' && <Animation clip={clip} />}
      {media && media.kind !== 'audio' && <EaseCard clip={clip} />}
      {media && media.kind !== 'audio' && <ExpressionsCard clip={clip} />}
      {media && media.kind !== 'audio' && <EffectsCard clip={clip} />}
      {media && media.kind !== 'audio' && <CompositeCard clip={clip} />}
      {media && media.kind !== 'audio' && <Masks clip={clip} />}
    </>
  );
}
