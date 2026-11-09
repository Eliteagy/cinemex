import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../store';
import { Player } from '../engine/player';
import { fmtTime, projectDuration } from '../lib/project';
import { Icon } from './Icon';
import { MaskOverlay } from './MaskOverlay';
import { CaptionOverlay } from './CaptionOverlay';

export function Viewer() {
  const ref = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const player = useRef<Player | null>(null);
  const playing = useEditor((s) => s.playing);
  const playhead = useEditor((s) => s.playhead);
  const project = useEditor((s) => s.project);
  const total = projectDuration(project);
  const fps = project.canvas.fps;

  useEffect(() => {
    if (!ref.current) return;
    const p = new Player(
      ref.current,
      () => useEditor.getState(),
      (t) => useEditor.setState({ playhead: t }),
      () => useEditor.getState().setPlaying(false),
    );
    player.current = p;
    return () => p.destroy();
  }, []);
  useEffect(() => player.current?.invalidate(), [project, playhead]);
  // Fit the frame inside the stage, keeping the project's aspect ratio.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e!.contentRect.width, h: e!.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const k = box.w && box.h ? Math.min(box.w / project.canvas.w, box.h / project.canvas.h) : 0;

  const s = useEditor.getState;
  return (
    <section className="viewer" aria-label="Visor">
      <div className="ph vh">
        <span>{project.name}</span>
        <span className="spacer" />
        <span className="tc">{fmtTime(playhead, fps)}</span>
      </div>
      <div className="stage" ref={stage}>
        <canvas ref={ref} style={{ width: Math.floor(project.canvas.w * k), height: Math.floor(project.canvas.h * k) }} />
        <MaskOverlay width={Math.floor(project.canvas.w * k)} height={Math.floor(project.canvas.h * k)} />
        <CaptionOverlay width={Math.floor(project.canvas.w * k)} height={Math.floor(project.canvas.h * k)} />
        {!total && (
          <div className="empty">
            <div className="empty-state">
              <span className="orb">
                <Icon name="play" />
              </span>
              <strong>Timeline vazia</strong>
              Importa média e arrasta-a para a timeline, ou pede ao Claude.
            </div>
          </div>
        )}
      </div>
      <div className="transport">
        <button className="btn ghost icon" onClick={() => s().seek(0)} title="Início (Home)" aria-label="Início">
          <Icon name="start" />
        </button>
        <button className="play" onClick={() => s().setPlaying(!playing)} title="Reproduzir / pausa (Espaço)" aria-label={playing ? 'Pausa' : 'Reproduzir'}>
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <button className="btn ghost icon" onClick={() => s().seek(total)} title="Fim (End)" aria-label="Fim">
          <Icon name="end" />
        </button>
        <div className="timecode">
          {fmtTime(playhead, fps)} <span>/ {fmtTime(total, fps)}</span>
        </div>
      </div>
    </section>
  );
}
