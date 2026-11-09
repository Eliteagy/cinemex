// Inspector for graphic clips (lower third, title, label, progress bar).
import { useEditor } from '../store';
import { GRAPHICS, GRAPHIC_KINDS, graphicOf } from '../lib/graphics.js';
import type { Clip, Graphic } from '../types';

const st = useEditor.getState;
const SWATCHES = ['#D4AF37', '#FFFFFF', '#111111', '#83163A', '#5FBEF8', '#30D158'];

function Colour({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="row" style={{ marginTop: 0, gap: 6, flexWrap: 'wrap' }}>
        {SWATCHES.map((c) => (
          <button key={c} className={`gfx-swatch${c === value ? ' on' : ''}`} style={{ background: c }} title={c} aria-label={c} onClick={() => onChange(c)} />
        ))}
        <input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} aria-label={label} />
      </div>
    </div>
  );
}

export function GraphicInspector({ clip }: { clip: Clip }) {
  const g = graphicOf(clip.graphic);
  const set = (patch: Partial<Graphic>) => st().updateGraphic(clip.id, patch);
  return (
    <>
      <div className="field">
        <label>Tipo</label>
        <div className="seg grid" style={{ gridAutoFlow: 'row', gridTemplateColumns: '1fr 1fr' }}>
          {GRAPHIC_KINDS.map((k) => (
            <button key={k} className={g.kind === k ? 'on' : ''} onClick={() => set({ kind: k, x: undefined, y: undefined })}>
              {GRAPHICS[k].label}
            </button>
          ))}
        </div>
      </div>
      {g.kind !== 'progress' && (
        <div className="field">
          <label>Texto</label>
          <input className="input" key={`${clip.id}t`} defaultValue={g.title} onBlur={(e) => e.target.value !== g.title && set({ title: e.target.value })} />
        </div>
      )}
      {(g.kind === 'lower' || g.kind === 'title') && (
        <div className="field">
          <label>Segunda linha</label>
          <input className="input" key={`${clip.id}s`} defaultValue={g.subtitle} placeholder="(nenhuma)" onBlur={(e) => e.target.value !== g.subtitle && set({ subtitle: e.target.value })} />
        </div>
      )}
      <Colour label="Destaque" value={g.accent} onChange={(accent) => set({ accent })} />
      {g.kind !== 'progress' && <Colour label="Texto" value={g.kind === 'label' ? g.dark : g.color} onChange={(c) => set(g.kind === 'label' ? { dark: c } : { color: c })} />}
      {g.kind === 'lower' && <Colour label="Caixa" value={g.dark} onChange={(dark) => set({ dark })} />}
      <div className="field">
        <label className="row-label">
          <span>Tamanho</span>
          <b className="val">{Math.round(g.scale * 100)}%</b>
        </label>
        <input className="range" type="range" min={0.4} max={2.5} step={0.05} value={g.scale} onPointerDown={() => st().startSlide()} onChange={(e) => set({ scale: Number(e.target.value) })} />
      </div>
      {g.kind !== 'progress' && (
        <div className="field">
          <label className="row-label">
            <span>Posição horizontal</span>
            <b className="val">{Math.round(g.x * 100)}%</b>
          </label>
          <input className="range" type="range" min={0} max={1} step={0.005} value={g.x} onPointerDown={() => st().startSlide()} onChange={(e) => set({ x: Number(e.target.value) })} />
        </div>
      )}
      <div className="field">
        <label className="row-label">
          <span>Posição vertical</span>
          <b className="val">{Math.round(g.y * 100)}%</b>
        </label>
        <input className="range" type="range" min={0} max={1} step={0.005} value={g.y} onPointerDown={() => st().startSlide()} onChange={(e) => set({ y: Number(e.target.value) })} />
      </div>
    </>
  );
}
