import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditor } from '../store';
import { dur, end, fmtTime, isText, projectDuration, r3, speedOf } from '../lib/project';
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

/** Colour role of a track: video, captions (text), the sound of a video track (voice), music or
 *  sound effects (any other audio track after the first one, or one named like an effects track). */
function roleOf(t: Track, tracks: Track[]) {
  // A video track with nothing but texts (captions, titles, graphics) gets the captions colour.
  if (t.kind !== 'audio') return t.clips.length && t.clips.every(isText) ? 'text' : 'video';
  if (t.of) return 'voice';
  if (/efeit|sfx|\bfx\b|som/i.test(t.name)) return 'fx';
  if (/m[uú]sica|music/i.test(t.name)) return 'music';
  return tracks.filter((x) => x.kind === 'audio' && !x.of)[0] === t ? 'music' : 'fx';
}

const WAVE: Record<string, string> = { voice: 'rgba(160,222,255,0.92)', fx: 'rgba(255,160,135,0.9)', music: 'rgba(110,231,183,0.9)' };

type Drag = { kind: 'move' | 'left' | 'right'; id: string; x0: number; start: number; in: number; out: number; speed: number; trackKind: string };
type Menu = { x: number; y: number; trackId: string | null };

/** Right-click menu of a track header: new tracks, rename, order, delete. */
function TrackMenu({ menu, tracks, onClose, onRename }: { menu: Menu; tracks: Track[]; onClose: () => void; onRename: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  const st = useEditor.getState;
  const t = tracks.find((x) => x.id === menu.trackId) ?? null;
  // Kept inside the window.
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.max(8, Math.min(menu.x, innerWidth - r.width - 8)), y: Math.max(8, Math.min(menu.y, innerHeight - r.height - 8)) });
  }, [menu.x, menu.y]);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const shut = () => close.current();
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) shut();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') shut();
    };
    addEventListener('pointerdown', down, true);
    addEventListener('keydown', key, true);
    addEventListener('blur', shut);
    addEventListener('resize', shut);
    return () => {
      removeEventListener('pointerdown', down, true);
      removeEventListener('keydown', key, true);
      removeEventListener('blur', shut);
      removeEventListener('resize', shut);
    };
  }, []);
  const run = (fn: () => void) => () => {
    onClose();
    try {
      fn();
    } catch (e) {
      st().setStatus((e as Error).message);
    }
  };
  const same = t ? tracks.filter((x) => x.kind === t.kind) : [];
  const at = t ? same.indexOf(t) : -1;
  const onlyVideo = t?.kind === 'video' && same.length <= 1;
  const n = t?.clips.length ?? 0;
  return createPortal(
    <div ref={ref} className="tl-menu" role="menu" aria-label={t ? `Pista ${t.name}` : 'Pistas'} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {t && (
        <>
          <button role="menuitem" onClick={run(() => onRename(t.id))}>
            Mudar o nome…
          </button>
          <hr />
        </>
      )}
      <button role="menuitem" onClick={run(() => st().addTrack('video'))}>
        Nova pista de vídeo
      </button>
      <button role="menuitem" onClick={run(() => st().addTrack('audio'))}>
        Nova pista de áudio
      </button>
      {t && (
        <>
          <hr />
          <button role="menuitem" disabled={at <= 0} onClick={run(() => st().moveTrack(t.id, 'up'))}>
            Mover para cima
          </button>
          <button role="menuitem" disabled={at < 0 || at >= same.length - 1} onClick={run(() => st().moveTrack(t.id, 'down'))}>
            Mover para baixo
          </button>
          <hr />
          {t.kind !== 'audio' && (
            <button role="menuitem" onClick={run(() => st().toggleTrack(t.id, 'hidden'))}>
              {t.hidden ? 'Mostrar pista' : 'Esconder pista'}
            </button>
          )}
          {t.kind === 'audio' && (
            <button role="menuitem" onClick={run(() => st().toggleTrack(t.id, 'muted'))}>
              {t.muted ? 'Ligar o som' : 'Silenciar pista'}
            </button>
          )}
          <button role="menuitem" className="danger" disabled={onlyVideo} title={onlyVideo ? 'É a única pista de vídeo' : undefined} onClick={run(() => st().removeTrack(t.id, true))}>
            {n ? `Apagar pista e ${n} ${n === 1 ? 'clip' : 'clips'}` : 'Apagar pista'}
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

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
  const scroll = useRef<HTMLDivElement>(null);
  const heads = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [dropLane, setDropLane] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const linked = useEditor((s) => s.linked);
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
    // Followed on the window: a clip dragged to another track is drawn again there, in another lane.
    const move = (ev: PointerEvent) => gesture.current.move(ev);
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
      gesture.current.up();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    addEventListener('pointercancel', up);
  };
  const onClipMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dt = (e.clientX - d.x0) / zoom;
    const len = (d.out - d.in) / d.speed;
    const isMedia = d.trackKind !== 'text';
    // The lane under the pointer: a clip can go to any other track of its kind.
    const lane = d.kind === 'move' ? (document.elementsFromPoint(e.clientX, e.clientY).find((el) => el instanceof HTMLElement && el.dataset.lane) as HTMLElement | undefined) : undefined;
    const toId = lane?.dataset.lane;
    st().live((p) => {
      if (toId) {
        const from = p.tracks.find((tr) => tr.clips.some((c) => c.id === d.id));
        const to = p.tracks.find((tr) => tr.id === toId);
        if (from && to && from !== to && to.kind === from.kind) {
          const i = from.clips.findIndex((c) => c.id === d.id);
          to.clips.push(...from.clips.splice(i, 1));
        }
      }
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
  // The window listeners of a drag always call the handlers of the latest render (zoom, snapping).
  const gesture = useRef({ move: onClipMove, up: onClipUp });
  gesture.current = { move: onClipMove, up: onClipUp };

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
  // The other half of the selected clip (its sound, or its picture) is marked too.
  const selLink = useMemo(() => (sel ? project.tracks.flatMap((t) => t.clips).find((c) => c.id === sel)?.link : undefined), [project.tracks, sel]);
  const openMenu = (e: React.MouseEvent, trackId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, trackId });
  };
  const videoTracks = tracks.filter((x) => x.kind === 'video').length;
  return (
    <section className="timeline" aria-label="Timeline">
      <div className="tl-tools">
        <button className="btn icon round" onClick={() => st().addText('Texto', st().playhead, 3, 'title')} title="Acrescentar texto (T)" aria-label="Acrescentar texto">
          <Icon name="text" />
        </button>
        <button className="btn icon round" onClick={() => st().splitAt(st().playhead, sel)} title="Cortar na cabeça de leitura (S)" aria-label="Cortar na cabeça de leitura">
          <Icon name="scissors" />
        </button>
        <button className="btn icon round" disabled={!sel} onClick={() => sel && st().deleteClip(sel, true)} title="Apagar e fechar o espaço (Shift+Delete)" aria-label="Apagar e fechar o espaço">
          <Icon name="trash" />
        </button>
        <button className={`btn icon round${snap ? ' on' : ''}`} onClick={() => st().setSnap(!snap)} title="Íman: colar às pontas dos clips" aria-pressed={snap} aria-label="Íman">
          <Icon name="magnet" />
        </button>
        <button className={`btn icon round${linked ? ' on' : ''}`} onClick={() => st().setLinked(!linked)} title={linked ? 'Imagem e som ligados: movem-se, cortam-se e apagam-se juntos (clica para mexer em cada um à parte)' : 'Imagem e som soltos: cada um mexe-se à parte (clica para voltar a ligar)'} aria-pressed={linked} aria-label="Ligar imagem e som">
          <Icon name="link" />
        </button>
        <div className="tl-add" role="group" aria-label="Nova pista">
          <button className="btn icon round" onClick={() => setAddOpen((o) => !o)} title="Nova pista" aria-label="Nova pista" aria-expanded={addOpen}>
            <Icon name="plus" />
          </button>
          {addOpen && (
            <div className="tl-add-menu" role="menu">
              {(
                [
                  ['video', 'Pista de vídeo'],
                  ['audio', 'Pista de áudio'],
                ] as const
              ).map(([k, l]) => (
                <button
                  key={k}
                  role="menuitem"
                  onClick={() => {
                    st().addTrack(k);
                    setAddOpen(false);
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="spacer" />
        <div className="tl-zoom" role="group" aria-label="Zoom da timeline">
          <button className="btn ghost icon" onClick={() => st().setZoom(zoom / 1.4)} title="Afastar (-)" aria-label="Afastar">
            <Icon name="zoomOut" />
          </button>
          <input className="range" type="range" min={8} max={600} value={zoom} onChange={(e) => st().setZoom(Number(e.target.value))} aria-label="Zoom" />
          <button className="btn ghost icon" onClick={() => st().setZoom(zoom * 1.4)} title="Aproximar (+)" aria-label="Aproximar">
            <Icon name="zoomIn" />
          </button>
        </div>
      </div>

      <div className="tl-body">
        <div className="tl-heads" ref={heads} onContextMenu={(e) => openMenu(e, null)}>
          {tracks.map((t) => (
            <div key={t.id} className={`tl-head r-${roleOf(t, tracks)}${menu?.trackId === t.id ? ' menu-open' : ''}`} onContextMenu={(e) => openMenu(e, t.id)} title="Botão direito: opções da pista">
              <span className="tname" onDoubleClick={() => setRenaming(t.id)}>
                <i />
                {renaming === t.id ? (
                  <input
                    className="tl-rename"
                    autoFocus
                    defaultValue={t.name}
                    maxLength={40}
                    aria-label="Nome da pista"
                    onFocus={(e) => e.currentTarget.select()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      else if (e.key === 'Escape') {
                        e.currentTarget.value = t.name;
                        e.currentTarget.blur();
                      }
                    }}
                    onBlur={(e) => {
                      const v = e.currentTarget.value.trim();
                      setRenaming(null);
                      if (v && v !== t.name) st().renameTrack(t.id, v);
                    }}
                  />
                ) : (
                  <span className="tlabel">{t.name}</span>
                )}
              </span>
              {t.kind !== 'audio' && (
                <button className={t.hidden ? 'off' : ''} onClick={() => st().toggleTrack(t.id, 'hidden')} title={t.hidden ? 'Mostrar pista' : 'Esconder pista'} aria-label="Ver pista">
                  <Icon name={t.hidden ? 'eyeOff' : 'eye'} />
                </button>
              )}
              {t.kind === 'audio' && (
                <button className={t.muted ? 'off' : ''} onClick={() => st().toggleTrack(t.id, 'muted')} title={t.muted ? 'Ligar som' : 'Silenciar pista'} aria-label="Som da pista">
                  <Icon name={t.muted ? 'mute' : 'sound'} />
                </button>
              )}
              {!t.clips.length && (t.kind !== 'video' || videoTracks > 1) && (
                <button onClick={() => st().removeTrack(t.id)} title="Apagar pista vazia" aria-label="Apagar pista">
                  <Icon name="close" />
                </button>
              )}
            </div>
          ))}
        </div>
        {menu && <TrackMenu menu={menu} tracks={tracks} onClose={() => setMenu(null)} onRename={setRenaming} />}

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
                className={`lane r-${roleOf(t, tracks)}${dropLane === t.id ? ' drop' : ''}`}
                data-lane={t.id}
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
                  // A text is a clip like any other on a video track; it keeps its own colour.
                  const kind = isText(c) ? 'text' : t.kind;
                  return (
                    <div
                      key={c.id}
                      className={`clip ${kind}${kind === 'text' ? ' r-text' : ''}${sel === c.id ? ' sel' : ''}${selLink && c.link === selLink && sel !== c.id ? ' link-sel' : ''}${peerSel[c.id] ? ' peer-sel' : ''}`}
                      style={{ left: c.start * zoom, width: w, opacity: t.hidden || (t.kind === 'audio' && t.muted) ? 0.4 : 1, ...(peerSel[c.id] ? { ['--pc' as string]: peerSel[c.id] } : {}) }}
                      onPointerDown={(e) => onClipDown(e, c, 'move', kind)}
                      onDoubleClick={() => st().seek(c.start)}
                      title={c.text ?? m?.name}
                    >
                      {m?.thumb && kind === 'video' && <div className="strip" style={{ backgroundImage: `url(${m.thumb})` }} />}
                      {m?.peaks && kind !== 'text' && !(kind === 'video' && c.silent) && (
                        <div className={`wavebox ${t.kind}`}>
                          <Wave peaks={m.peaks} clip={c} width={w} height={t.kind === 'audio' ? 40 : 18} color={t.kind !== 'audio' ? 'rgba(255,255,255,0.55)' : (WAVE[roleOf(t, tracks)] ?? WAVE.music!)} />
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
                      <div className="h l" onPointerDown={(e) => onClipDown(e, c, 'left', kind)} />
                      <div className="h r" onPointerDown={(e) => onClipDown(e, c, 'right', kind)} />
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
        <span className="msg">{status ?? 'Espaço reproduz · S corta · Delete apaga · Ctrl+Z desfaz · arrasta clips entre pistas · botão direito no nome da pista: opções'}</span>
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
