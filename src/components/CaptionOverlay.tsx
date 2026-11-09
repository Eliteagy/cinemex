// The selected caption drawn as boxes over the viewer: drag a box to move that line.
// Felipe/Marta: the top words, the keyword and Marta's stack each move on their own (clip.lines);
// other styles: the whole caption moves (clip.x / clip.y). "Todas" moves the same line on every
// caption of the same style, so the look stays consistent through the video.
import { useState } from 'react';
import { useEditor } from '../store';
import { end, findClip, styleOf } from '../lib/project';
import { captionBoxes, type CaptionBox } from '../engine/caption';
import { cleanLines, lineOffset } from '../lib/emphasis.js';
import type { Clip, Project } from '../types';

const KEY = 'cinemex.caption-drag';
export type DragScope = 'one' | 'all';

export function getDragScope(): DragScope {
  try {
    return (localStorage.getItem(KEY) ?? localStorage.getItem('elite-cinema.caption-drag')) === 'one' ? 'one' : 'all';
  } catch {
    return 'all';
  }
}
export function setDragScope(v: DragScope) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* private storage: default stays */
  }
}

const ROLE_NAME: Record<CaptionBox['role'], string> = { base: 'Texto', kw: 'Palavra-chave', rest: 'Segunda linha', all: 'Legenda' };

let measure: CanvasRenderingContext2D | null = null;
const measureCtx = () => (measure ??= document.createElement('canvas').getContext('2d'));

/**
 * Captions a change applies to: this one, or every caption (auto captions and every text with the
 * same style; a title in another style is left alone). Same rule as "Aplicar a todas".
 */
export function targets(p: Project, clip: Clip, scope: DragScope): Clip[] {
  const self = findClip(p, clip.id)?.clip;
  if (scope === 'one') return self ? [self] : [];
  const style = clip.style ?? 'elite';
  return p.tracks.filter((t) => t.kind === 'text').flatMap((t) => t.clips.filter((c) => c.id === clip.id || c.auto || (c.style ?? 'elite') === style));
}
export const targetIds = (p: Project, clip: Clip, scope: DragScope) => targets(p, clip, scope).map((c) => c.id);

export function CaptionOverlay({ width, height }: { width: number; height: number }) {
  const clip = useEditor((s) => {
    const f = s.selected ? findClip(s.project, s.selected) : null;
    return f && f.track.kind === 'text' ? f.clip : null;
  });
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const project = useEditor((s) => s.project);
  const userStyles = useEditor((s) => s.userStyles);
  const [hover, setHover] = useState<string | null>(null);
  if (!clip?.text || playing || !width || !height || playhead < clip.start || playhead >= end(clip)) return null;
  const ctx = measureCtx();
  if (!ctx) return null;
  const st = styleOf(clip, project, userStyles);
  const boxes = captionBoxes(ctx, { text: clip.text, words: clip.words, keyword: clip.keyword, x: clip.x, y: clip.y, size: clip.size, lines: clip.lines }, st, end(clip) - clip.start, width, height);

  const drag = (e: React.PointerEvent, box: CaptionBox) => {
    e.preventDefault();
    e.stopPropagation();
    const s = useEditor.getState();
    s.beginGesture();
    const scope = getDragScope();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const id = clip.id;
    // Starting values per caption, so each keeps its own place plus the same move.
    const start = new Map(targets(s.project, clip, scope).map((c) => [c.id, { lines: c.lines, x: c.x ?? 0.5, y: c.y ?? styleOf(c, s.project, s.userStyles).y }]));
    const move = (ev: PointerEvent) => {
      let dx = (ev.clientX - x0) / width;
      let dy = (ev.clientY - y0) / height;
      // Shift: only up/down or only sideways, whichever is bigger.
      if (ev.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      useEditor.getState().live((p) => {
        for (const c of targets(p, findClip(p, id)!.clip, scope)) {
          const s0 = start.get(c.id);
          if (!s0) continue;
          if (box.role === 'all') {
            c.x = Math.round(Math.max(0, Math.min(1, s0.x + dx)) * 1000) / 1000;
            c.y = Math.round(Math.max(0, Math.min(1, s0.y + dy)) * 1000) / 1000;
          } else {
            const o = lineOffset(s0.lines, box.role);
            const l = cleanLines({ ...s0.lines, [box.role]: { x: o.x + dx, y: o.y + dy } });
            if (l) c.lines = l;
            else delete c.lines;
          }
        }
      });
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      const n = start.size;
      useEditor.getState().setStatus(n > 1 ? `${ROLE_NAME[box.role]} movida em ${n} legendas (Ctrl+Z desfaz)` : `${ROLE_NAME[box.role]} movida (Ctrl+Z desfaz)`);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  return (
    <svg className="caption-overlay" width={width} height={height} aria-label="Posição das linhas da legenda">
      {boxes.map((b) => (
        <g key={b.role} onPointerEnter={() => setHover(b.role)} onPointerLeave={() => setHover(null)}>
          <rect className={`cap-box role-${b.role}`} x={b.x} y={b.y} width={b.w} height={b.h} rx={4} onPointerDown={(e) => drag(e, b)}>
            <title>{`${ROLE_NAME[b.role]}: arrasta para mover (Shift: só numa direção)`}</title>
          </rect>
          {hover === b.role && (
            <text className="cap-box-label" x={b.x + 4} y={b.y - 6}>
              {ROLE_NAME[b.role]}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}
