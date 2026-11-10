// Inspector of the Editar page. The structure and the way it works follow DaVinci Resolve's
// Inspector: the clip name on top, a row of tabs (Vídeo, Áudio, Efeitos, Transição, Imagem,
// Ficheiro) and collapsible sections whose rows are "label · fields · keyframe · reset", with
// number boxes that are dragged sideways. The look is Cinemex's own (glass panel, gold accent,
// the app's controls; see .rinsp in styles.css). What the engine does not do yet (Estabilização,
// Correção de Lente) is shown dimmed in its place, and the dot on each section
// says "this section has changes" (there is no bypass yet).
import { useRef, useState, type ReactNode } from 'react';
import { useEditor } from '../store';
import { KEY_DEFAULT, baseStyle, dur, findClip, fmtShort, kfValue, projectDuration, r3, speedOf } from '../lib/project';
import { autoCaptions, cutSilences } from '../actions';
import { BLEND_LABELS, BLEND_MODES } from '../lib/layerfx.js';
import { CROP_ID, cropOf, setCrop } from '../lib/crop.js';
import type { Crop } from '../lib/crop.js';
import type { BlendMode, Clip, KeyProp, Media } from '../types';
import type { MotionPreset } from '../lib/fx.js';
import { Icon } from './Icon';
import { Freeze, Masks, Transitions } from './ClipFx';
import { CompositeCard, EaseCard, EffectsCard, ExpressionsCard } from './AeFx';
import { CaptionLook, useStyleOptions } from './CaptionStyleEditor';
import { GraphicInspector } from './GraphicInspector';

const st = useEditor.getState;

// ------------------------------------------------------------------ small glyphs (20 px tabs, 14 px row tools)
const G = {
  video: 'M3 5h14v10H3zM3 8h2.5M3 12h2.5M14.5 8H17M14.5 12H17M5.5 5v10M14.5 5v10',
  audio: 'M8 14.5V5l8-1.5V13M8 14.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM16 13a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  effects: 'M4 16 13 7M11.5 5.5l3 3M15 2.5v2.4M13.8 3.7h2.4M17 7.5v2M16 8.5h2M8 3v2M7 4h2',
  transition: 'M3 5h14v10H3zM3 5l7 5-7 5M17 5l-7 5 7 5',
  image: 'M3 5h14v10H3zM3 13l4-4 3 3 2.5-2.5L17 14M13.5 8.2a.9.9 0 1 1-1.8 0 .9.9 0 0 1 1.8 0Z',
  file: 'M5 3h7l3 3v11H5zM12 3v3h3M7.5 10h5M7.5 13h5',
  link: 'M6.2 9.8 4.6 11.4a2.3 2.3 0 0 0 3.2 3.2l1.6-1.6M9.8 6.2l1.6-1.6a2.3 2.3 0 0 1 3.2 3.2l-1.6 1.6M7.6 12.4l4.8-4.8',
  reset: 'M4.6 8a5.6 5.6 0 1 1-.5 3.6M4.4 4.6V8h3.4',
} as const;

function Glyph({ d, size = 20 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

// ------------------------------------------------------------------ controls
/** Resolve's number box: drag sideways to change, click to type. */
function NumField({ value, onChange, step = 0.01, dec = 3, min = -Infinity, max = Infinity, label, disabled }: { value: number; onChange: (v: number) => void; step?: number; dec?: number; min?: number; max?: number; label: string; disabled?: boolean }) {
  const [edit, setEdit] = useState<string | null>(null);
  const drag = useRef<{ x: number; v: number; moved: boolean } | null>(null);
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const round = (v: number) => Number(v.toFixed(dec));
  if (edit !== null) {
    const done = (ok: boolean) => {
      const n = Number(edit.replace(',', '.'));
      if (ok && edit.trim() !== '' && Number.isFinite(n)) onChange(clamp(n));
      setEdit(null);
    };
    return (
      <input
        className="ri-num edit"
        autoFocus
        value={edit}
        aria-label={label}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setEdit(e.target.value)}
        onBlur={() => done(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') done(true);
          else if (e.key === 'Escape') done(false);
          e.stopPropagation();
        }}
      />
    );
  }
  return (
    <div
      className={`ri-num${disabled ? ' off' : ''}`}
      role="spinbutton"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuenow={value}
      aria-disabled={disabled}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        drag.current = { x: e.clientX, v: value, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
        st().startSlide();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        if (!d.moved && Math.abs(dx) < 3) return;
        d.moved = true;
        onChange(clamp(round(d.v + dx * step)));
      }}
      onPointerUp={() => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.moved) setEdit(value.toFixed(dec));
      }}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === 'Enter') setEdit(value.toFixed(dec));
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') onChange(clamp(round(value + (e.key === 'ArrowUp' ? 1 : -1) * step * 10)));
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {value.toFixed(dec)}
    </div>
  );
}

