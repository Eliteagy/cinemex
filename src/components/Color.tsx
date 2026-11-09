// "Cor" page: looks and scopes on the left, the grade of the current clip on the right.
// The grade is previewed live on the canvas and rendered by ffmpeg on export (render.cjs).
import { useEffect, useRef } from 'react';
import { useEditor } from '../store';
import { LOOKS, activeClip, findClip, gradeMath } from '../lib/project';
import type { Clip, Grade } from '../types';
import { Icon } from './Icon';

/** The clip being graded: the selected video clip, or the one under the playhead. */
export function useGradeTarget(): Clip | null {
  return useEditor((s) => {
    const sel = s.selected ? findClip(s.project, s.selected) : null;
    if (sel && sel.track.kind === 'video' && sel.clip.mediaId) return sel.clip;
    for (const t of [...s.project.tracks].reverse()) if (t.kind === 'video' && !t.hidden) {
      const c = activeClip(t, s.playhead);
      if (c?.mediaId) return c;
    }
    return null;
  });
}

const cssFilter = (g: Grade) => {
  const m = gradeMath(g);
  return `brightness(${m.bright}) contrast(${m.contrast}) saturate(${m.saturation})`;
};
const tint = (g: Grade) => {
  const m = gradeMath(g);
  return `rgb(${m.warm.map((w) => Math.round(w * 255)).join(',')})`;
};

/** RGB histogram of the preview frame (refreshed 4× per second). */
function Scope() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const work = document.createElement('canvas');
    work.width = 160;
    work.height = 90;
    const wctx = work.getContext('2d', { willReadFrequently: true })!;
    const id = setInterval(() => {
      const src = document.querySelector<HTMLCanvasElement>('.stage canvas');
      const c = ref.current;
      if (!src || !c || !src.width) return;
      wctx.drawImage(src, 0, 0, work.width, work.height);
      const px = wctx.getImageData(0, 0, work.width, work.height).data;
      const bins = [new Uint32Array(64), new Uint32Array(64), new Uint32Array(64)];
      for (let i = 0; i < px.length; i += 4) for (let ch = 0; ch < 3; ch++) bins[ch]![px[i + ch]! >> 2]!++;
      const ctx = c.getContext('2d')!;
      const W = (c.width = c.clientWidth * 2);
      const H = (c.height = c.clientHeight * 2);
      ctx.clearRect(0, 0, W, H);
      // Ignore the pure-black bin so letterboxing does not flatten the graph.
      const top = Math.max(1, ...bins.flatMap((b) => [...b.slice(1)]));
      ctx.globalCompositeOperation = 'lighter';
      ['#ff4d4d', '#4dff6a', '#4d8dff'].forEach((col, ch) => {
        ctx.fillStyle = col;
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        ctx.moveTo(0, H);
        bins[ch]!.forEach((v, i) => ctx.lineTo((i / 63) * W, H - Math.min(1, v / top) * (H - 4)));
        ctx.lineTo(W, H);
        ctx.fill();
      });
    }, 250);
    return () => clearInterval(id);
  }, []);
  return <canvas ref={ref} className="scope" aria-label="Histograma RGB" />;
}

export function ColorLooks() {
  const clip = useGradeTarget();
  const thumb = useEditor((s) => (clip ? s.project.media.find((m) => m.id === clip.mediaId)?.thumb : null));
  const apply = (g: Grade, all: boolean) => {
    const s = useEditor.getState();
    if (all) s.setGrade('all', g, true);
    else if (clip) s.setGrade([clip.id], { ...g, lut: clip.color?.lut }, true);
  };
  return (
    <aside className="panel" aria-label="Looks e histograma">
      <div className="ph">Histograma</div>
      <div className="panel-body scope-wrap">
        <Scope />
      </div>
      <div className="ph">Looks</div>
      <div className="panel-body">
        {!clip && <p className="panel-sub">Põe um vídeo na timeline para ver os looks.</p>}
        <div className="looks">
          {Object.entries(LOOKS).map(([k, l]) => (
            <button key={k} className="look" disabled={!clip} onClick={(e) => apply(l.grade, e.shiftKey)} title="Clique: este clip · Shift+clique: todos">
              <span className="look-img" style={{ backgroundImage: thumb ? `url(${thumb})` : undefined, filter: cssFilter(l.grade) }}>
                <span className="look-tint" style={{ background: tint(l.grade) }} />
                {(l.grade.vignette ?? 0) > 0 && <span className="look-vig" />}
              </span>
              <span>{l.label}</span>
            </button>
          ))}
        </div>
        <p className="panel-sub">Shift+clique aplica o look a todos os clips.</p>
      </div>
    </aside>
  );
}

const SLIDERS: { k: keyof Grade; label: string; min: number; max: number }[] = [
  { k: 'exposure', label: 'Exposição', min: -1, max: 1 },
  { k: 'contrast', label: 'Contraste', min: -1, max: 1 },
  { k: 'saturation', label: 'Saturação', min: -1, max: 1 },
  { k: 'temperature', label: 'Temperatura', min: -1, max: 1 },
  { k: 'vignette', label: 'Vinheta', min: 0, max: 1 },
];

export function ColorPanel() {
  const clip = useGradeTarget();
  const g = clip?.color ?? {};
  const s = () => useEditor.getState();
  return (
    <aside className="panel" aria-label="Correção de cor">
      <div className="ph">Correção de cor</div>
      <div className="panel-body">
        {!clip ? (
          <p className="panel-sub">Escolhe um clip de vídeo na timeline (ou põe a cabeça de leitura sobre ele).</p>
        ) : (
          <>
            {SLIDERS.map((sl) => {
              const v = Number(g[sl.k] ?? 0);
              return (
                <div className="field" key={sl.k}>
                  <label className="row-label">
                    <span>{sl.label}</span>
                    <button className="val" onDoubleClick={() => s().setGrade([clip.id], { [sl.k]: 0 })} title="Duplo clique repõe">
                      {v > 0 ? '+' : ''}
                      {Math.round(v * 100)}
                    </button>
                  </label>
                  <input
                    className={`range grade-${sl.k}`}
                    type="range"
                    min={sl.min}
                    max={sl.max}
                    step={0.01}
                    value={v}
                    onPointerDown={() => s().startSlide()}
                    onDoubleClick={() => s().setGrade([clip.id], { [sl.k]: 0 })}
                    onChange={(e) => s().setGrade([clip.id], { [sl.k]: Number(e.target.value) })}
                  />
                </div>
              );
            })}
            <div className="card">
              <h4>LUT</h4>
              <p>{g.lut ? g.lut.split(/[\\/]/).pop() : 'Ficheiro .cube (DaVinci, Premiere, câmaras). Aplica-se na exportação.'}</p>
              <div className="row">
                <button
                  className="btn sm"
                  onClick={() =>
                    void window.ec.pickLut().then((p) => {
                      if (p) s().setGrade([clip.id], { lut: p });
                    })
                  }
                >
                  <Icon name="folder" /> Escolher LUT
                </button>
                {g.lut && (
                  <button className="btn sm" onClick={() => s().setGrade([clip.id], { lut: '' })}>
                    Tirar
                  </button>
                )}
              </div>
            </div>
            <div className="row">
              <button className="btn sm" onClick={() => s().setGrade('all', clip.color ?? null, true)} title="Copia esta correção para todos os clips de vídeo">
                Copiar para todos
              </button>
              <button className="btn sm" onClick={() => s().setGrade([clip.id], null)}>
                Repor
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
