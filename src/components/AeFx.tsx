// Inspector cards for the After Effects features: keyframe interpolation, expressions (wiggle, loop,
// overshoot), blend mode + track matte, and the effect stack.
import { useEditor } from '../store';
import { dur } from '../lib/project';
import { EASES, EASE_LABELS } from '../lib/anim.js';
import { BLEND_LABELS, BLEND_MODES, EFFECT_LABELS, EFFECT_TYPES, STROKE_POSITIONS } from '../lib/layerfx.js';
import { BLENDIF_OFF } from '../lib/pslayer.js';
import type { Clip, Effect, KeyProp, Matte, Modifier } from '../types';
import { Icon } from './Icon';

const st = useEditor.getState;
const fail = (e: unknown) => st().setStatus((e as Error).message);
const PROPS: { k: KeyProp; label: string; amp: number; step: number }[] = [
  { k: 'zoom', label: 'Zoom', amp: 0.05, step: 0.005 },
  { k: 'x', label: 'Posição horizontal', amp: 0.02, step: 0.002 },
  { k: 'y', label: 'Posição vertical', amp: 0.02, step: 0.002 },
  { k: 'rotate', label: 'Rotação', amp: 3, step: 0.5 },
  { k: 'opacity', label: 'Opacidade', amp: 0.2, step: 0.01 },
];