function RowSlider({ value, min, max, step, onChange, label, disabled }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; label: string; disabled?: boolean }) {
  return <input className="range ri-range" type="range" min={min} max={max} step={step} value={value} disabled={disabled} aria-label={label} onPointerDown={() => st().startSlide()} onChange={(e) => onChange(Number(e.target.value))} />;
}

/** Keyframe diamond: lit when there is a keyframe under the playhead. */
function KeyBtn({ on, armed, onClick, title, disabled }: { on?: boolean; armed?: boolean; onClick?: () => void; title?: string; disabled?: boolean }) {
  return (
    <button className={`ri-tool ri-key${on ? ' on' : armed ? ' armed' : ''}`} disabled={disabled} title={title ?? (on ? 'Tirar este keyframe' : 'Pôr keyframe aqui')} aria-label="Keyframe" aria-pressed={Boolean(on)} onClick={onClick}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
        <path d="M5 .8 9.2 5 5 9.2.8 5Z" fill="currentColor" />
      </svg>
    </button>
  );
}

function ResetBtn({ onClick, title = 'Repor' }: { onClick: () => void; title?: string }) {
  return (
    <button className="ri-tool" title={title} aria-label={title} onClick={onClick}>
      <Glyph d={G.reset} size={15} />
    </button>
  );
}

/** One parameter line: label on the right edge of its column, the controls, then keyframe and reset. */
function Row({ label, children, keyBtn, onReset }: { label: string; children: ReactNode; keyBtn?: ReactNode; onReset?: () => void }) {
  return (
    <div className="ri-row">
      <span className="ri-label">{label}</span>
      <div className="ri-ctl">{children}</div>
      <span className="ri-slot">{keyBtn}</span>
      <span className="ri-slot">{onReset && <ResetBtn onClick={onReset} />}</span>
    </div>
  );
}

/** Collapsible section. `on` lights the dot: the section has something other than its defaults. */
function Section({ id, title, on, open, onToggle, onReset, keyBtn, children }: { id: string; title: string; on?: boolean; open: boolean; onToggle: (id: string) => void; onReset?: () => void; keyBtn?: ReactNode; children: ReactNode }) {
  return (
    <section className={`ri-sec${open ? ' open' : ''}`} data-sec={id}>
      <header className="ri-sec-head">
        <span className={`ri-dot${on ? ' on' : ''}`} title={on ? 'Esta secção tem alterações' : 'Sem alterações'} aria-hidden />
        <button className="ri-sec-title" aria-expanded={open} onClick={() => onToggle(id)}>
          {title}
        </button>
        <span className="ri-slot">{keyBtn}</span>
        <span className="ri-slot">{onReset && <ResetBtn onClick={onReset} title={`Repor ${title}`} />}</span>
      </header>
      {open && <div className="ri-sec-body">{children}</div>}
    </section>
  );
}

/** A Resolve section the engine does not do yet: shown dimmed, in its place, and it does not open. */
function Unavailable({ title }: { title: string }) {
  return (
    <section className="ri-sec off" title={`${title}: ainda não existe no Cinemex`}>
      <header className="ri-sec-head">
        <span className="ri-dot" aria-hidden />
        <span className="ri-sec-title">{title}</span>
        <span className="ri-slot" />
        <span className="ri-slot" />
      </header>
    </section>
  );
}

