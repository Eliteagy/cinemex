// "Cor" page, Lightroom-style (approved mock docs/design/cor-v2-mock.png): Básico, Curva, HSL,
// Rodas de cor and Looks on the right; histogram and the quick presets on the left; Antes/Depois
// line on the viewer. Every control writes clip.color.dev (src/lib/develop.js); the preview and the
// export bake the same 3D LUT from it, so what is seen is what is exported.
import { useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent } from 'react';

type RPointerEvent = RMouseEvent;
import { useEditor } from '../store';
import { LOOKS as QUICK, activeClip, findClip, gradeMath } from '../lib/project';
import { BANDS, LOOKS, autoTone, autoWhiteBalance, makePixelFn, type Band, type CurvePoints, type DevSettings, type WheelName } from '../lib/develop.js';
import { compare, onCompare, setCompare, sourcePixels } from '../engine/glcolor';
import { GRAIN_DEFAULT, SHARPEN_DEFAULT, estimateAirlight, hasDetail, hasGrain } from '../lib/detail.js';
import type { Clip, Grade } from '../types';
import { Icon } from './Icon';
import { NumField, Row, RowSlider, Section } from './Inspector';
import { hasPicture, isGen } from '../lib/generators.js';

const st = useEditor.getState;

/**
 * The clip being worked on: the selected one, or the top one under the playhead. On the Cor page any
 * clip with a picture or an adjustment layer (its grade goes to what is under it); on the Fusion page
 * clips with a picture of their own (footage, solid colours, Fusion compositions).
 */
export function useGradeTarget(page: 'color' | 'fusion' = 'color'): Clip | null {
  return useEditor((s) => {
    const ok = (c: Clip | null | undefined): c is Clip => Boolean(c && (c.mediaId || (page === 'fusion' ? hasPicture(c) : isGen(c))));
    const sel = s.selected ? findClip(s.project, s.selected) : null;
    if (sel && sel.track.kind === 'video' && ok(sel.clip)) return sel.clip;
    for (const t of [...s.project.tracks].reverse()) if (t.kind === 'video' && !t.hidden) {
      const c = activeClip(t, s.playhead);
      if (ok(c)) return c;
    }
    return null;
  });
}

/** Writes a patch into the clip's develop settings (nested groups merged one level deep). */
function setDev(clip: Clip, patch: DevSettings) {
  const dev: DevSettings = { ...(clip.color?.dev ?? {}) };
  for (const [k, v] of Object.entries(patch) as [keyof DevSettings, unknown][]) {
    const cur = dev[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) (dev as Record<string, unknown>)[k] = { ...(cur as object), ...(v as object) };
    else if (v === undefined) delete dev[k];
    else (dev as Record<string, unknown>)[k] = v;
  }
  st().setGrade([clip.id], { dev });
}

// ------------------------------------------------------------------ histogram (left panel)
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

const cssFilter = (g: Grade) => {
  const m = gradeMath(g);
  return `brightness(${m.bright}) contrast(${m.contrast}) saturate(${m.saturation})`;
};
const tint = (g: Grade) => {
  const m = gradeMath(g);
  return `rgb(${m.warm.map((w) => Math.round(w * 255)).join(',')})`;
};

