import { useMemo, useRef, useState } from 'react';
import { useEditor } from '../store';
import { dur, end, fmtTime, projectDuration, r3, speedOf } from '../lib/project';
import { Wave } from './Wave';
import type { Clip, Track } from '../types';
import { Icon } from './Icon';
import { peerColor, useCollab } from '../collab';

const RANK: Record<string, number> = { text: 0, video: 1, audio: 2 };
const SNAP_PX = 8;

/** Tracks top to bottom on screen: text, then video (top layer first), then audio. */
function screenOrder(tracks: Track[]) {
  return tracks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => RANK[a.t.kind]! - RANK[b.t.kind]! || (a.t.kind === 'video' ? b.i - a.i : a.i - b.i))
    .map((x) => x.t);
}

/** Colour role of a track: video, captions (text), music or sound effects (any audio track after the
 *  first one, or one named like an effects track). */
function roleOf(t: Track, tracks: Track[]) {
  if (t.kind !== 'audio') return t.kind;
  if (/efeit|sfx|fx|som/i.test(t.name)) return 'fx';
  if (/m[uú]sica|music/i.test(t.name)) return 'music';
  return tracks.filter((x) => x.kind === 'audio')[0] === t ? 'music' : 'fx';
}

type Drag = { kind: 'move' | 'left' | 'right'; id: string; x0: number; start: number; in: number; out: number; speed: number; trackKind: string };