// ------------------------------------------------------------------ animated properties (Resolve keyframe behaviour)
/** Properties where keyframing was switched on with the diamond, per clip (kept while the app is open). */
const armedProps = new Set<string>();
const LIMITS: Record<'zoom' | 'x' | 'y' | 'rotate' | 'opacity', [number, number]> = { zoom: [1, 4], x: [-0.5, 0.5], y: [-0.5, 0.5], rotate: [-180, 180], opacity: [0, 1] };
type Prop = keyof typeof LIMITS;

function useProp(clip: Clip, prop: Prop) {
  const playhead = useEditor((s) => s.playhead);
  const d = dur(clip);
  const local = Math.max(0, Math.min(d, playhead - clip.start));
  const list = clip.keyframes?.[prop as KeyProp];
  const value = kfValue(list, local, KEY_DEFAULT[prop as KeyProp]);
  const key = `${clip.id}:${prop}`;
  // One keyframe at the very start is just a fixed value; anything else means the property is animated.
  const armed = armedProps.has(key) || (list?.length ?? 0) >= 2 || (list?.length === 1 && list[0]!.t > 0.02);
  const here = armed ? list?.find((k) => Math.abs(k.t - local) < 0.02) : undefined;
  const [lo, hi] = LIMITS[prop];
  const set = (v: number) => {
    const val = r3(Math.max(lo, Math.min(hi, v)));
    if (armed) st().setKeyframe(clip.id, prop as KeyProp, clip.start + local, val);
    else
      st().commit((p) => {
        const f = findClip(p, clip.id);
        if (f) (f.clip.keyframes ??= {})[prop as KeyProp] = [{ t: 0, v: val }];
      });
  };
  const toggleKey = () => {
    if (here) st().removeKeyframe(clip.id, prop as KeyProp, here.t);
    else {
      armedProps.add(key);
      st().setKeyframe(clip.id, prop as KeyProp, clip.start + local, value);
    }
  };
  const reset = () => {
    armedProps.delete(key);
    st().commit((p) => {
      const f = findClip(p, clip.id);
      if (f?.clip.keyframes) delete f.clip.keyframes[prop as KeyProp];
    });
  };
  const changed = Boolean(list?.length) && (armed || Math.abs(value - KEY_DEFAULT[prop as KeyProp]) > 1e-6);
  return { value, set, toggleKey, reset, here: Boolean(here), armed, changed, count: list?.length ?? 0 };
}

const PRESETS: { k: MotionPreset; label: string }[] = [
  { k: 'zoom_in', label: 'Zoom in' },
  { k: 'zoom_out', label: 'Zoom out' },
  { k: 'ken_burns', label: 'Ken Burns' },
  { k: 'punch', label: 'Punch' },
  { k: 'shake', label: 'Tremer' },
  { k: 'pulse', label: 'Pulsar' },
  { k: 'spin_in', label: 'Entrar a rodar' },
  { k: 'fade_in_out', label: 'Aparecer / sumir' },
];