export function ColorLooks() {
  const clip = useGradeTarget();
  const thumb = useEditor((s) => (clip ? s.project.media.find((m) => m.id === clip.mediaId)?.thumb : null));
  const apply = (g: Grade, all: boolean) => {
    const s = st();
    if (all) s.setGrade('all', g, true);
    else if (clip) s.setGrade([clip.id], { ...g, lut: clip.color?.lut }, true);
  };
  return (
    <aside className="panel" aria-label="Histograma e predefinições">
      <div className="ph">Histograma</div>
      <div className="panel-body scope-wrap">
        <Scope />
      </div>
      <div className="ph">Predefinições rápidas</div>
      <div className="panel-body">
        {!clip && <p className="panel-sub">Põe um vídeo na timeline para ver as predefinições.</p>}
        <div className="looks">
          {Object.entries(QUICK).map(([k, l]) => (
            <button key={k} className="look" disabled={!clip} onClick={(e) => apply(l.grade, e.shiftKey)} title="Clique: este clip · Shift+clique: todos">
              <span className="look-img" style={{ backgroundImage: thumb ? `url(${thumb})` : undefined, filter: cssFilter(l.grade) }}>
                <span className="look-tint" style={{ background: tint(l.grade) }} />
                {(l.grade.vignette ?? 0) > 0 && <span className="look-vig" />}
              </span>
              <span>{l.label}</span>
            </button>
          ))}
        </div>
        <p className="panel-sub">Substituem a correção do clip. Shift+clique aplica a todos os clips.</p>
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ Antes / Depois (viewer)
export function CompareOverlay({ width, height }: { width: number; height: number }) {
  const page = useEditor((s) => s.page);
  const [, tick] = useState(0);
  useEffect(() => onCompare(() => tick((n) => n + 1)), []);
  const ref = useRef<HTMLDivElement>(null);
  if (page !== 'color' || !compare.on || !width) return null;
  const drag = (e: RPointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    setCompare({ x: Math.max(0.02, Math.min(0.98, (e.clientX - r.left) / r.width)) });
  };
  return (
    <div className="cmp" ref={ref} style={{ width, height }}>
      <div
        className="cmp-line"
        style={{ left: `${compare.x * 100}%` }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag(e);
        }}
        onPointerMove={(e) => e.buttons & 1 && drag(e)}
      >
        <span className="cmp-tag left">Antes</span>
        <span className="cmp-tag right">Depois</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ controls
function DevRow({ label, value, min, max, step = 1, dec = 0, unit = '', onChange }: { label: string; value: number; min: number; max: number; step?: number; dec?: number; unit?: string; onChange: (v: number | undefined) => void }) {
  return (
    <Row label={unit ? `${label} (${unit})` : label} onReset={() => onChange(undefined)}>
      <RowSlider value={value} min={min} max={max} step={step} label={label} onChange={(v) => onChange(v)} />
      <NumField value={value} min={min} max={max} step={step} dec={dec} label={label} onChange={(v) => onChange(v)} />
    </Row>
  );
}

const BASIC: { k: keyof DevSettings; label: string; min: number; max: number; step?: number; dec?: number; def: number; unit?: string }[] = [
  { k: 'temp', label: 'Temperatura', min: 2000, max: 15000, step: 50, def: 6500, unit: 'K' },
  { k: 'tint', label: 'Tinta', min: -150, max: 150, def: 0 },
  { k: 'exposure', label: 'Exposição', min: -5, max: 5, step: 0.01, dec: 2, def: 0 },
  { k: 'contrast', label: 'Contraste', min: -100, max: 100, def: 0 },
  { k: 'highlights', label: 'Realces', min: -100, max: 100, def: 0 },
  { k: 'shadows', label: 'Sombras', min: -100, max: 100, def: 0 },
  { k: 'whites', label: 'Brancos', min: -100, max: 100, def: 0 },
  { k: 'blacks', label: 'Pretos', min: -100, max: 100, def: 0 },
  { k: 'vibrance', label: 'Vibração', min: -100, max: 100, def: 0 },
  { k: 'saturation', label: 'Saturação', min: -100, max: 100, def: 0 },
];

function Basic({ clip }: { clip: Clip }) {
  const dev = clip.color?.dev ?? {};
  const auto = (wb: boolean) => {
    const px = sourcePixels(clip.id);
    if (!px) return;
    if (wb) setDev(clip, autoWhiteBalance(px.data, px.width, px.height));
    else setDev(clip, autoTone(px.data, px.width, px.height, dev));
  };
  return (
    <>
      <div className="cor-actions">
        <button className="btn sm" onClick={() => auto(false)} title="Exposição, contraste, realces e sombras a partir do frame atual">
          Auto
        </button>
        <button className="btn sm" onClick={() => auto(true)} title="Equilibra os brancos a partir do frame atual">
          Auto WB
        </button>
      </div>
      <div className="cor-grid">
        {BASIC.map((b) => (
          <DevRow key={b.k} label={b.label} unit={b.unit} value={Number(dev[b.k] ?? b.def)} min={b.min} max={b.max} step={b.step} dec={b.dec} onChange={(v) => setDev(clip, { [b.k]: v } as DevSettings)} />
        ))}
        <Row label="Vinheta" onReset={() => st().setGrade([clip.id], { vignette: 0 })}>
          <RowSlider value={Number(clip.color?.vignette ?? 0)} min={0} max={1} step={0.01} label="Vinheta" onChange={(v) => st().setGrade([clip.id], { vignette: v })} />
          <NumField value={Math.round(Number(clip.color?.vignette ?? 0) * 100)} min={0} max={100} step={1} dec={0} label="Vinheta" onChange={(v) => st().setGrade([clip.id], { vignette: v / 100 })} />
        </Row>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ point curve
type Ch = 'master' | 'r' | 'g' | 'b';
const CH_LABEL: Record<Ch, string> = { master: 'RGB', r: 'R', g: 'G', b: 'B' };
const CH_COLOR: Record<Ch, string> = { master: '#f2f2f2', r: '#ff5a5a', g: '#4fdc6a', b: '#5a8dff' };

/** Monotone cubic (Fritsch–Carlson), like LightCraft's curve: no overshoot. */
function monotone(pts: CurvePoints) {
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1]! - ys[i]!) / Math.max(1e-6, xs[i + 1]! - xs[i]!));
  const m: number[] = [d[0] ?? 0];
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2);
  m.push(d[n - 2] ?? 0);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * d[i]!;
      m[i + 1] = t * b * d[i]!;
    }
  }
  return (x: number) => {
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs[n - 1]!) return ys[n - 1]!;
    let i = 0;
    while (x > xs[i + 1]!) i++;
    const h = xs[i + 1]! - xs[i]!;
    const t = (x - xs[i]!) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i]! + (t3 - 2 * t2 + t) * h * m[i]! + (-2 * t3 + 3 * t2) * ys[i + 1]! + (t3 - t2) * h * m[i + 1]!;
  };
}