function Slider({ label, value, min, max, step, onChange, fmt }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt?: (v: number) => string }) {
  return (
    <div className="field">
      <label className="row-label">
        <span>{label}</span>
        <b className="val">{fmt ? fmt(value) : Math.round(value * 100) / 100}</b>
      </label>
      <input className="range" type="range" min={min} max={max} step={step} value={value} onPointerDown={() => st().startSlide()} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function Colour({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} aria-label={label} />
    </div>
  );
}

/** Interpolation of the keyframes under the playhead. */
export function EaseCard({ clip }: { clip: Clip }) {
  const playhead = useEditor((s) => s.playhead);
  const local = playhead - clip.start;
  const here = Object.values(clip.keyframes ?? {}).flatMap((l) => (l ?? []).filter((k) => Math.abs(k.t - local) <= 0.04));
  if (!here.length) return null;
  const cur = here[0]!.ease ?? 'smooth';
  const bz = here[0]!.bz ?? [0.25, 0.1, 0.25, 1];
  const set = (ease: (typeof EASES)[number], b?: [number, number, number, number]) => {
    try {
      st().setKeyframeEase(clip.id, null, playhead, ease, b);
    } catch (e) {
      fail(e);
    }
  };
  return (
    <div className="card">
      <h4>Interpolação · como no After Effects</h4>
      <p>Como o keyframe sob a cabeça de leitura chega ao seguinte ({here.length} {here.length === 1 ? 'keyframe' : 'keyframes'}).</p>
      <div className="seg grid" style={{ gridAutoFlow: 'row', gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {EASES.map((e) => (
          <button key={e} className={cur === e ? 'on' : ''} onClick={() => set(e, e === 'bezier' ? bz : undefined)}>
            {EASE_LABELS[e]}
          </button>
        ))}
      </div>
      {cur === 'bezier' && (
        <div className="row" style={{ gap: 4 }}>
          {bz.map((v, i) => (
            <input key={i} className="input" type="number" step={0.05} value={v} aria-label={`Ponto ${i + 1}`} onChange={(ev) => set('bezier', bz.map((x, j) => (j === i ? Number(ev.target.value) : x)) as [number, number, number, number])} />
          ))}
        </div>
      )}
    </div>
  );
}

/** wiggle / loopOut / overshoot per property. */
export function ExpressionsCard({ clip }: { clip: Clip }) {
  const setMod = (k: KeyProp, m: Modifier | null) => st().setModifier(clip.id, k, m);
  return (
    <div className="card">
      <h4>Expressões · wiggle, loop, overshoot</h4>
      <p>Movimento automático por cima dos keyframes, como as expressões do After Effects.</p>
      {PROPS.map((p) => {
        const m = clip.mods?.[p.k];
        return (
          <div className="mask" key={p.k}>
            <div className="row-label">
              <b>{p.label}</b>
            </div>
            <div className="seg">
              <button className={!m ? 'on' : ''} onClick={() => setMod(p.k, null)}>
                Nada
              </button>
              <button className={m?.type === 'wiggle' ? 'on' : ''} onClick={() => setMod(p.k, { type: 'wiggle', freq: 2, amp: p.amp })}>
                Wiggle
              </button>
              <button className={m?.type === 'loop' ? 'on' : ''} onClick={() => setMod(p.k, { type: 'loop', mode: 'cycle' })}>
                Loop
              </button>
              <button className={m?.type === 'overshoot' ? 'on' : ''} onClick={() => setMod(p.k, { type: 'overshoot', amp: 0.25, freq: 3, decay: 6 })}>
                Overshoot
              </button>
            </div>
            {m?.type === 'wiggle' && (
              <>
                <Slider label="Frequência (por segundo)" value={m.freq} min={0.2} max={12} step={0.1} onChange={(v) => setMod(p.k, { ...m, freq: v })} />
                <Slider label="Amplitude" value={m.amp} min={0} max={p.amp * 6} step={p.step} onChange={(v) => setMod(p.k, { ...m, amp: v })} />
              </>
            )}
            {m?.type === 'loop' && (
              <div className="seg">
                <button className={m.mode === 'cycle' ? 'on' : ''} onClick={() => setMod(p.k, { type: 'loop', mode: 'cycle' })}>
                  Repetir
                </button>
                <button className={m.mode === 'pingpong' ? 'on' : ''} onClick={() => setMod(p.k, { type: 'loop', mode: 'pingpong' })}>
                  Ping-pong
                </button>
              </div>
            )}
            {m?.type === 'overshoot' && (
              <>
                <Slider label="Força" value={m.amp} min={0} max={1} step={0.01} onChange={(v) => setMod(p.k, { ...m, amp: v })} />
                <Slider label="Oscilações por segundo" value={m.freq} min={0.5} max={10} step={0.1} onChange={(v) => setMod(p.k, { ...m, freq: v })} />
                <Slider label="Amortecimento" value={m.decay} min={0.5} max={20} step={0.5} onChange={(v) => setMod(p.k, { ...m, decay: v })} />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Blend mode and track matte. */
export function CompositeCard({ clip }: { clip: Clip }) {
  const media = useEditor((s) => s.project.media);
  const m = clip.matte;
  const setM = (x: Matte | null) => st().setMatte(clip.id, x);
  return (
    <div className="card">
      <h4>Composição · blend e track matte</h4>
      <div className="field">
        <label>Modo de blend</label>
        <select className="select" value={clip.blend ?? 'normal'} onChange={(e) => st().setBlend(clip.id, e.target.value as (typeof BLEND_MODES)[number])}>
          {BLEND_MODES.map((b) => (
            <option key={b} value={b}>
              {BLEND_LABELS[b]}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Track matte</label>
        <div className="seg">
          <button className={!m ? 'on' : ''} onClick={() => setM(null)}>
            Nenhum
          </button>
          <button className={m?.kind === 'text' ? 'on' : ''} onClick={() => setM({ kind: 'text', text: 'BENFICA', size: 0.22, y: 0.5 })}>
            Texto
          </button>
          <button className={m?.kind === 'media' ? 'on' : ''} onClick={() => media[0] && setM({ kind: 'media', mediaId: media.find((x) => x.kind === 'image')?.id ?? media[0]!.id, mode: 'alpha' })}>
            Média
          </button>
        </div>
      </div>
      {m?.kind === 'text' && (
        <>
          <div className="field">
            <label>Texto (o vídeo aparece dentro das letras)</label>
            <input className="input" key={clip.id} defaultValue={m.text} onBlur={(e) => setM({ ...m, text: e.target.value })} />
          </div>
          <Slider label="Tamanho" value={m.size ?? 0.22} min={0.05} max={0.6} step={0.005} onChange={(v) => setM({ ...m, size: v })} />
          <Slider label="Posição vertical" value={m.y ?? 0.5} min={0} max={1} step={0.005} onChange={(v) => setM({ ...m, y: v })} />
        </>
      )}
      {m?.kind === 'media' && (
        <>
          <div className="field">
            <label>Ficheiro do matte</label>
            <select className="select" value={m.mediaId} onChange={(e) => setM({ ...m, mediaId: e.target.value })}>
              {media.filter((x) => x.kind !== 'audio').map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </div>
          <div className="seg">
            <button className={m.mode === 'alpha' ? 'on' : ''} onClick={() => setM({ ...m, mode: 'alpha' })}>
              Alpha
            </button>
            <button className={m.mode === 'luma' ? 'on' : ''} onClick={() => setM({ ...m, mode: 'luma' })}>
              Luma
            </button>
          </div>
        </>
      )}
      {m && (
        <label className="check">
          <input type="checkbox" checked={Boolean(m.invert)} onChange={(e) => setM({ ...m, invert: e.target.checked })} />
          <span>Inverter (mostrar fora do matte)</span>
        </label>
      )}
      <BlendIfFields clip={clip} />
      <ColorToAlphaFields clip={clip} />
    </div>
  );
}

type Range = [number, number, number, number];
const BIF_LABELS = ['Pretos de', 'Pretos até', 'Brancos de', 'Brancos até'];

/** Blend If (Photoshop): soft grey ranges of this layer and of what is under it. */
function BlendIfFields({ clip }: { clip: Clip }) {
  const b = clip.blendIf;
  const t: Range = b?.this ?? [...BLENDIF_OFF] as Range;
  const u: Range = b?.under ?? [...BLENDIF_OFF] as Range;
  const set = (which: 'this' | 'under', i: number, v: number) => {
    const next: Range = [...(which === 'this' ? t : u)] as Range;
    next[i] = v;
    // keep the pairs in order while dragging
    if (i === 1 && next[1] < next[0]) next[0] = next[1];
    if (i === 0 && next[0] > next[1]) next[1] = next[0];
    if (i === 2 && next[2] > next[3]) next[3] = next[2];
    if (i === 3 && next[3] < next[2]) next[2] = next[3];
    st().setBlendIf(clip.id, { this: which === 'this' ? next : t, under: which === 'under' ? next : u });
  };
  return (
    <div className="mask">
      <div className="row-label">
        <b>Misturar se (Blend If)</b>
        {b && (
          <button className="btn sm" onClick={() => st().setBlendIf(clip.id, null)}>
            Repor
          </button>
        )}
      </div>
      <p>Esconde as partes escuras ou claras desta camada ou de baixo, com transição suave (fumo, fogo e luzes em fundo preto; texto atrás do céu).</p>
      {(['this', 'under'] as const).map((w) => (
        <div key={w}>
          <div className="row-label">
            <span>{w === 'this' ? 'Esta camada' : 'Camada subjacente'}</span>
          </div>
          {(w === 'this' ? t : u).map((v, i) => (
            <Slider key={i} label={BIF_LABELS[i]!} value={v} min={0} max={255} step={1} onChange={(x) => set(w, i, x)} fmt={(x) => String(Math.round(x))} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Color to Alpha (Photoshop): removes a colour, keeping the rest exact. */
function ColorToAlphaFields({ clip }: { clip: Clip }) {
  const c = clip.colorToAlpha;
  return (
    <div className="mask">
      <label className="check">
        <input type="checkbox" checked={Boolean(c)} onChange={(e) => st().setColorToAlpha(clip.id, e.target.checked ? { color: '#000000' } : null)} />
        <span>Cor para alfa (tirar o fundo preto ou branco de efeitos)</span>
      </label>
      {c && (
        <>
          <Colour label="Cor a remover" value={c.color} onChange={(v) => st().setColorToAlpha(clip.id, { ...c, color: v })} />
          <Slider label="Limiar de transparência" value={c.threshold ?? 0} min={0} max={0.9} step={0.01} onChange={(v) => st().setColorToAlpha(clip.id, { ...c, threshold: v })} />
        </>
      )}
    </div>
  );
}

function EffectRow({ clip, e }: { clip: Clip; e: Effect }) {
  const up = (patch: Record<string, unknown>) => st().updateEffect(clip.id, e.id, patch);
  return (
    <div className="mask">
      <div className="row-label">
        <b>{EFFECT_LABELS[e.type]}</b>
        <button className="btn icon sm" title="Apagar efeito" onClick={() => st().removeEffect(clip.id, e.id)}>
          <Icon name="trash" />
        </button>
      </div>
      {e.type === 'shadow' && (
        <>
          <Colour label="Cor" value={e.color} onChange={(v) => up({ color: v })} />
          <Slider label="Opacidade" value={e.opacity} min={0} max={1} step={0.01} onChange={(v) => up({ opacity: v })} />
          <Slider label="Distância" value={e.distance} min={0} max={0.1} step={0.001} onChange={(v) => up({ distance: v })} />
          <Slider label="Direção (°)" value={e.angle} min={0} max={360} step={1} onChange={(v) => up({ angle: v })} fmt={(v) => `${Math.round(v)}°`} />
          <Slider label="Suavidade" value={e.softness} min={0} max={0.06} step={0.001} onChange={(v) => up({ softness: v })} />
        </>
      )}
      {e.type === 'glow' && (
        <>
          <Slider label="Raio" value={e.radius} min={0.002} max={0.1} step={0.001} onChange={(v) => up({ radius: v })} />
          <Slider label="Intensidade" value={e.intensity} min={0} max={1} step={0.01} onChange={(v) => up({ intensity: v })} />
        </>
      )}
      {e.type === 'sweep' && (
        <>
          <Colour label="Cor da luz" value={e.color} onChange={(v) => up({ color: v })} />
          <Slider label="Ângulo (°)" value={e.angle} min={-90} max={90} step={1} onChange={(v) => up({ angle: v })} fmt={(v) => `${Math.round(v)}°`} />
          <Slider label="Largura" value={e.width} min={0.02} max={0.5} step={0.005} onChange={(v) => up({ width: v })} />
          <Slider label="Intensidade" value={e.intensity} min={0} max={1.5} step={0.01} onChange={(v) => up({ intensity: v })} />
          <Slider label="Começa (s)" value={e.start} min={0} max={Math.max(0.1, dur(clip))} step={0.05} onChange={(v) => up({ start: v })} />
          <Slider label="Duração (s)" value={e.duration} min={0.1} max={Math.max(0.2, dur(clip))} step={0.05} onChange={(v) => up({ duration: v })} />
        </>
      )}
      {e.type === 'stroke' && (
        <>
          <Colour label="Cor" value={e.color} onChange={(v) => up({ color: v })} />
          <Slider label="Tamanho" value={e.size} min={0.001} max={0.04} step={0.0005} onChange={(v) => up({ size: v })} />
          <div className="seg">
            {STROKE_POSITIONS.map((p) => (
              <button key={p} className={e.position === p ? 'on' : ''} onClick={() => up({ position: p })}>
                {{ outside: 'Fora', inside: 'Dentro', center: 'Centro' }[p]}
              </button>
            ))}
          </div>
          <Slider label="Opacidade" value={e.opacity} min={0} max={1} step={0.01} onChange={(v) => up({ opacity: v })} />
        </>
      )}
      {e.type === 'innerShadow' && (
        <>
          <Colour label="Cor" value={e.color} onChange={(v) => up({ color: v })} />
          <Slider label="Opacidade" value={e.opacity} min={0} max={1} step={0.01} onChange={(v) => up({ opacity: v })} />
          <Slider label="Distância" value={e.distance} min={0} max={0.05} step={0.001} onChange={(v) => up({ distance: v })} />
          <Slider label="Direção (°)" value={e.angle} min={0} max={360} step={1} onChange={(v) => up({ angle: v })} fmt={(v) => `${Math.round(v)}°`} />
          <Slider label="Suavidade" value={e.softness} min={0} max={0.06} step={0.001} onChange={(v) => up({ softness: v })} />
        </>
      )}
      {(e.type === 'outerGlow' || e.type === 'innerGlow') && (
        <>
          <Colour label="Cor" value={e.color} onChange={(v) => up({ color: v })} />
          <Slider label="Opacidade" value={e.opacity} min={0} max={1} step={0.01} onChange={(v) => up({ opacity: v })} />
          <Slider label="Tamanho" value={e.size} min={0.002} max={0.1} step={0.001} onChange={(v) => up({ size: v })} />
          <Slider label="Expansão" value={e.spread} min={0} max={1} step={0.25} onChange={(v) => up({ spread: v })} />
        </>
      )}
      {e.type === 'gradient' && (
        <>
          <Colour label="Cor inicial" value={e.c0} onChange={(v) => up({ c0: v })} />
          <Colour label="Cor final" value={e.c1} onChange={(v) => up({ c1: v })} />
          <Slider label="Opacidade" value={e.opacity} min={0} max={1} step={0.01} onChange={(v) => up({ opacity: v })} />
          <Slider label="Início vertical" value={e.y0} min={0} max={1} step={0.01} onChange={(v) => up({ y0: v })} />
          <Slider label="Fim vertical" value={e.y1} min={0} max={1} step={0.01} onChange={(v) => up({ y1: v })} />
        </>
      )}
    </div>
  );
}

/** Effect stack (applied top to bottom, before the matte). */
export function EffectsCard({ clip }: { clip: Clip }) {
  return (
    <div className="card">
      <h4>Efeitos · como no After Effects</h4>
      <p>Aplicam-se pela ordem, antes do track matte e do blend.</p>
      <div className="seg grid" style={{ gridAutoFlow: 'row', gridTemplateColumns: '1fr 1fr', marginBottom: 6 }}>
        {EFFECT_TYPES.map((t) => (
          <button key={t} onClick={() => {
            try {
              st().addEffect(clip.id, t);
            } catch (e) {
              fail(e);
            }
          }}>
            + {EFFECT_LABELS[t]}
          </button>
        ))}
      </div>
      {(clip.effects ?? []).map((e) => (
        <EffectRow key={e.id} clip={clip} e={e} />
      ))}
    </div>
  );
}