/** Recorte, as in Resolve: left, right, top and bottom in pixels of the frame, plus soft edges. */
function CropSection({ clip, open, toggle }: { clip: Clip; open: (id: string) => boolean; toggle: (id: string) => void }) {
  const canvas = useEditor((s) => s.project.canvas);
  const crop = cropOf(clip);
  const set = (patch: Partial<Crop>) =>
    st().commit((p) => {
      const f = findClip(p, clip.id);
      if (f) setCrop(f.clip, patch);
    });
  const sides: { k: 'left' | 'right' | 'top' | 'bottom'; label: string; px: number }[] = [
    { k: 'left', label: 'Recortar Esquerda', px: canvas.w },
    { k: 'right', label: 'Recortar Direita', px: canvas.w },
    { k: 'top', label: 'Recortar Cima', px: canvas.h },
    { k: 'bottom', label: 'Recortar Baixo', px: canvas.h },
  ];
  const any = sides.some((x) => crop[x.k] > 0) || crop.soft > 0;
  return (
    <Section id="crop" title="Recorte" on={any} open={open('crop')} onToggle={toggle} onReset={() => set({ left: 0, right: 0, top: 0, bottom: 0, soft: 0 })}>
      {sides.map((x) => (
        <Row key={x.k} label={x.label} onReset={() => set({ [x.k]: 0 })}>
          <RowSlider label={x.label} value={crop[x.k] * x.px} min={0} max={x.px} step={1} onChange={(v) => set({ [x.k]: v / x.px })} />
          <NumField label={`${x.label}, píxeis`} value={crop[x.k] * x.px} min={0} max={x.px} step={1} onChange={(v) => set({ [x.k]: v / x.px })} />
        </Row>
      ))}
      <Row label="Suavidade" onReset={() => set({ soft: 0 })}>
        <RowSlider label="Suavidade" value={crop.soft * 100} min={0} max={100} step={1} onChange={(v) => set({ soft: v / 100 })} />
        <NumField label="Suavidade" value={crop.soft * 100} min={0} max={100} step={1} dec={2} onChange={(v) => set({ soft: v / 100 })} />
      </Row>
    </Section>
  );
}