const IDENT: CurvePoints = [
  [0, 0],
  [1, 1],
];

function CurveEditor({ clip }: { clip: Clip }) {
  const [ch, setCh] = useState<Ch>('master');
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  const curve = clip.color?.dev?.curve ?? {};
  const stored = curve[ch];
  const pts: CurvePoints = stored && stored.length >= 2 ? stored : IDENT;
  const f = useMemo(() => monotone(pts), [pts]);
  const path = useMemo(() => {
    let d = '';
    for (let i = 0; i <= 64; i++) {
      const x = i / 64;
      d += `${i ? 'L' : 'M'}${(x * 100).toFixed(2)},${((1 - Math.max(0, Math.min(1, f(x)))) * 100).toFixed(2)}`;
    }
    return d;
  }, [f]);
  const save = (next: CurvePoints) => setDev(clip, { curve: { ...curve, [ch]: next } });
  const at = (e: RPointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height))] as [number, number];
  };
  const move = (e: RPointerEvent) => {
    const i = drag.current;
    if (i === null) return;
    const [x, y] = at(e);
    const next = pts.map((p) => [...p] as [number, number]);
    const lo = i === 0 ? 0 : next[i - 1]![0] + 0.01;
    const hi = i === next.length - 1 ? 1 : next[i + 1]![0] - 0.01;
    next[i] = [i === 0 ? 0 : i === next.length - 1 ? 1 : Math.max(lo, Math.min(hi, x)), y];
    save(next);
  };
  return (
    <div className="cor-curve">
      <div className="seg sm cor-ch" role="tablist">
        {(Object.keys(CH_LABEL) as Ch[]).map((c) => (
          <button key={c} className={c === ch ? 'on' : ''} onClick={() => setCh(c)} role="tab" aria-selected={c === ch}>
            {CH_LABEL[c]}
            {(curve[c]?.length ?? 0) > 2 && <i className="ri-on" />}
          </button>
        ))}
        <button className="ri-tool" title="Repor a curva deste canal" onClick={() => save(IDENT)}>
          <Icon name="undo" />
        </button>
      </div>
      <svg
        ref={svg}
        className="cor-curve-svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const [x, y] = at(e);
          // Near a point: drag it; otherwise add one on the curve under the click.
          const r = svg.current!.getBoundingClientRect();
          const near = pts.findIndex((p) => Math.hypot((p[0] - x) * r.width, (p[1] - y) * r.height) < 9);
          st().startSlide();
          if (near >= 0) drag.current = near;
          else {
            const next = [...pts, [x, f(x)] as [number, number]].sort((a, b) => a[0] - b[0]);
            drag.current = next.findIndex((p) => p[0] === x);
            save(next);
          }
          (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={move}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={(e) => {
          const [x, y] = at(e);
          const r = svg.current!.getBoundingClientRect();
          const i = pts.findIndex((p, j) => j > 0 && j < pts.length - 1 && Math.hypot((p[0] - x) * r.width, (p[1] - y) * r.height) < 9);
          if (i > 0) save(pts.filter((_, j) => j !== i));
        }}
      >
        {[25, 50, 75].map((g) => (
          <g key={g} className="cor-grid-line">
            <line x1={g} y1={0} x2={g} y2={100} />
            <line x1={0} y1={g} x2={100} y2={g} />
          </g>
        ))}
        <line className="cor-diag" x1={0} y1={100} x2={100} y2={0} />
        <path d={path} fill="none" stroke={CH_COLOR[ch]} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="cor-curve-pts" aria-hidden>
        {pts.map((p, i) => (
          <span key={i} style={{ left: `${p[0] * 100}%`, top: `${(1 - p[1]) * 100}%` }} />
        ))}
      </div>
      <p className="cor-hint">Clique para pôr um ponto, arrasta para mexer, duplo clique para tirar.</p>
      {ch === 'master' && (
        <div className="cor-grid">
          {(['shadows', 'darks', 'lights', 'highlights'] as const).map((k) => (
            <DevRow key={k} label={{ shadows: 'Sombras', darks: 'Escuros', lights: 'Claros', highlights: 'Realces' }[k]} value={Number(curve[k] ?? 0)} min={-100} max={100} onChange={(v) => setDev(clip, { curve: { ...curve, [k]: v ?? 0 } })} />
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ HSL
const BAND_COLOR: Record<Band, string> = { red: '#ff3b30', orange: '#ff9500', yellow: '#ffd60a', green: '#30d158', aqua: '#40e0d0', blue: '#0a84ff', purple: '#7d5cff', magenta: '#ff2dd1' };
const BAND_LABEL: Record<Band, string> = { red: 'Vermelho', orange: 'Laranja', yellow: 'Amarelo', green: 'Verde', aqua: 'Água', blue: 'Azul', purple: 'Roxo', magenta: 'Magenta' };

function Hsl({ clip }: { clip: Clip }) {
  const [band, setBand] = useState<Band>('red');
  const hsl = clip.color?.dev?.hsl ?? {};
  const cur = hsl[band] ?? {};
  const put = (k: 'h' | 's' | 'l', v: number | undefined) => setDev(clip, { hsl: { ...hsl, [band]: { ...cur, [k]: v ?? 0 } } });
  return (
    <div className="cor-hsl">
      <div className="cor-bands" role="radiogroup" aria-label="Cor a ajustar">
        {BANDS.map((b) => {
          const v = hsl[b];
          const on = Boolean(v && (v.h || v.s || v.l));
          return (
            <button key={b} role="radio" aria-checked={b === band} className={`cor-band${b === band ? ' on' : ''}${on ? ' used' : ''}`} style={{ background: BAND_COLOR[b] }} title={BAND_LABEL[b]} onClick={() => setBand(b)} />
          );
        })}
      </div>
      <p className="cor-hint">{BAND_LABEL[band]}</p>
      <DevRow label="Matiz" value={Number(cur.h ?? 0)} min={-100} max={100} onChange={(v) => put('h', v)} />
      <DevRow label="Saturação" value={Number(cur.s ?? 0)} min={-100} max={100} onChange={(v) => put('s', v)} />
      <DevRow label="Luminância" value={Number(cur.l ?? 0)} min={-100} max={100} onChange={(v) => put('l', v)} />
    </div>
  );
}

// ------------------------------------------------------------------ colour wheels
// Hue 0 (red) points right and grows counter-clockwise; the conic gradient is laid out to match.
const WHEEL_BG = `radial-gradient(circle, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0) 68%), conic-gradient(from 90deg, ${[0, 330, 300, 270, 240, 210, 180, 150, 120, 90, 60, 30, 0].map((h) => `hsl(${h} 90% 55%)`).join(', ')})`;
const WHEEL_LABEL: Record<WheelName, string> = { shadows: 'Sombras', midtones: 'Médios', highlights: 'Realces', global: 'Global' };

function Wheel({ clip, name }: { clip: Clip; name: WheelName }) {
  const wheels = clip.color?.dev?.wheels ?? {};
  const w = wheels[name] ?? {};
  const hue = Number(w.hue ?? 0);
  const sat = Number(w.sat ?? 0);
  const ref = useRef<HTMLDivElement>(null);
  const put = (p: { hue?: number; sat?: number; lum?: number } | null) => setDev(clip, { wheels: { ...wheels, [name]: p ? { ...w, ...p } : { hue: 0, sat: 0, lum: 0 } } });
  const pick = (e: RPointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const dx = (e.clientX - r.left - r.width / 2) / (r.width / 2);
    const dy = (e.clientY - r.top - r.height / 2) / (r.height / 2);
    const h = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360;
    put({ hue: Math.round(h), sat: Math.round(Math.min(1, Math.hypot(dx, dy)) * 100) });
  };
  const a = (hue * Math.PI) / 180;
  return (
    <div className="cor-wheel">
      <span className="cor-wheel-name">{WHEEL_LABEL[name]}</span>
      <div
        ref={ref}
        className="cor-wheel-disc"
        style={{ background: WHEEL_BG }}
        role="slider"
        aria-label={`Roda ${WHEEL_LABEL[name]}`}
        aria-valuetext={`matiz ${hue}°, saturação ${sat}`}
        onPointerDown={(e) => {
          st().startSlide();
          e.currentTarget.setPointerCapture(e.pointerId);
          pick(e);
        }}
        onPointerMove={(e) => e.buttons & 1 && pick(e)}
        onDoubleClick={() => put(null)}
        title="Arrasta para tingir · duplo clique repõe"
      >
        <span className="cor-wheel-dot" style={{ left: `${50 + Math.cos(a) * (sat / 100) * 50}%`, top: `${50 - Math.sin(a) * (sat / 100) * 50}%` }} />
      </div>
      <RowSlider value={Number(w.lum ?? 0)} min={-100} max={100} step={1} label={`Luminância ${WHEEL_LABEL[name]}`} onChange={(v) => put({ lum: v })} />
    </div>
  );
}

function Wheels({ clip }: { clip: Clip }) {
  const dev = clip.color?.dev ?? {};
  return (
    <>
      <div className="cor-wheels">
        <Wheel clip={clip} name="shadows" />
        <Wheel clip={clip} name="midtones" />
        <Wheel clip={clip} name="highlights" />
      </div>
      <div className="cor-grid">
        <DevRow label="Mistura" value={Number(dev.blending ?? 50)} min={0} max={100} onChange={(v) => setDev(clip, { blending: v })} />
        <DevRow label="Equilíbrio" value={Number(dev.balance ?? 0)} min={-100} max={100} onChange={(v) => setDev(clip, { balance: v })} />
      </div>
    </>
  );
}

// ------------------------------------------------------------------ looks
/** Look thumbnails rendered from the clip's current frame with the real develop function. */
function useLookThumbs(clip: Clip, nonce: number) {
  return useMemo(() => {
    const px = sourcePixels(clip.id, 96, 54);
    if (!px) return null;
    const out: Record<string, string> = {};
    const c = document.createElement('canvas');
    c.width = px.width;
    c.height = px.height;
    const x = c.getContext('2d')!;
    for (const l of [{ id: '' }, ...LOOKS]) {
      const fn = makePixelFn({ dev: l.id ? { look: { id: l.id, amount: 100 } } : {} });
      const img = new ImageData(px.width, px.height);
      const s = px.data;
      for (let i = 0; i < s.length; i += 4) {
        const [r, g, b] = fn(s[i]! / 255, s[i + 1]! / 255, s[i + 2]! / 255);
        img.data[i] = r * 255;
        img.data[i + 1] = g * 255;
        img.data[i + 2] = b * 255;
        img.data[i + 3] = 255;
      }
      x.putImageData(img, 0, 0);
      out[l.id] = c.toDataURL('image/jpeg', 0.8);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id, nonce]);
}

function Looks({ clip }: { clip: Clip }) {
  const [nonce, setNonce] = useState(0);
  const thumbs = useLookThumbs(clip, nonce);
  // The frame may not be drawn yet when the section opens: try again shortly.
  useEffect(() => {
    if (thumbs) return;
    const id = setTimeout(() => setNonce((n) => n + 1), 400);
    return () => clearTimeout(id);
  }, [thumbs]);
  const look = clip.color?.dev?.look ?? {};
  const groups = useMemo(() => [...new Set(LOOKS.map((l) => l.group))], []);
  return (
    <div className="cor-looks">
      <div className="cor-look-row">
        <button className={`cor-look${!look.id ? ' on' : ''}`} onClick={() => setDev(clip, { look: undefined })}>
          <span className="cor-look-img" style={{ backgroundImage: thumbs?.[''] ? `url(${thumbs['']})` : undefined }} />
          <span>Sem look</span>
        </button>
      </div>
      {groups.map((g) => (
        <div key={g}>
          <p className="cor-look-group">{g}</p>
          <div className="cor-look-row">
            {LOOKS.filter((l) => l.group === g).map((l) => (
              <button key={l.id} className={`cor-look${look.id === l.id ? ' on' : ''}`} onClick={() => setDev(clip, { look: { id: l.id, amount: look.amount ?? 100 } })} title={l.label}>
                <span className="cor-look-img" style={{ backgroundImage: thumbs?.[l.id] ? `url(${thumbs[l.id]})` : undefined }} />
                <span>{l.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
      {look.id && <DevRow label="Intensidade" unit="%" value={Number(look.amount ?? 100)} min={0} max={200} onChange={(v) => setDev(clip, { look: { id: look.id, amount: v ?? 100 } })} />}
      <button className="btn sm" onClick={() => setNonce((n) => n + 1)} title="Volta a desenhar as miniaturas com o frame atual">
        Atualizar miniaturas
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ Detalhe (spatial, src/lib/detail.js)
const DETAIL: { k: 'localHighlights' | 'localShadows' | 'clarity' | 'texture' | 'dehaze'; label: string }[] = [
  { k: 'localHighlights', label: 'Realces locais' },
  { k: 'localShadows', label: 'Sombras locais' },
  { k: 'clarity', label: 'Claridade' },
  { k: 'texture', label: 'Textura' },
  { k: 'dehaze', label: 'Remover neblina' },
];

function Detail({ clip }: { clip: Clip }) {
  const dev = clip.color?.dev ?? {};
  const sp = { ...SHARPEN_DEFAULT, ...(dev.sharpen ?? {}) };
  const gr = { ...GRAIN_DEFAULT, ...(dev.grain ?? {}) };
  const put = (k: (typeof DETAIL)[number]['k'], v: number | undefined) => {
    const patch: DevSettings = { [k]: v };
    // Dehaze: the airlight is measured once from the current frame and kept for the whole clip
    // (a per-frame value would flicker), so preview and export use the same number.
    if (k === 'dehaze' && v && dev.dehazeAir === undefined) {
      const px = sourcePixels(clip.id);
      if (px) patch.dehazeAir = estimateAirlight(px.data, px.width, px.height);
    }
    if (k === 'dehaze' && !v) patch.dehazeAir = undefined;
    setDev(clip, patch);
  };
  return (
    <div className="cor-grid">
      {DETAIL.map((d) => (
        <DevRow key={d.k} label={d.label} value={Number(dev[d.k] ?? 0)} min={-100} max={100} onChange={(v) => put(d.k, v)} />
      ))}
      <p className="ri-note cor-note">Nitidez</p>
      <DevRow label="Quantidade" value={sp.amount} min={0} max={150} onChange={(v) => setDev(clip, { sharpen: { ...sp, amount: v ?? 0 } })} />
      <DevRow label="Raio" value={sp.radius} min={0.5} max={3} step={0.1} dec={1} onChange={(v) => setDev(clip, { sharpen: { ...sp, radius: v ?? SHARPEN_DEFAULT.radius } })} />
      <DevRow label="Detalhe" value={sp.detail} min={0} max={100} onChange={(v) => setDev(clip, { sharpen: { ...sp, detail: v ?? SHARPEN_DEFAULT.detail } })} />
      <DevRow label="Máscara" value={sp.masking} min={0} max={100} onChange={(v) => setDev(clip, { sharpen: { ...sp, masking: v ?? 0 } })} />
      <p className="ri-note cor-note">Grão de película</p>
      <DevRow label="Quantidade" value={gr.amount} min={0} max={100} onChange={(v) => setDev(clip, { grain: { ...gr, amount: v ?? 0 } })} />
      <DevRow label="Tamanho" value={gr.size} min={0} max={100} onChange={(v) => setDev(clip, { grain: { ...gr, size: v ?? GRAIN_DEFAULT.size } })} />
      <DevRow label="Rugosidade" value={gr.roughness} min={0} max={100} onChange={(v) => setDev(clip, { grain: { ...gr, roughness: v ?? GRAIN_DEFAULT.roughness } })} />
    </div>
  );
}

// ------------------------------------------------------------------ panel
const has = (o: unknown): boolean => Boolean(o && typeof o === 'object' && Object.values(o as object).some((v) => (typeof v === 'number' ? v !== 0 : v && typeof v === 'object' ? has(v) : Boolean(v))));

export function ColorPanel() {
  const clip = useGradeTarget();
  const [open, setOpen] = useState<Record<string, boolean>>({ basic: true, detail: true, curve: true, hsl: true, wheels: true, looks: true, lut: false });
  const [, tick] = useState(0);
  useEffect(() => onCompare(() => tick((n) => n + 1)), []);
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !o[id] }));
  if (!clip)
    return (
      <aside className="panel rinsp cor" aria-label="Cor">
        <div className="panel-body">
          <p className="panel-sub">Escolhe um clip de vídeo na timeline (ou põe a cabeça de leitura sobre ele).</p>
        </div>
      </aside>
    );
  const g = clip.color ?? {};
  const dev = g.dev ?? {};
  const basicOn = BASIC.some((b) => dev[b.k] !== undefined && Number(dev[b.k]) !== b.def) || Number(g.vignette ?? 0) > 0;
  return (
    <aside className="panel rinsp cor" aria-label="Cor">
      <div className="cor-top">
        <button className={`btn sm${compare.on ? ' on' : ''}`} aria-pressed={compare.on} onClick={() => setCompare({ on: !compare.on })} title="Linha Antes/Depois no visor">
          Antes / Depois
        </button>
        <span className="cor-spacer" />
        <button className="btn sm" onClick={() => st().setGrade('all', clip.color ?? null, true)} title="Copia esta correção para todos os clips de vídeo">
          Copiar para todos
        </button>
        <button className="btn sm" onClick={() => st().setGrade([clip.id], null)}>
          Repor
        </button>
      </div>
      <div className="ri-body cor-body">
        <Section id="basic" title="Básico" on={basicOn} open={open.basic!} onToggle={toggle} onReset={() => setDev(clip, Object.fromEntries(BASIC.map((b) => [b.k, undefined])) as DevSettings)}>
          <Basic clip={clip} />
        </Section>
        <Section id="detail" title="Detalhe" on={hasDetail(dev) || hasGrain(dev)} open={open.detail!} onToggle={toggle} onReset={() => setDev(clip, { localHighlights: undefined, localShadows: undefined, clarity: undefined, texture: undefined, sharpen: undefined, dehaze: undefined, dehazeAir: undefined, grain: undefined })}>
          <Detail clip={clip} />
        </Section>
        <div className="cor-two">
          <Section id="curve" title="Curva" on={has(dev.curve)} open={open.curve!} onToggle={toggle} onReset={() => setDev(clip, { curve: undefined })}>
            <CurveEditor clip={clip} />
          </Section>
          <Section id="hsl" title="HSL" on={has(dev.hsl)} open={open.hsl!} onToggle={toggle} onReset={() => setDev(clip, { hsl: undefined })}>
            <Hsl clip={clip} />
          </Section>
        </div>
        <Section id="wheels" title="Rodas de cor" on={has(dev.wheels)} open={open.wheels!} onToggle={toggle} onReset={() => setDev(clip, { wheels: undefined, blending: undefined, balance: undefined })}>
          <Wheels clip={clip} />
        </Section>
        <Section id="looks" title="Looks" on={Boolean(dev.look?.id)} open={open.looks!} onToggle={toggle} onReset={() => setDev(clip, { look: undefined })}>
          <Looks clip={clip} />
        </Section>
        <Section id="lut" title="LUT (.cube)" on={Boolean(g.lut)} open={open.lut!} onToggle={toggle} onReset={() => st().setGrade([clip.id], { lut: '' })}>
          <p className="ri-note cor-note">{g.lut ? g.lut.split(/[\\/]/).pop() : 'Ficheiro .cube (DaVinci, Premiere, câmaras). Aplica-se depois da correção, também na pré-visualização.'}</p>
          <div className="cor-actions">
            <button
              className="btn sm"
              onClick={() =>
                void window.ec.pickLut().then((p) => {
                  if (p) st().setGrade([clip.id], { lut: p });
                })
              }
            >
              <Icon name="folder" /> Escolher LUT
            </button>
          </div>
        </Section>
      </div>
    </aside>
  );
}

