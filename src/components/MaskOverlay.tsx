// Mask shapes of the selected clip drawn over the viewer: drag a shape to move it, the corner
// handle to resize it, and the dark dot (when the mask moves) to place where it ends.
// Caneta: click to add points, click the first point (or Enter) to close, drag points to adjust.
// Pessoa: click the person to cut out (the matte engine runs on the whole clip).
import { useEffect } from 'react';
import { useEditor } from '../store';
import { findClip, r3 } from '../lib/project';
import { maskCentre } from '../engine/mask';
import { personMatte } from '../actions';
import type { Mask } from '../types';

type Part = 'move' | 'size' | 'end';

export function MaskOverlay({ width, height }: { width: number; height: number }) {
  const clipId = useEditor((s) => s.selected);
  const clip = useEditor((s) => (s.selected ? findClip(s.project, s.selected)?.clip : undefined));
  const playhead = useEditor((s) => s.playhead);
  const tool = useEditor((s) => s.maskTool);
  const toolOn = Boolean(tool && clip && tool.clipId === clip.id);

  useEffect(() => {
    if (!toolOn) return;
    const key = (e: KeyboardEvent) => {
      const s = useEditor.getState();
      if (e.key === 'Escape') s.setMaskTool(null);
      if (e.key === 'Enter' && s.maskTool?.kind === 'pen') s.setMaskTool(null);
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [toolOn]);

  if (!clip?.masks?.length || !clipId || !width || !height) return null;
  const local = playhead - clip.start;
  const duration = (clip.out - clip.in) / (clip.speed ?? 1);
  const toolMask = toolOn ? clip.masks.find((m) => m.id === tool!.maskId) : undefined;

  const drag = (e: React.PointerEvent, m: Mask, part: Part) => {
    e.preventDefault();
    e.stopPropagation();
    const s = useEditor.getState();
    s.beginGesture();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const start = { ...m, points: m.points?.map((p) => [...p] as [number, number]) };
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / width;
      const dy = (ev.clientY - y0) / height;
      useEditor.getState().live((p) => {
        const mk = findClip(p, clipId)?.clip.masks?.find((x) => x.id === m.id);
        if (!mk) return;
        if (part === 'move') {
          mk.x = r3(start.x + dx);
          mk.y = r3(start.y + dy);
          if (start.points) mk.points = start.points.map(([px, py]) => [r3(px + dx), r3(py + dy)]);
          if (start.toX !== undefined) {
            mk.toX = r3(start.toX + dx);
            mk.toY = r3((start.toY ?? start.y) + dy);
          }
        } else if (part === 'size') {
          mk.w = r3(Math.max(0.02, start.w + dx * 2));
          mk.h = r3(Math.max(0.02, start.h + dy * 2));
        } else {
          mk.toX = r3((start.toX ?? start.x) + dx);
          mk.toY = r3((start.toY ?? start.y) + dy);
        }
      });
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  /** Drag one corner of a pen shape. */
  const dragPoint = (e: React.PointerEvent, m: Mask, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    const s = useEditor.getState();
    if (s.maskTool?.kind === 'pen' && i === 0 && (m.points?.length ?? 0) >= 3) {
      s.setMaskTool(null); // clicking the first point closes the shape
      s.setStatus('Forma fechada');
      return;
    }
    s.beginGesture();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const [sx, sy] = m.points![i]!;
    const move = (ev: PointerEvent) => {
      const nx = r3(Math.max(0, Math.min(1, sx + (ev.clientX - x0) / width)));
      const ny = r3(Math.max(0, Math.min(1, sy + (ev.clientY - y0) / height)));
      useEditor.getState().live((p) => {
        const mk = findClip(p, clipId)?.clip.masks?.find((x) => x.id === m.id);
        if (mk?.points?.[i]) mk.points[i] = [nx, ny];
      });
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  /** Tool clicks on the frame: a new pen point, or the person to cut out. */
  const toolClick = (e: React.PointerEvent<SVGRectElement>) => {
    if (!toolMask) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const x = r3((e.clientX - r.left) / r.width);
    const y = r3((e.clientY - r.top) / r.height);
    const s = useEditor.getState();
    if (tool!.kind === 'pen') {
      s.updateMask(clipId, toolMask.id, { points: [...(toolMask.points ?? []), [x, y]] });
    } else {
      s.setMaskTool(null);
      void personMatte(clipId, toolMask.id, x, y).catch(() => {});
    }
  };

  return (
    <svg className={`mask-overlay${toolOn ? ' tool' : ''}`} width={width} height={height} aria-label="Máscaras">
      {toolMask && <rect className={`tool-hit ${tool!.kind}`} x={0} y={0} width={width} height={height} onPointerDown={toolClick} />}
      {clip.masks.map((m) => {
        const c = maskCentre(m, Math.max(0, local), duration);
        if (m.shape === 'person') {
          return (
            <g key={m.id} className="person-pin">
              <circle cx={m.x * width} cy={m.y * height} r={7} />
              <text x={m.x * width + 11} y={m.y * height + 4}>
                {m.matte ? 'Pessoa' : 'Pessoa: clica nela'}
              </text>
            </g>
          );
        }
        if (m.shape === 'pen') {
          const dx = c.x - m.x;
          const dy = c.y - m.y;
          const pts = (m.points ?? []).map(([px, py]) => [(px + dx) * width, (py + dy) * height] as const);
          const drawing = toolOn && tool!.maskId === m.id;
          return (
            <g key={m.id}>
              {pts.length > 1 && (drawing ? <polyline className="shape pen" points={pts.map((p) => p.join(',')).join(' ')} /> : <polygon className="shape pen" points={pts.map((p) => p.join(',')).join(' ')} onPointerDown={(e) => drag(e, m, 'move')} />)}
              {pts.map(([px, py], i) => (
                <circle key={i} className={`pt${i === 0 ? ' first' : ''}`} cx={px} cy={py} r={i === 0 && drawing ? 7 : 5} onPointerDown={(e) => dragPoint(e, m, i)} />
              ))}
            </g>
          );
        }
        const cx = c.x * width;
        const cy = c.y * height;
        const rx = (m.w * width) / 2;
        const ry = (m.h * height) / 2;
        return (
          <g key={m.id}>
            {m.toX !== undefined && <line className="path" x1={m.x * width} y1={m.y * height} x2={m.toX * width} y2={(m.toY ?? m.y) * height} />}
            {m.shape === 'ellipse' ? (
              <ellipse className="shape" cx={cx} cy={cy} rx={rx} ry={ry} onPointerDown={(e) => drag(e, m, 'move')} />
            ) : (
              <rect className="shape" x={cx - rx} y={cy - ry} width={rx * 2} height={ry * 2} onPointerDown={(e) => drag(e, m, 'move')} />
            )}
            <rect className="handle" x={cx + rx - 5} y={cy + ry - 5} width={10} height={10} rx={2} onPointerDown={(e) => drag(e, m, 'size')} />
            {m.toX !== undefined && <circle className="end" cx={m.toX * width} cy={(m.toY ?? m.y) * height} r={6} onPointerDown={(e) => drag(e, m, 'end')} />}
          </g>
        );
      })}
    </svg>
  );
}