// ------------------------------------------------------------------ Vídeo
function VideoTab({ clip, media, open, toggle }: { clip: Clip; media: Media; open: (id: string) => boolean; toggle: (id: string) => void }) {
  const canvas = useEditor((s) => s.project.canvas);
  const zoom = useProp(clip, 'zoom');
  const x = useProp(clip, 'x');
  const y = useProp(clip, 'y');
  const rot = useProp(clip, 'rotate');
  const op = useProp(clip, 'opacity');
  const [preset, setPreset] = useState<MotionPreset>('zoom_in');
  const xform = [zoom, x, y, rot];
  const speed = speedOf(clip);
  const keyframes = Object.values(clip.keyframes ?? {}).reduce((n, l) => n + (l?.length ?? 0), 0);
  // Resolve moves the picture: X to the right and Y up are positive, in pixels of the timeline.
  // The engine moves the view instead (x/y are the centre of what is shown), so X flips sign.
  const posX = -x.value * canvas.w;
  const posY = y.value * canvas.h;
  return (
    <>
      <Section
        id="transform"
        title="Transformar"
        on={xform.some((p) => p.changed)}
        open={open('transform')}
        onToggle={toggle}
        onReset={() => xform.forEach((p) => p.reset())}
        keyBtn={<KeyBtn on={xform.every((p) => p.here)} armed={xform.some((p) => p.armed)} title="Keyframe em todos os parâmetros de Transformar" onClick={() => (xform.every((p) => p.here) ? xform.forEach((p) => p.here && p.toggleKey()) : xform.forEach((p) => !p.here && p.toggleKey()))} />}
      >
        <Row label="Zoom" keyBtn={<KeyBtn on={zoom.here} armed={zoom.armed} onClick={zoom.toggleKey} />} onReset={zoom.reset}>
          <span className="ri-axis">X</span>
          <NumField label="Zoom X" value={zoom.value} min={1} max={4} step={0.005} onChange={zoom.set} />
          <span className="ri-link on" title="X e Y ligados (o Cinemex faz zoom igual nos dois eixos)">
            <Glyph d={G.link} size={16} />
          </span>
          <span className="ri-axis">Y</span>
          <NumField label="Zoom Y" value={zoom.value} min={1} max={4} step={0.005} onChange={zoom.set} />
        </Row>
        <Row
          label="Posição"
          keyBtn={<KeyBtn on={x.here && y.here} armed={x.armed || y.armed} onClick={() => (x.here && y.here ? (x.toggleKey(), y.toggleKey()) : (!x.here && x.toggleKey(), !y.here && y.toggleKey()))} />}
          onReset={() => (x.reset(), y.reset())}
        >
          <span className="ri-axis">X</span>
          <NumField label="Posição X" value={posX} min={-canvas.w / 2} max={canvas.w / 2} step={1} onChange={(v) => x.set(-v / canvas.w)} />
          <span className="ri-link" />
          <span className="ri-axis">Y</span>
          <NumField label="Posição Y" value={posY} min={-canvas.h / 2} max={canvas.h / 2} step={1} onChange={(v) => y.set(v / canvas.h)} />
        </Row>
        <Row label="Ângulo de Rotação" keyBtn={<KeyBtn on={rot.here} armed={rot.armed} onClick={rot.toggleKey} />} onReset={rot.reset}>
          <RowSlider label="Ângulo de Rotação" value={rot.value} min={-180} max={180} step={0.1} onChange={rot.set} />
          <NumField label="Ângulo de Rotação" value={rot.value} min={-180} max={180} step={0.25} onChange={rot.set} />
        </Row>
        {zoom.value <= 1.001 && <p className="ri-note">A posição só mexe a imagem com Zoom acima de 1.000.</p>}
      </Section>

      <CropSection clip={clip} open={open} toggle={toggle} />

      <Section id="dynzoom" title="Zoom Dinâmico" on={keyframes > 0 && [zoom, x, y].some((p) => p.count >= 2)} open={open('dynzoom')} onToggle={toggle} onReset={() => st().clearKeyframes(clip.id)}>
        <Row label="Animação">
          <select className="select ri-select" value={preset} onChange={(e) => setPreset(e.target.value as MotionPreset)} aria-label="Animação pronta">
            {PRESETS.map((p) => (
              <option key={p.k} value={p.k}>
                {p.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="">
          <button className="btn sm ri-btn" onClick={() => st().animate(clip.id, preset)}>
            Aplicar
          </button>
          <button className="btn sm ri-btn" disabled={!keyframes} onClick={() => st().clearKeyframes(clip.id)}>
            Limpar ({keyframes})
          </button>
        </Row>
      </Section>

      <Section
        id="composite"
        title="Composição"
        on={op.changed || (clip.blend ?? 'normal') !== 'normal'}
        open={open('composite')}
        onToggle={toggle}
        onReset={() => (op.reset(), st().setBlend(clip.id, 'normal'))}
        keyBtn={<KeyBtn on={op.here} armed={op.armed} onClick={op.toggleKey} />}
      >
        <Row label="Modo" onReset={() => st().setBlend(clip.id, 'normal')}>
          <select className="select ri-select" value={clip.blend ?? 'normal'} onChange={(e) => st().setBlend(clip.id, e.target.value as BlendMode)} aria-label="Modo de Composição">
            {BLEND_MODES.map((b) => (
              <option key={b} value={b}>
                {BLEND_LABELS[b]}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Opacidade" keyBtn={<KeyBtn on={op.here} armed={op.armed} onClick={op.toggleKey} />} onReset={op.reset}>
          <RowSlider label="Opacidade" value={op.value * 100} min={0} max={100} step={0.5} onChange={(v) => op.set(v / 100)} />
          <NumField label="Opacidade" value={op.value * 100} min={0} max={100} step={0.5} dec={2} onChange={(v) => op.set(v / 100)} />
        </Row>
      </Section>

      {media.kind !== 'image' && (
        <Section id="speed" title="Alterar Velocidade" on={Math.abs(speed - 1) > 1e-6} open={open('speed')} onToggle={toggle} onReset={() => st().setSpeed(clip.id, 1)}>
          <Row label="Velocidade %" onReset={() => st().setSpeed(clip.id, 1)}>
            <RowSlider label="Velocidade" value={speed * 100} min={25} max={400} step={1} onChange={(v) => st().setSpeed(clip.id, v / 100)} />
            <NumField label="Velocidade %" value={speed * 100} min={25} max={400} step={1} dec={2} onChange={(v) => st().setSpeed(clip.id, v / 100)} />
          </Row>
          <Row label="Duração">
            <span className="ri-read">{dur(clip).toFixed(2)} s</span>
          </Row>
          {media.kind === 'video' && <Freeze clip={clip} />}
        </Section>
      )}

      <Unavailable title="Estabilização" />
      <Unavailable title="Correção de Lente" />

      <Section id="scaling" title="Retime e Escala" on={clip.fit === 'fit' || Boolean(clip.orient)} open={open('scaling')} onToggle={toggle} onReset={() => st().updateClip(clip.id, { fit: 'fill', orient: undefined })}>
        <Row label="Escala" onReset={() => st().updateClip(clip.id, { fit: 'fill' })}>
          <select className="select ri-select" value={clip.fit === 'fit' ? 'fit' : 'fill'} onChange={(e) => st().updateClip(clip.id, { fit: e.target.value as 'fill' | 'fit' })} aria-label="Escala">
            <option value="fill">Preencher (cortar)</option>
            <option value="fit">Ajustar (mostrar tudo)</option>
          </select>
        </Row>
        <Row label="Rodar a fonte" onReset={() => st().updateClip(clip.id, { orient: undefined })}>
          <div className="seg ri-seg">
            {([0, 90, 180, 270] as const).map((o) => (
              <button key={o} className={(clip.orient ?? 0) === o ? 'on' : ''} onClick={() => st().updateClip(clip.id, { orient: o || undefined })}>
                {o}°
              </button>
            ))}
          </div>
        </Row>
      </Section>

      <Section id="ease" title="Interpolação dos Keyframes" on={false} open={open('ease')} onToggle={toggle}>
        <EaseCard clip={clip} />
      </Section>
      <Section id="expr" title="Expressões" on={Boolean(clip.mods && Object.keys(clip.mods).length)} open={open('expr')} onToggle={toggle}>
        <ExpressionsCard clip={clip} />
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ Áudio
const toDb = (v: number) => (v <= 0.00001 ? -100 : 20 * Math.log10(v));
const fromDb = (db: number) => (db <= -99.5 ? 0 : Math.pow(10, db / 20));

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

function AudioTab({ clip, open, toggle }: { clip: Clip; open: (id: string) => boolean; toggle: (id: string) => void }) {
  const busy = useEditor((s) => s.busy);
  const vol = clip.volume ?? 1;
  const setVol = (v: number) => st().updateClip(clip.id, { volume: r3(Math.max(0, Math.min(2, v))) });
  return (
    <>
      <Section id="volume" title="Volume" on={Math.abs(vol - 1) > 1e-6} open={open('volume')} onToggle={toggle} onReset={() => setVol(1)}>
        <Row label="Volume" onReset={() => setVol(1)}>
          <RowSlider label="Volume" value={vol} min={0} max={2} step={0.01} onChange={setVol} />
          <NumField label="Volume em dB" value={Number(toDb(vol).toFixed(2))} min={-100} max={6.02} step={0.1} dec={2} onChange={(db) => setVol(fromDb(db))} />
        </Row>
        <p className="ri-note">Em dB: 0.00 = volume original, +6.02 = o dobro, -100 = mudo.</p>
      </Section>
      <Section id="captions" title="Legendas Automáticas" on={false} open={open('captions')} onToggle={toggle}>
        <CaptionsCard clipId={clip.id} />
      </Section>
      <Section id="silences" title="Cortar Pausas" on={false} open={open('silences')} onToggle={toggle}>
        <div className="card">
          <h4>Cortar pausas</h4>
          <p>Tira os silêncios entre frases (jump cuts) e junta o resto, pela transcrição.</p>
          <button className="btn" style={{ width: '100%' }} disabled={busy} onClick={() => void cutSilences(clip.id).catch((e) => st().setStatus((e as Error).message))}>
            <Icon name="scissors" /> Cortar pausas
          </button>
        </div>
      </Section>
    </>
  );
}

// ------------------------------------------------------------------ Ficheiro
function FileTab({ clip, media, open, toggle }: { clip: Clip; media?: Media; open: (id: string) => boolean; toggle: (id: string) => void }) {
  return (
    <>
      <Section id="timing" title="Clip na Timeline" on open={open('timing')} onToggle={toggle}>
        <Row label="Início">
          <NumField label="Início na timeline, segundos" value={clip.start} min={0} step={0.02} dec={2} onChange={(v) => st().moveClip(clip.id, v)} />
          <span className="ri-unit">s</span>
        </Row>
        <Row label="Duração">
          <NumField label="Duração, segundos" value={dur(clip)} min={0.1} step={0.02} dec={2} onChange={(v) => st().trimClip(clip.id, { out: clip.in + Math.max(0.1, v) * (clip.speed ?? 1) })} />
          <span className="ri-unit">s</span>
        </Row>
        {media && media.kind !== 'image' && (
          <>
            <Row label="Entrada">
              <span className="ri-read">{clip.in.toFixed(2)} s</span>
            </Row>
            <Row label="Saída">
              <span className="ri-read">{clip.out.toFixed(2)} s</span>
            </Row>
          </>
        )}
      </Section>
      {media && (
        <Section id="fileinfo" title="Ficheiro" on open={open('fileinfo')} onToggle={toggle}>
          <Row label="Nome">
            <span className="ri-read" title={media.name}>
              {media.name}
            </span>
          </Row>
          <Row label="Tipo">
            <span className="ri-read">{media.kind === 'video' ? 'Vídeo' : media.kind === 'audio' ? 'Áudio' : 'Imagem'}</span>
          </Row>
          {media.kind !== 'audio' && (
            <Row label="Resolução">
              <span className="ri-read">
                {media.width} × {media.height}
              </span>
            </Row>
          )}
          {media.kind === 'video' && (
            <Row label="Fotogramas/s">
              <span className="ri-read">{Number(media.fps.toFixed(3))}</span>
            </Row>
          )}
          {media.kind !== 'image' && (
            <Row label="Duração">
              <span className="ri-read">{fmtShort(media.duration)}</span>
            </Row>
          )}
          <Row label="Caminho">
            {/* Cut at the start (the end is what tells files apart); the mark keeps the first "/" in its place. */}
            <span className="ri-read path" title={media.path}>
              {'\u200e' + media.path}
            </span>
          </Row>
        </Section>
      )}
    </>
  );
}

// ------------------------------------------------------------------ the panel
type Tab = 'video' | 'audio' | 'effects' | 'transition' | 'image' | 'file';
const TABS: { id: Tab; label: string; d: string }[] = [
  { id: 'video', label: 'Vídeo', d: G.video },
  { id: 'audio', label: 'Áudio', d: G.audio },
  { id: 'effects', label: 'Efeitos', d: G.effects },
  { id: 'transition', label: 'Transição', d: G.transition },
  { id: 'image', label: 'Imagem', d: G.image },
  { id: 'file', label: 'Ficheiro', d: G.file },
];
/** Sections open the first time, like a fresh Resolve project (the rest open with a click). */
const OPEN_DEFAULT = new Set(['transform', 'crop', 'dynzoom', 'composite', 'speed', 'scaling', 'volume', 'timing', 'fileinfo', 'title', 'graphic', 'project', 'captions0', 'text0', 'transitions', 'effects', 'masks']);

export function Inspector({ initialTab = 'video' }: { initialTab?: Tab } = {}) {
  const styleOptions = useStyleOptions();
  const userStyles = useEditor((s) => s.userStyles);
  const selected = useEditor((s) => s.selected);
  const project = useEditor((s) => s.project);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [openSet, setOpenSet] = useState<Set<string>>(OPEN_DEFAULT);
  const open = (id: string) => openSet.has(id);
  const toggle = (id: string) =>
    setOpenSet((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });
  const f = selected ? findClip(project, selected) : null;

  if (!f) {
    return (
      <aside className="panel rinsp" aria-label="Inspetor">
        <div className="ri-head">
          <span className="ri-name">Timeline · {project.name}</span>
        </div>
        <div className="ri-body">
          <Section id="project" title="Projeto" on open={open('project')} onToggle={toggle}>
            <Row label="Duração">
              <span className="ri-read">{fmtShort(projectDuration(project))}</span>
            </Row>
            <Row label="Clips">
              <span className="ri-read">{project.tracks.reduce((n, t) => n + t.clips.length, 0)}</span>
            </Row>
            <Row label="Formato">
              <span className="ri-read">
                {project.canvas.w} × {project.canvas.h} · {project.canvas.fps} fps
              </span>
            </Row>
            <p className="ri-note">Seleciona um clip na timeline para o inspecionar.</p>
          </Section>
          <Section id="captions0" title="Legendas Automáticas" on={false} open={open('captions0')} onToggle={toggle}>
            <CaptionsCard />
          </Section>
          <Section id="text0" title="Texto" on={false} open={open('text0')} onToggle={toggle}>
            <div className="card">
              <h4>Texto</h4>
              <p>Um título no ponto onde está a cabeça de leitura.</p>
              <button className="btn" style={{ width: '100%' }} onClick={() => st().addText('Cinemex', st().playhead, 3, 'title')}>
                <Icon name="text" /> Acrescentar texto
              </button>
            </div>
          </Section>
        </div>
      </aside>
    );
  }

  const { clip, track } = f;
  const m = project.media.find((x) => x.id === clip.mediaId);
  const isText = track.kind === 'text';
  const isAudio = m?.kind === 'audio';
  const usable: Record<Tab, boolean> = {
    video: !isAudio,
    audio: Boolean(m?.hasAudio),
    effects: Boolean(m) && !isAudio && !isText,
    transition: Boolean(m) && !isText,
    image: false,
    file: true,
  };
  const current: Tab = usable[tab] ? tab : usable.video ? 'video' : usable.audio ? 'audio' : 'file';
  const name = clip.graphic ? 'Grafismo' : isText ? clip.text || 'Texto' : (m?.name ?? 'Clip');

  return (
    <aside className="panel rinsp" aria-label="Inspetor">
      <div className="ri-head">
        <span className="ri-name" title={name}>
          {name}
        </span>
        <button className="ri-tool" title="Apagar (Delete)" aria-label="Apagar" onClick={() => st().deleteClip(clip.id)}>
          <Icon name="trash" />
        </button>
      </div>
      <div className="ri-tabs" role="tablist" aria-label="Separadores do Inspetor">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={current === t.id} className={current === t.id ? 'on' : ''} disabled={!usable[t.id]} onClick={() => setTab(t.id)}>
            <Glyph d={t.d} />
            <span>{t.id === 'video' && isText ? 'Título' : t.label}</span>
          </button>
        ))}
      </div>
      <div className="ri-body" key={`${clip.id}:${current}`}>
        {current === 'video' &&
          (clip.graphic ? (
            <Section id="graphic" title="Grafismo" on open={open('graphic')} onToggle={toggle}>
              <div className="ri-pad">
                <GraphicInspector clip={clip} />
              </div>
            </Section>
          ) : isText ? (
            <Section id="title" title="Texto" on open={open('title')} onToggle={toggle}>
              <div className="ri-pad">
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
              </div>
            </Section>
          ) : (
            m && <VideoTab clip={clip} media={m} open={open} toggle={toggle} />
          ))}
        {current === 'audio' && <AudioTab clip={clip} open={open} toggle={toggle} />}
        {current === 'effects' && (
          <>
            <Section id="effects" title="Efeitos de Camada" on={Boolean(clip.effects?.length)} open={open('effects')} onToggle={toggle}>
              <EffectsCard clip={clip} />
            </Section>
            <Section id="masks" title="Máscaras" on={Boolean(clip.masks?.some((mk) => mk.id !== CROP_ID))} open={open('masks')} onToggle={toggle}>
              <Masks clip={clip} />
            </Section>
            <Section id="matte" title="Track Matte" on={Boolean(clip.matte)} open={open('matte')} onToggle={toggle} onReset={() => st().setMatte(clip.id, null)}>
              <CompositeCard clip={clip} />
            </Section>
          </>
        )}
        {current === 'transition' && (
          <Section id="transitions" title="Transições" on={Boolean(clip.transitionIn || clip.transitionOut)} open={open('transitions')} onToggle={toggle} onReset={() => (st().setTransition(clip.id, 'in', null), st().setTransition(clip.id, 'out', null))}>
            <Transitions clip={clip} />
          </Section>
        )}
        {current === 'file' && <FileTab clip={clip} media={m} open={open} toggle={toggle} />}
      </div>
    </aside>
  );
}
