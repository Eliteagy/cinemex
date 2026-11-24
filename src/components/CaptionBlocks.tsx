// Caption blocks: a gallery of animated caption styles (like CapCut's text templates). Each block
// plays a short sample with the real caption engine, so the block looks exactly like the result.
// 100+ styles: grouped by category (chips) with a search field, and only the blocks on screen are
// animated (IntersectionObserver), so the gallery stays light.
import { useEffect, useMemo, useRef, useState } from 'react';
import { drawCaption, loadFonts } from '../engine/caption';
import { CATEGORIES } from '../lib/capstyle.js';
import type { CaptionStyle } from '../types';

const SAMPLE = [
  { w: 'Isto', s: 0, e: 0.3 },
  { w: 'é', s: 0.32, e: 0.45 },
  { w: 'Elite', s: 0.48, e: 0.95 },
];
const LOOP = 1.7;
const ALL = 'Todos';
const SAVED = 'Guardados';

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

function drawBlock(c: HTMLCanvasElement, st: CaptionStyle, local: number) {
  const ctx = c.getContext('2d');
  if (!ctx) return;
  const W = c.width;
  const H = c.height;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#3a4250');
  g.addColorStop(1, '#22262c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // Draw on a 9:16-like scale: size relative to a frame twice the block height, centred.
  drawCaption(ctx, { text: SAMPLE.map((w) => w.w).join(' '), words: SAMPLE, ...(st.emphasis ? { y: 0.38, size: st.size * 5 } : { y: 0.5, size: Math.min(0.3, st.size * 4.2) }) }, st, local, LOOP, W, H);
}

export function CaptionBlocks({ styles, current, onPick }: { styles: [string, CaptionStyle][]; current: string; onPick: (key: string, only: boolean) => void }) {
  const refs = useRef(new Map<string, HTMLCanvasElement>());
  const visible = useRef(new Set<string>());
  const byKey = useRef(new Map<string, CaptionStyle>());
  byKey.current = new Map(styles);
  const [cat, setCat] = useState(ALL);
  const [query, setQuery] = useState('');
  const browse = styles.length > 6;

  const catOf = (st: CaptionStyle) => st.category ?? SAVED;
  const cats = useMemo(() => {
    const present = new Set(styles.map(([, st]) => st.category ?? SAVED));
    return [ALL, ...CATEGORIES.filter((c) => present.has(c)), ...[...present].filter((c) => c !== SAVED && !CATEGORIES.includes(c)), ...(present.has(SAVED) ? [SAVED] : [])];
  }, [styles]);
  const shown = useMemo(() => {
    if (!browse) return styles;
    const q = fold(query.trim());
    return styles.filter(([key, st]) => {
      if (q) return fold(`${st.label} ${key} ${st.category ?? SAVED} ${st.font}`).includes(q);
      return cat === ALL || catOf(st) === cat;
    });
  }, [styles, cat, query, browse]);

  // Which blocks are on screen: only those are drawn every frame.
  const io = useRef<IntersectionObserver | null>(null);
  if (!io.current && typeof IntersectionObserver !== 'undefined')
    io.current = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const key = (e.target as HTMLElement).dataset.key;
          if (!key) continue;
          if (e.isIntersecting) visible.current.add(key);
          else visible.current.delete(key);
        }
      },
      { rootMargin: '80px' },
    );
  useEffect(() => () => io.current?.disconnect(), []);

  useEffect(() => {
    let raf = 0;
    let ready = false;
    void loadFonts().then(() => (ready = true));
    const t0 = performance.now();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!ready || document.hidden) return;
      const local = ((performance.now() - t0) / 1000) % LOOP;
      // Without IntersectionObserver every block is drawn.
      const keys = io.current ? visible.current : new Set(refs.current.keys());
      for (const key of keys) {
        const c = refs.current.get(key);
        const st = byKey.current.get(key);
        if (c && st) drawBlock(c, st, local);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="blocks-wrap">
      {browse && (
        <div className="blocks-bar">
          <input className="input blocks-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Procurar em ${styles.length} estilos`} aria-label="Procurar estilos de legenda" />
          {!query.trim() && (
            <div className="blocks-cats" role="tablist" aria-label="Categorias de estilos">
              {cats.map((c) => (
                <button key={c} role="tab" aria-selected={cat === c} className={`blocks-cat${cat === c ? ' on' : ''}`} onClick={() => setCat(c)}>
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="blocks">
        {shown.map(([key, st]) => (
          <button key={key} className={`cap-block${current === key ? ' on' : ''}`} onClick={(e) => onPick(key, e.shiftKey)} title={`${st.label}. Clique: todas as legendas. Shift+clique: só a selecionada.`} aria-pressed={current === key}>
            <canvas
              width={300}
              height={170}
              data-key={key}
              ref={(el) => {
                if (el) {
                  refs.current.set(key, el);
                  io.current?.observe(el);
                } else {
                  const old = refs.current.get(key);
                  if (old) io.current?.unobserve(old);
                  refs.current.delete(key);
                  visible.current.delete(key);
                }
              }}
            />
            <span>{st.label}</span>
          </button>
        ))}
        {!shown.length && <p className="panel-sub">Nenhum estilo encontrado.</p>}
      </div>
    </div>
  );
}