export function Timeline() {
  const project = useEditor((s) => s.project);
  const zoom = useEditor((s) => s.zoom);
  const playhead = useEditor((s) => s.playhead);
  const peers = useCollab((s) => s.peers);
  const session = useCollab((s) => s.session?.id ?? null);
  const peerSel = useMemo(() => {
    const out: Record<string, string> = {};
    for (const p of Object.values(peers)) if (p.presence?.selected && p.presence.session === session) out[p.presence.selected] = peerColor(p.id);
    return out;
  }, [peers, session]);
  const selected = useEditor((s) => s.selected);
  const snap = useEditor((s) => s.snap);
  const status = useEditor((s) => s.status);
  const busy = useEditor((s) => s.busy);
  const progress = useEditor((s) => s.exportProgress);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const scroll = useRef<HTMLDivElement>(null);
  const heads = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [dropLane, setDropLane] = useState<string | null>(null);
  const st = useEditor.getState;

  const total = projectDuration(project);
  const width = Math.max((total + 20) * zoom, 2000);
  const tracks = useMemo(() => screenOrder(project.tracks), [project.tracks]);
  const media = useMemo(() => new Map(project.media.map((m) => [m.id, m])), [project.media]);

  const timeAt = (clientX: number) => {
    const el = scroll.current!;
    return Math.max(0, (clientX - el.getBoundingClientRect().left + el.scrollLeft) / zoom);
  };

  const snapTime = (t: number, ignore: string) => {
    if (!snap) return t;
    let best = t;
    let bestD = SNAP_PX / zoom;
    const consider = (x: number) => {
      const d = Math.abs(x - t);
      if (d < bestD) {
        bestD = d;
        best = x;
      }
    };
    consider(st().playhead);
    consider(0);
    for (const tr of project.tracks) for (const c of tr.clips) if (c.id !== ignore) (consider(c.start), consider(end(c)));
    for (const mk of project.markers ?? []) consider(mk.t);
    return best;
  };

  // ---------------------------------------------------------------- tick marks
  const step = zoom > 160 ? 0.5 : zoom > 60 ? 1 : zoom > 25 ? 2 : zoom > 12 ? 5 : 10;
  const major = step * 5;
  const ticks = [];
  for (let t = 0; t * zoom < width; t += step) {
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    ticks.push(
      <div key={t} className={`tick${isMajor ? ' major' : ''}`} style={{ left: t * zoom, top: isMajor ? 0 : 14 }}>
        {isMajor && <span>{fmtTime(t, project.canvas.fps)}</span>}
      </div>,
    );
  }

  // ---------------------------------------------------------------- clip gestures
  const onClipDown = (e: React.PointerEvent, c: Clip, kind: Drag['kind'], trackKind: string) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    st().select(c.id);
    st().beginGesture();
    drag.current = { kind, id: c.id, x0: e.clientX, start: c.start, in: c.in, out: c.out, speed: speedOf(c), trackKind };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onClipMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dt = (e.clientX - d.x0) / zoom;
    const len = (d.out - d.in) / d.speed;
    const isMedia = d.trackKind !== 'text';
    st().live((p) => {
      for (const tr of p.tracks)
        for (const c of tr.clips) {
          if (c.id !== d.id) continue;
          const m = c.mediaId ? p.media.find((x) => x.id === c.mediaId) : null;
          const max = m && m.kind !== 'image' ? m.duration : 3600;
          if (d.kind === 'move') {
            let s = Math.max(0, d.start + dt);
            const snappedStart = snapTime(s, d.id);
            const snappedEnd = snapTime(s + len, d.id) - len;
            s = Math.abs(snappedStart - s) <= Math.abs(snappedEnd - s) ? snappedStart : snappedEnd;
            c.start = r3(Math.max(0, s));
          } else if (d.kind === 'left') {
            let ns = snapTime(Math.max(0, d.start + dt), d.id);
            let nin = d.in + (ns - d.start) * d.speed;
            if (isMedia && nin < 0) {
              ns -= nin / d.speed;
              nin = 0;
            }
            if (nin > d.out - 0.1) {
              ns -= (nin - (d.out - 0.1)) / d.speed;
              nin = d.out - 0.1;
            }
            c.start = r3(ns);
            if (isMedia) c.in = r3(nin);
            else c.out = r3(d.out - (ns - d.start));
          } else {
            const nend = snapTime(d.start + len + dt, d.id);
            c.out = r3(Math.max(c.in + 0.1, Math.min(max, d.in + (nend - d.start) * d.speed)));
          }
        }
    });
  };
  const onClipUp = () => {
    if (!drag.current) return;
    drag.current = null;
    st().live((p) => p.tracks.forEach((t) => t.clips.sort((a, b) => a.start - b.start)));
  };

  // ---------------------------------------------------------------- scrubbing
  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    st().seek(timeAt(e.clientX));
    const move = (ev: PointerEvent) => st().seek(timeAt(ev.clientX));
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  const onDrop = (e: React.DragEvent, track: Track) => {
    e.preventDefault();
    setDropLane(null);
    const id = e.dataTransfer.getData('application/x-ec-media');
    const m = id && media.get(id);
    if (!m) return;
    const want = m.kind === 'audio' ? 'audio' : 'video';
    st().addClip(m.id, { start: snapTime(timeAt(e.clientX), ''), trackId: track.kind === want ? track.id : undefined });
  };

  const sel = selected;
  return (
    <section className="timeline" aria-label="Timeline">
      <div className="tl-tools">
        <button className="btn ghost icon" disabled={!canUndo} onClick={() => st().undo()} title="Desfazer (Ctrl+Z)" aria-label="Desfazer">
          <Icon name="undo" />
        </button>
        <button className="btn ghost icon" disabled={!canRedo} onClick={() => st().redo()} title="Refazer (Ctrl+Shift+Z)" aria-label="Refazer">
          <Icon name="redo" />
        </button>
        <span className="sep" />
        <button className="btn sm" onClick={() => st().splitAt(st().playhead, sel)} title="Cortar na cabeça de leitura (S)">
          <Icon name="split" /> Cortar
        </button>
        <button className="btn sm" disabled={!sel} onClick={() => sel && st().deleteClip(sel, true)} title="Apagar e fechar o espaço (Shift+Delete)">
          <Icon name="trash" /> Apagar e juntar
        </button>
        <button className="btn sm" onClick={() => st().addText('Texto', st().playhead, 3, 'title')} title="Acrescentar texto (T)">
          <Icon name="text" /> Texto
        </button>
        <span className="sep" />
        <button className={`btn ghost icon${snap ? ' on' : ''}`} onClick={() => st().setSnap(!snap)} title="Íman: colar às pontas dos clips" aria-pressed={snap} aria-label="Íman">
          <Icon name="magnet" />
        </button>
        <div className="spacer" />
        <button className="btn ghost icon" onClick={() => st().setZoom(zoom / 1.4)} title="Afastar (-)" aria-label="Afastar">
          <Icon name="zoomOut" />
        </button>
        <input className="range" style={{ width: 140 }} type="range" min={8} max={600} value={zoom} onChange={(e) => st().setZoom(Number(e.target.value))} aria-label="Zoom" />
        <button className="btn ghost icon" onClick={() => st().setZoom(zoom * 1.4)} title="Aproximar (+)" aria-label="Aproximar">
          <Icon name="zoomIn" />
        </button>
      </div>

      <div className="tl-body">
        <div className="tl-heads" ref={heads}>
          {tracks.map((t) => (
            <div key={t.id} className={`tl-head r-${roleOf(t, tracks)}${t.kind === 'text' ? ' text' : ''}`}>
              <span className="tname">
                <i />
                {t.name}
              </span>
              {t.kind !== 'audio' && (
                <button className={t.hidden ? 'off' : ''} onClick={() => st().toggleTrack(t.id, 'hidden')} title={t.hidden ? 'Mostrar pista' : 'Esconder pista'} aria-label="Ver pista">
                  <Icon name={t.hidden ? 'eyeOff' : 'eye'} />
                </button>
              )}
              {t.kind !== 'text' && (
                <button className={t.muted ? 'off' : ''} onClick={() => st().toggleTrack(t.id, 'muted')} title={t.muted ? 'Ligar som' : 'Silenciar pista'} aria-label="Som da pista">
                  <Icon name={t.muted ? 'mute' : 'sound'} />
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="tl-scroll" ref={scroll} onScroll={(e) => heads.current && (heads.current.scrollTop = e.currentTarget.scrollTop)} onWheel={(e) => (e.ctrlKey ? (e.preventDefault(), st().setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15))) : undefined)}>
          <div className="tl-inner" style={{ width }}>
            <div className="ruler" onPointerDown={scrub}>
              {ticks}
              {(project.markers ?? []).map((mk) => (
                <div
                  key={mk.id}
                  className={`tl-marker${mk.beat ? ' beat' : ''}`}
                  style={{ left: mk.t * zoom, ...(mk.color ? { color: mk.color } : {}) }}
                  title={mk.beat ? `Batida ${mk.t.toFixed(2)} s` : `${mk.label ?? 'Marcador'} · ${mk.t.toFixed(2)} s · duplo clique apaga`}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (!mk.beat) st().removeMarker(mk.id);
                  }}
                />
              ))}
            </div>
            {tracks.map((t) => (
              <div
                key={t.id}
                className={`lane r-${roleOf(t, tracks)}${t.kind === 'text' ? ' text' : ''}${dropLane === t.id ? ' drop' : ''}`}
                onPointerDown={(e) => {
                  if (e.target === e.currentTarget) {
                    st().select(null);
                    scrub(e);
                  }
                }}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes('application/x-ec-media')) {
                    e.preventDefault();
                    setDropLane(t.id);
                  }
                }}
                onDragLeave={() => setDropLane(null)}
                onDrop={(e) => onDrop(e, t)}
              >
                {t.clips.map((c) => {
                  const m = c.mediaId ? media.get(c.mediaId) : undefined;
                  const w = Math.max(6, dur(c) * zoom);
                  return (
                    <div
                      key={c.id}
                      className={`clip ${t.kind}${sel === c.id ? ' sel' : ''}${peerSel[c.id] ? ' peer-sel' : ''}`}
                      style={{ left: c.start * zoom, width: w, opacity: t.hidden ? 0.4 : 1, ...(peerSel[c.id] ? { ['--pc' as string]: peerSel[c.id] } : {}) }}
                      onPointerDown={(e) => onClipDown(e, c, 'move', t.kind)}
                      onPointerMove={onClipMove}
                      onPointerUp={onClipUp}
                      onDoubleClick={() => st().seek(c.start)}
                      title={c.text ?? m?.name}
                    >
                      {m?.thumb && t.kind === 'video' && <div className="strip" style={{ backgroundImage: `url(${m.thumb})` }} />}
                      {m?.peaks && t.kind !== 'text' && (
                        <div className={`wavebox ${t.kind}`}>
                          <Wave peaks={m.peaks} clip={c} width={w} height={t.kind === 'audio' ? 40 : 18} color={t.kind !== 'audio' ? 'rgba(255,255,255,0.55)' : roleOf(t, tracks) === 'fx' ? 'rgba(255,160,135,0.9)' : 'rgba(110,231,183,0.9)'} />
                        </div>
                      )}
                      {t.kind === 'audio' && !m?.peaks && <div className="wave" />}
                      {c.transitionIn && <div className={`trans in ${c.transitionIn.type}`} style={{ width: Math.min(w, c.transitionIn.d * zoom) }} title={`Entrada: ${c.transitionIn.type} ${c.transitionIn.d}s`} />}
                      {c.transitionOut && <div className={`trans out ${c.transitionOut.type}`} style={{ width: Math.min(w, c.transitionOut.d * zoom) }} title={`Saída: ${c.transitionOut.type} ${c.transitionOut.d}s`} />}
                      {c.keyframes &&
                        [...new Set(Object.values(c.keyframes).flatMap((l) => (l ?? []).map((k) => k.t)))].map((kt) => (
                          <i key={kt} className="kf" style={{ left: kt * zoom }} title={`Keyframe ${kt.toFixed(2)} s`} />
                        ))}
                      <span className="label">
                        {(c.speed ?? 1) !== 1 && <b className="spd">{c.speed}×</b>}
                        {c.text ?? m?.name ?? 'clip'}
                      </span>
                      <div className="h l" onPointerDown={(e) => onClipDown(e, c, 'left', t.kind)} onPointerMove={onClipMove} onPointerUp={onClipUp} />
                      <div className="h r" onPointerDown={(e) => onClipDown(e, c, 'right', t.kind)} onPointerMove={onClipMove} onPointerUp={onClipUp} />
                    </div>
                  );
                })}
              </div>
            ))}
            {Object.values(peers).map((p) =>
              p.presence && p.presence.session && p.presence.session === session ? (
                <div key={p.id} className="peer-head" style={{ left: p.presence.playhead * zoom, ['--pc' as string]: peerColor(p.id) }}>
                  <span>{p.hello?.name ?? ''}</span>
                </div>
              ) : null,
            )}
            <div className="playhead" style={{ left: playhead * zoom }}>
              <span>{fmtTime(playhead, project.canvas.fps)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="status">
        {busy && <span className="busy" aria-hidden="true" />}
        <span className="msg">{status ?? 'Espaço reproduz · S corta · Delete apaga · Ctrl+Z desfaz · arrasta media para a timeline'}</span>
        <div className="spacer" />
        {progress !== null && (
          <>
            <span>Exportar {Math.round(progress * 100)}%</span>
            <span className="progress">
              <i style={{ width: `${progress * 100}%` }} />
            </span>
            <button className="btn sm ghost" onClick={() => void window.ec.cancelExport()}>
              Cancelar
            </button>
          </>
        )}
      </div>
    </section>
  );
}
