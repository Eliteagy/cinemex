// Caption blocks: a gallery of animated caption styles (like CapCut's text templates). Each block
// plays a short sample with the real caption engine, so the block looks exactly like the result.
import { useEffect, useRef } from 'react';
import { drawCaption, loadFonts } from '../engine/caption';
import type { CaptionStyle } from '../types';

const SAMPLE = [
  { w: 'Isto', s: 0, e: 0.3 },
  { w: 'é', s: 0.32, e: 0.45 },
  { w: 'Elite', s: 0.48, e: 0.95 },
];
const LOOP = 1.7;

export function CaptionBlocks({ styles, current, onPick }: { styles: [string, CaptionStyle][]; current: string; onPick: (key: string, only: boolean) => void }) {
  const refs = useRef(new Map<string, HTMLCanvasElement>());
  const list = useRef(styles);
  list.current = styles;
  useEffect(() => {
    let raf = 0;
    let ready = false;
    void loadFonts().then(() => (ready = true));
    const t0 = performance.now();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!ready) return;
      const local = ((performance.now() - t0) / 1000) % LOOP;
      for (const [key, st] of list.current) {
        const c = refs.current.get(key);
        if (!c) continue;
        const ctx = c.getContext('2d')!;
        const W = c.width;
        const H = c.height;
        ctx.fillStyle = '#2b2b2b';
        ctx.fillRect(0, 0, W, H);
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, '#3a4250');
        g.addColorStop(1, '#22262c');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        // Draw on a 9:16-like scale: size relative to a frame twice the block height, centred.
        drawCaption(ctx, { text: SAMPLE.map((w) => w.w).join(' '), words: SAMPLE, ...(st.emphasis ? { y: 0.38, size: st.size * 5 } : { y: 0.5, size: Math.min(0.3, st.size * 4.2) }) }, st, local, LOOP, W, H);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="blocks">
      {styles.map(([key, st]) => (
        <button key={key} className={`cap-block${current === key ? ' on' : ''}`} onClick={(e) => onPick(key, e.shiftKey)} title={`${st.label}. Clique: todas as legendas. Shift+clique: só a selecionada.`} aria-pressed={current === key}>
          <canvas
            width={300}
            height={170}
            ref={(el) => {
              if (el) refs.current.set(key, el);
              else refs.current.delete(key);
            }}
          />
          <span>{st.label}</span>
        </button>
      ))}
    </div>
  );
}
