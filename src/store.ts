import { create } from 'zustand';
import type { CanvasPreset, Clip, Media, Project, Track } from './types';
import { KEY_DEFAULT, PRESETS, STYLES, activeClip, dur, end, findClip, kfValue, newProject, projectDuration, r3, speechSegments, speedOf, trackEnd, uid } from './lib/project';
import type { AudioSettings, CaptionStyle, FNode, FNodeType, Fusion, Grade, KeyProp, Mask, MaskMode, Transition } from './types';
import fusionNodes from './lib/fusion-nodes.json';
import type { CaptionOverride } from './types';
import { MY_STYLE_ID, cleanOverride, validateStyle } from './lib/capstyle.js';
import { cleanLines } from './lib/emphasis.js';
import { motionPreset, pulseKeys } from './lib/fx.js';
import type { MotionPreset } from './lib/fx.js';
import { graphicOf } from './lib/graphics.js';
import type { Graphic, GraphicKind, Marker } from './types';
import type { BlendMode, Ease, Effect, Matte, Modifier } from './types';
import { EFFECT_DEFAULTS } from './lib/layerfx.js';

const MAX_HISTORY = 150;
const clone = <T,>(v: T): T => structuredClone(v);

export type Page = 'media' | 'edit' | 'fusion' | 'color' | 'captions' | 'deliver';

export interface EditorState {
  page: Page;
  setPage(p: Page): void;
  project: Project;
  filePath: string | null;
  dirty: boolean;
  selected: string | null;
  playhead: number;
  playing: boolean;
  zoom: number; // pixels per second
  snap: boolean;
  status: string | null;
  busy: boolean;
  exportProgress: number | null;
  past: Project[];
  future: Project[];

  /** Apply a change as one undoable step. */
  commit(fn: (p: Project) => void): void;
  /** Gestures (drag/trim): snapshot once at the start, then live changes without history. */
  beginGesture(): void;
  /** Slider drag: one undo step for the whole drag (ends on pointer up). */
  startSlide(): void;
  live(fn: (p: Project) => void): void;
  undo(): void;
  redo(): void;

  load(p: Project, path?: string | null): void;
  reset(): void;
  setName(name: string): void;
  setCanvas(preset: CanvasPreset): void;
  addMedia(list: Media[]): void;
  setTranscript(mediaId: string, words: Media['transcript'], key?: string): void;
  addClip(mediaId: string, opts?: { trackId?: string; start?: number; in?: number; out?: number }): string;
  addText(text: string, start: number, duration: number, style?: string, y?: number): string;
  replaceAutoCaptions(range: { start: number; end: number } | null, clips: Omit<Clip, 'id'>[]): number;
  updateClip(id: string, patch: Partial<Clip>): void;
  moveClip(id: string, start: number, trackId?: string): void;
  trimClip(id: string, edge: { in?: number; out?: number }): void;
  splitAt(time: number, clipId?: string | null): number;
  deleteClip(id: string, ripple?: boolean): void;
  cutSilences(id: string, minPause?: number, padding?: number): { removed: number; pieces: number; ids: string[]; range: { start: number; end: number } };
  toggleTrack(id: string, key: 'muted' | 'hidden'): void;
  setSpeed(id: string, speed: number): void;
  setTransition(id: string, side: 'in' | 'out', tr: Transition | null): void;
  dissolveWithPrevious(id: string, d?: number): void;
  setKeyframe(id: string, prop: KeyProp, time: number, value: number): void;
  removeKeyframe(id: string, prop: KeyProp, t: number): void;
  clearKeyframes(id: string): void;
  animate(id: string, preset: MotionPreset, opts?: { amount?: number; every?: number }): void;
  /** After Effects-style interpolation of the keyframe at local time t (null prop = every property at t). */
  setKeyframeEase(id: string, prop: KeyProp | null, time: number, ease: Ease, bz?: [number, number, number, number]): number;
  /** Expression-like modifier of a property (wiggle, loop, overshoot); null removes it. */
  setModifier(id: string, prop: KeyProp, mod: Modifier | null): void;
  setBlend(id: string, mode: BlendMode): void;
  setMatte(id: string, matte: Matte | null): void;
  addEffect(id: string, type: Effect['type'], params?: Record<string, unknown>): string;
  updateEffect(id: string, effectId: string, params: Record<string, unknown>): void;
  removeEffect(id: string, effectId: string): void;
  /** Graphic clip (lower third, title, label, progress bar) on the text track. */
  addGraphic(kind: GraphicKind, start: number, duration: number, patch?: Partial<Graphic>): string;
  updateGraphic(id: string, patch: Partial<Graphic>): void;
  addMarker(t: number, label?: string, color?: string): string;
  removeMarker(id: string): void;
  /** Beat markers (replace the previous beats). */
  setBeats(times: number[]): number;
  clearMarkers(beatsOnly?: boolean): number;
  /** Zoom kick on every beat marker for video clips (ids or all). */
  beatPulse(ids: string[] | 'all', amount?: number): number;
  /** Move each visible cut on the video tracks to the nearest beat (within maxShift s). */
  snapCutsToBeats(maxShift?: number): number;
  /** Put an audio media (sound effect) on the SFX track, made when missing. */
  addSfxClip(mediaId: string, start: number, volume?: number): string;
  /** Freeze frame: the still (image media) is inserted at `time` on the clip's track for `length` s and the rest is pushed back. */
  insertFreeze(clipId: string, time: number, imageId: string, length: number): string;
  replaceProject(p: Project): void;
  /** Colour grade of clips (merged into the current grade; null clears it). */
  setGrade(ids: string[] | 'all', grade: Grade | null, replace?: boolean): number;
  /** Own caption style: merged into the current one, or replaced (replace=true). */
  setCaptionStyle(patch: Partial<CaptionStyle> | null, replace?: boolean): void;
  /** Give every caption on the timeline one style. */
  styleAllCaptions(style: string): number;
  /** Saved caption styles (userData/caption-styles.json), shared by every project. */
  userStyles: Record<string, CaptionStyle>;
  loadUserStyles(): Promise<void>;
  /** Save a style (null id = new). Projects using it get the new version embedded. */
  saveUserStyle(id: string | null, style: CaptionStyle): Promise<string>;
  deleteUserStyle(id: string): Promise<boolean>;
  /** Give captions (ids or all) a style; saved styles are embedded in the project. */
  applyCaptionStyle(style: string, ids: string[] | 'all'): number;
  /** Per-caption look: merged into the captions' override (null clears it and their size). */
  setCaptionOverride(ids: string[] | 'all', patch: CaptionOverride | null): number;
  /** "Aplicar a todas": every caption gets this caption's override and size. */
  copyCaptionLook(fromId: string): number;
  /** Felipe/Marta line positions (null = back to the style's places). */
  setCaptionLines(ids: string[] | 'all', lines: Clip['lines'] | null): number;
  /** Same change on several captions, one undo step. */
  updateCaptions(ids: string[], patch: Partial<Clip>): void;
  /** Join a caption with the next one on its track (their words and timings kept). */
  mergeCaptionWithNext(id: string): boolean;
  setAudio(patch: AudioSettings): void;
  addMask(clipId: string, shape?: Mask['shape'], mode?: MaskMode): string;
  /** Viewer tool for a mask: draw a pen shape, or click the person to cut out. */
  maskTool: { clipId: string; maskId: string; kind: 'pen' | 'pick' } | null;
  setMaskTool(t: { clipId: string; maskId: string; kind: 'pen' | 'pick' } | null): void;
  updateMask(clipId: string, maskId: string, patch: Partial<Omit<Mask, 'id'>>): void;
  removeMask(clipId: string, maskId: string): void;
  /** Fusion: node graph of a clip (created with In -> Out on first use). */
  addNode(clipId: string, type: FNodeType, after?: string | null, at?: { x: number; y: number }): string;
  setNodeParams(clipId: string, nodeId: string, p: FNode['p']): void;
  removeNode(clipId: string, nodeId: string): void;
  linkNodes(clipId: string, from: string, to: string, port: number): void;
  unlinkPort(clipId: string, to: string, port: number): void;
  resetFusion(clipId: string): void;
  /** Put captions from a subtitles file on the text track (replace=true removes the others). */
  addCaptions(list: { start: number; end: number; text: string }[], replace: boolean, style?: string): number;

  select(id: string | null): void;
  seek(t: number): void;
  setPlaying(v: boolean): void;
  setZoom(z: number): void;
  setSnap(v: boolean): void;
  setStatus(s: string | null, busy?: boolean): void;
  setExportProgress(p: number | null): void;
  markSaved(path: string): void;
}

const minLen = 0.1;

const NODE_INPUTS = Object.fromEntries(Object.entries(fusionNodes as Record<string, { inputs?: string[] }>).map(([k, v]) => [k, v.inputs?.length ?? 0])) as Record<string, number>;

function fusionOf(p: Project, clipId: string): Fusion {
  const f = findClip(p, clipId);
  if (!f || !f.clip.mediaId || f.track.kind !== 'video') throw new Error('O Fusion funciona em clips de vídeo ou imagem');
  return (f.clip.fusion ??= {
    nodes: [
      { id: 'in', type: 'mediaIn', x: 30, y: 90, p: {} },
      { id: 'out', type: 'mediaOut', x: 560, y: 90, p: {} },
    ],
    links: [{ from: 'in', to: 'out', port: 0 }],
  });
}

/** True if `to` already feeds `from` (a new link from -> to would make a loop). */
function reaches(f: Fusion, from: string, to: string, depth = 0): boolean {
  if (from === to) return true;
  if (depth > 64) return true;
  return f.links.filter((l) => l.to === from).some((l) => reaches(f, l.from, to, depth + 1));
}
/** Copy a saved style into the project when captions use it (renders the same on another PC). */
function embedStyle(p: Project, style: string | undefined, userStyles: Record<string, CaptionStyle>) {
  if (style && !STYLES[style] && userStyles[style]) (p.styles ??= {})[style] = clone(userStyles[style]!);
}

/** Old projects: the project-level style ('custom') becomes the saved style "O meu estilo". */
function migrateCaptionStyle(p: Project): CaptionStyle | null {
  if (!p.captionStyle) return null;
  const st = validateStyle({ ...p.captionStyle, label: 'O meu estilo' });
  delete p.captionStyle;
  if (!st) return null;
  (p.styles ??= {})[MY_STYLE_ID] = st;
  for (const t of p.tracks) for (const c of t.clips) if (c.style === 'custom') c.style = MY_STYLE_ID;
  return st;
}

/** Only numbers and #RRGGBB colours go into effect settings. */
function cleanFx(v: Record<string, unknown>) {
  const out: Record<string, number | string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === 'id' || k === 'type') continue;
    if (typeof x === 'number' && Number.isFinite(x)) out[k] = r3(x);
    else if (typeof x === 'string' && /^#[0-9a-fA-F]{6}$/.test(x)) out[k] = x.toUpperCase();
  }
  return out;
}

/** Slider drag state (see startSlide). */
let slide: 'off' | 'armed' | 'open' = 'off';

function mediaOf(p: Project, id?: string) {
  return p.media.find((m) => m.id === id);
}

function pickTrack(p: Project, m: Media, start: number, len: number): Track {
  const kind = m.kind === 'audio' ? 'audio' : 'video';
  const tracks = p.tracks.filter((t) => t.kind === kind);
  const free = tracks.find((t) => !t.clips.some((c) => c.start < start + len - 0.001 && end(c) > start + 0.001));
  return free ?? tracks[0]!;
}

export const useEditor = create<EditorState>((set, get) => ({
  page: 'edit',
  setPage(page) {
    set({ page });
  },
  project: newProject(),
  filePath: null,
  dirty: false,
  selected: null,
  playhead: 0,
  playing: false,
  zoom: 80,
  snap: true,
  status: null,
  busy: false,
  exportProgress: null,
  past: [],
  future: [],

  commit(fn) {
    const before = get().project;
    const next = clone(before);
    fn(next);
    // While a slider is dragged only the first change goes into the history.
    if (slide === 'open') set({ project: next, dirty: true });
    else {
      set((s) => ({ project: next, past: [...s.past, before].slice(-MAX_HISTORY), future: [], dirty: true }));
      if (slide === 'armed') slide = 'open';
    }
  },
  startSlide() {
    slide = 'armed';
    const stop = () => {
      slide = 'off';
      removeEventListener('pointerup', stop);
    };
    addEventListener('pointerup', stop);
  },
  beginGesture() {
    set((s) => ({ past: [...s.past, s.project].slice(-MAX_HISTORY), future: [] }));
  },
  live(fn) {
    const next = clone(get().project);
    fn(next);
    set({ project: next, dirty: true });
  },
  undo() {
    const { past, project, future } = get();
    const prev = past[past.length - 1];
    if (!prev) return;
    set({ project: prev, past: past.slice(0, -1), future: [project, ...future].slice(0, MAX_HISTORY), dirty: true });
  },
  redo() {
    const { past, project, future } = get();
    const next = future[0];
    if (!next) return;
    set({ project: next, future: future.slice(1), past: [...past, project].slice(-MAX_HISTORY), dirty: true });
  },

  load(p, path = null) {
    const mine = migrateCaptionStyle(p);
    if (mine && !get().userStyles[MY_STYLE_ID]) void get().saveUserStyle(MY_STYLE_ID, mine).catch(() => {});
    set({ project: p, filePath: path, dirty: false, past: [], future: [], selected: null, playhead: 0, playing: false });
  },
  reset() {
    get().load(newProject(), null);
  },
  setName(name) {
    get().commit((p) => void (p.name = name.trim() || 'Projeto sem título'));
  },
  setCanvas(preset) {
    const d = PRESETS[preset];
    get().commit((p) => void (p.canvas = { ...p.canvas, w: d.w, h: d.h, preset }));
  },
  addMedia(list) {
    get().commit((p) => {
      for (const m of list) if (!p.media.some((x) => x.id === m.id)) p.media.push(m);
    });
  },
  setTranscript(mediaId, words, key) {
    get().commit((p) => {
      const m = mediaOf(p, mediaId);
      if (m) {
        m.transcript = words;
        if (key) m.transcriptKey = key;
      }
    });
  },
  addClip(mediaId, opts = {}) {
    const id = uid('c');
    get().commit((p) => {
      const m = mediaOf(p, mediaId);
      if (!m) throw new Error('Media desconhecida');
      const cin = Math.max(0, Math.min(opts.in ?? 0, m.duration - minLen));
      const cout = Math.max(cin + minLen, Math.min(opts.out ?? m.duration, m.duration));
      const len = cout - cin;
      const track =
        (opts.trackId && p.tracks.find((t) => t.id === opts.trackId && t.kind === (m.kind === 'audio' ? 'audio' : 'video'))) ||
        (opts.start === undefined ? p.tracks.find((t) => t.kind === (m.kind === 'audio' ? 'audio' : 'video')) : pickTrack(p, m, opts.start, len))!;
      const start = r3(opts.start ?? trackEnd(track));
      track.clips.push({ id, mediaId, start, in: r3(cin), out: r3(cout), volume: 1, fit: 'fill' });
      track.clips.sort((a, b) => a.start - b.start);
    });
    set({ selected: id });
    return id;
  },
  addText(text, start, duration, style = 'title', y) {
    const id = uid('c');
    get().commit((p) => {
      const t = p.tracks.find((x) => x.kind === 'text')!;
      t.clips.push({ id, start: r3(Math.max(0, start)), in: 0, out: r3(Math.max(minLen, duration)), text, style, ...(y !== undefined ? { y } : {}) });
      t.clips.sort((a, b) => a.start - b.start);
    });
    set({ selected: id });
    return id;
  },
  replaceAutoCaptions(range, clips) {
    get().commit((p) => {
      const t = p.tracks.find((x) => x.kind === 'text')!;
      t.clips = t.clips.filter((c) => !c.auto || (range && (end(c) <= range.start || c.start >= range.end)));
      for (const c of clips) t.clips.push({ ...c, id: uid('c'), auto: true });
      t.clips.sort((a, b) => a.start - b.start);
    });
    return clips.length;
  },
  updateClip(id, patch) {
    get().commit((p) => {
      const f = findClip(p, id);
      if (!f) throw new Error(`Clip não encontrado: ${id}`);
      Object.assign(f.clip, patch);
      if ('override' in patch) {
        const o = cleanOverride(patch.override);
        if (o) f.clip.override = o;
        else delete f.clip.override;
      }
      if (patch.style) embedStyle(p, patch.style === 'custom' ? MY_STYLE_ID : patch.style, get().userStyles);
      if (f.clip.style === 'custom') f.clip.style = MY_STYLE_ID;
      if (f.clip.volume !== undefined) f.clip.volume = Math.max(0, Math.min(2, f.clip.volume));
    });
  },
  moveClip(id, start, trackId) {
    get().commit((p) => {
      const f = findClip(p, id);
      if (!f) throw new Error(`Clip não encontrado: ${id}`);
      f.clip.start = r3(Math.max(0, start));
      if (trackId && trackId !== f.track.id) {
        const to = p.tracks.find((t) => t.id === trackId && t.kind === f.track.kind);
        if (to) {
          f.track.clips.splice(f.index, 1);
          to.clips.push(f.clip);
        }
      }
      for (const t of p.tracks) t.clips.sort((a, b) => a.start - b.start);
    });
  },
  trimClip(id, edge) {
    get().commit((p) => {
      const f = findClip(p, id);
      if (!f) throw new Error(`Clip não encontrado: ${id}`);
      const m = mediaOf(p, f.clip.mediaId);
      const max = m && m.kind !== 'image' ? m.duration : 3600;
      if (edge.in !== undefined) f.clip.in = r3(Math.max(0, Math.min(edge.in, f.clip.out - minLen)));
      if (edge.out !== undefined) f.clip.out = r3(Math.min(max, Math.max(edge.out, f.clip.in + minLen)));
    });
  },
  splitAt(time, clipId) {
    let n = 0;
    get().commit((p) => {
      for (const track of p.tracks) {
        const add: Clip[] = [];
        for (const c of track.clips) {
          if (clipId && c.id !== clipId) continue;
          if (time <= c.start + 0.05 || time >= end(c) - 0.05) continue;
          const cut = r3(c.in + (time - c.start) * speedOf(c));
          const right: Clip = { ...clone(c), id: uid('c'), start: r3(time), in: cut };
          if (c.keyframes) {
            // Keep the animation continuous: both halves get a keyframe at the cut.
            const off = time - c.start;
            const left: NonNullable<Clip['keyframes']> = {};
            const rightK: NonNullable<Clip['keyframes']> = {};
            for (const [prop, list] of Object.entries(c.keyframes) as [KeyProp, { t: number; v: number }[] | undefined][]) {
              if (!list?.length) continue;
              const v = r3(kfValue(list, off, KEY_DEFAULT[prop]));
              left[prop] = [...list.filter((k) => k.t < off), { t: r3(off), v }];
              rightK[prop] = [{ t: 0, v }, ...list.filter((k) => k.t > off).map((k) => ({ t: r3(k.t - off), v: k.v }))];
            }
            c.keyframes = left;
            right.keyframes = rightK;
          }
          if (c.transitionOut) right.transitionOut = c.transitionOut;
          c.transitionOut = null;
          right.transitionIn = null;
          if (c.words) {
            const off = time - c.start;
            right.words = c.words.filter((w) => w.s >= off).map((w) => ({ ...w, s: r3(w.s - off), e: r3(w.e - off) }));
            c.words = c.words.filter((w) => w.s < off);
          }
          if (c.text !== undefined && !c.mediaId) {
            right.in = 0;
            right.out = r3(end(c) - time);
            c.out = r3(time - c.start);
          } else c.out = cut;
          add.push(right);
          n++;
        }
        track.clips.push(...add);
        track.clips.sort((a, b) => a.start - b.start);
      }
    });
    return n;
  },
  deleteClip(id, ripple = false) {
    get().commit((p) => {
      const f = findClip(p, id);
      if (!f) throw new Error(`Clip não encontrado: ${id}`);
      const gap = dur(f.clip);
      const at = f.clip.start;
      f.track.clips.splice(f.index, 1);
      if (ripple) for (const c of f.track.clips) if (c.start >= at) c.start = r3(c.start - gap);
    });
    if (get().selected === id) set({ selected: null });
  },
  cutSilences(id, minPause = 0.5, padding = 0.12) {
    const p0 = get().project;
    const f = findClip(p0, id);
    if (!f) throw new Error(`Clip não encontrado: ${id}`);
    const m = mediaOf(p0, f.clip.mediaId);
    if (!m?.transcript?.length) throw new Error('Este clip ainda não tem transcrição');
    const segs = speechSegments(f.clip, m.transcript, minPause, padding);
    if (!segs.length) throw new Error('Não encontrei fala neste clip');
    let removed = 0;
    let ids: string[] = [];
    const range = { start: f.clip.start, end: end(f.clip) };
    get().commit((p) => {
      const g = findClip(p, id)!;
      const oldEnd = end(g.clip);
      let t = g.clip.start;
      const pieces = segs.map((s, i) => {
        const c: Clip = { ...clone(g.clip), id: i === 0 ? g.clip.id : uid('c'), start: r3(t), in: s.in, out: s.out };
        delete c.words;
        t += (s.out - s.in) / speedOf(g.clip);
        return c;
      });
      removed = r3(oldEnd - t);
      ids = pieces.map((c) => c.id);
      g.track.clips.splice(g.index, 1, ...pieces);
      for (const c of g.track.clips) if (!pieces.includes(c) && c.start >= oldEnd - 0.001) c.start = r3(c.start - removed);
      g.track.clips.sort((a, b) => a.start - b.start);
    });
    return { removed, pieces: segs.length, ids, range };
  },
  setSpeed(id, speed) {
    get().commit((p) => {
      const f = findClip(p, id);
      if (!f || !f.clip.mediaId) throw new Error('Velocidade só em clips de vídeo ou áudio');
      f.clip.speed = r3(Math.max(0.25, Math.min(4, speed)));
    });
  },
  setTransition(id, side, tr) {
    get().commit((p) => {
      const f = findClip(p, id);
      if (!f) throw new Error(`Clip não encontrado: ${id}`);
      const key = side === 'in' ? 'transitionIn' : 'transitionOut';
      f.clip[key] = tr ? { type: tr.type, d: r3(Math.max(0.05, Math.min(tr.d, dur(f.clip)))) } : null;
    });
  },
  dissolveWithPrevious(id, d = 0.5) {
    get().commit((p) => {
      const f = findClip(p, id);
      if (!f) throw new Error(`Clip não encontrado: ${id}`);
      const prev = f.track.clips.filter((c) => c.id !== id && end(c) <= f.clip.start + 0.05).sort((a, b) => end(b) - end(a))[0];
      if (!prev) throw new Error('Não há clip antes deste na mesma pista');
      const len = r3(Math.min(d, dur(f.clip) / 2, dur(prev) / 2));
      // Overlap the clip with the previous one by `len` and pull the rest of the track back.
      const shift = r3(f.clip.start - (end(prev) - len));
      for (const c of f.track.clips) if (c.start >= f.clip.start - 0.001) c.start = r3(c.start - shift);
      f.clip.transitionIn = { type: 'fade', d: len };
    });
  },
  setKeyframe(id, prop, time, value) {
    get().commit((p) => {
      const f = findClip(p, id);
      if (!f || (!f.clip.mediaId && !f.clip.null)) throw new Error('Keyframes só em clips de vídeo, imagem ou null');
      const t = r3(Math.max(0, Math.min(dur(f.clip), time - f.clip.start)));
      const lim: Record<KeyProp, [number, number]> = { zoom: [1, 4], x: [-0.5, 0.5], y: [-0.5, 0.5], rotate: [-180, 180], opacity: [0, 1], scale: [0.02, 4], px: [-1.5, 1.5], py: [-1.5, 1.5] };
      const [lo, hi] = lim[prop];
      const v = Math.max(lo, Math.min(hi, value));
      const kf = (f.clip.keyframes ??= {});
      const old = (kf[prop] ?? []).find((k) => Math.abs(k.t - t) <= 0.02);
      const list = (kf[prop] ?? []).filter((k) => Math.abs(k.t - t) > 0.02);
      // A keyframe moved by a slider keeps its interpolation.
      list.push({ t, v: r3(v), ...(old?.ease ? { ease: old.ease } : {}), ...(old?.bz ? { bz: old.bz } : {}) });
      kf[prop] = list.sort((a, b) => a.t - b.t);
    });
  },
  removeKeyframe(id, prop, t) {
    get().commit((p) => {
      const f = findClip(p, id);
      const list = f?.clip.keyframes?.[prop];
      if (f && list) f.clip.keyframes![prop] = list.filter((k) => Math.abs(k.t - t) > 0.001);
    });
  },
  clearKeyframes(id) {
    get().commit((p) => {
      const f = findClip(p, id);
      if (f) delete f.clip.keyframes;
    });
  },
  animate(id, preset, opts) {
    get().commit((p) => {
      const f = findClip(p, id);
      if (!f || !f.clip.mediaId) throw new Error('Animação só em clips de vídeo ou imagem');
      const kf = motionPreset(preset, dur(f.clip), f.clip.id, opts);
      if (!kf) throw new Error(`Animação desconhecida: ${preset}`);
      // Rotation/opacity presets keep the zoom/pan already there, and the other way round.
      f.clip.keyframes = preset === 'fade_in_out' ? { ...f.clip.keyframes, ...kf } : kf;
    });
  },
  setKeyframeEase(id, prop, time, ease, bz) {
    let n = 0;
    get().commit((p) => {
      const f = findClip(p, id);
      if (!f?.clip.keyframes) throw new Error('Este clip não tem keyframes');
      const t = time - f.clip.start;
      for (const [k, list] of Object.entries(f.clip.keyframes) as [KeyProp, { t: number; v: number; ease?: Ease; bz?: [number, number, number, number] }[] | undefined][]) {
        if (prop && k !== prop) continue;
        for (const kf of list ?? []) {
          if (Math.abs(kf.t - t) > 0.04) continue;
          if (ease === 'smooth') delete kf.ease;
          else kf.ease = ease;
          if (ease === 'bezier' && bz) kf.bz = bz.map((v) => r3(v)) as [number, number, number, number];
          else delete kf.bz;
          n++;
        }
      }
    });
    if (!n) throw new Error('Não há keyframe nesse tempo');
    return n;
  },
  setModifier(id, prop, mod) {
    get().commit((p) => {
      const f = findClip(p, id);
      if (!f || !f.clip.mediaId) throw new Error('Modificadores só em clips de vídeo ou imagem');
      const mods = (f.clip.mods ??= {});
      if (mod) mods[prop] = mod;
      else delete mods[prop];
      if (!Object.keys(mods).length) delete f.clip.mods;
    });
  },
  setBlend(id, mode) {
    get().commit((p) => {
      const f = findClip(p, id);
      if (!f || f.track.kind !== 'video') throw new Error('Blend só em clips de vídeo ou imagem');
      if (mode === 'normal') delete f.clip.blend;
      else f.clip.blend = mode;
    });
  },
  setMatte(id, matte) {
    get().commit((p) => {
      const f = findClip(p, id);
      if (!f || f.track.kind !== 'video') throw new Error('Track matte só em clips de vídeo ou imagem');
      if (matte) f.clip.matte = matte;
      else delete f.clip.matte;
    });
  },
  addEffect(id, type, params = {}) {
    const eid = uid('fx');
    get().commit((p) => {
      const f = findClip(p, id);
      if (!f || f.track.kind !== 'video') throw new Error('Efeitos só em clips de vídeo ou imagem');
      const def = EFFECT_DEFAULTS[type];
      if (!def) throw new Error(`Efeito desconhecido: ${type}`);
      (f.clip.effects ??= []).push({ id: eid, type, ...def, ...cleanFx(params) } as Effect);
    });
    return eid;
  },
  updateEffect(id, effectId, params) {
    get().commit((p) => {
      const e = findClip(p, id)?.clip.effects?.find((x) => x.id === effectId);
      if (!e) throw new Error('Efeito não encontrado');
      Object.assign(e, cleanFx(params));
    });
  },
  removeEffect(id, effectId) {
    get().commit((p) => {
      const c = findClip(p, id)?.clip;
      if (c?.effects) c.effects = c.effects.filter((x) => x.id !== effectId);
      if (c?.effects && !c.effects.length) delete c.effects;
    });
  },
  addGraphic(kind, start, duration, patch = {}) {
    const id = uid('c');
    get().commit((p) => {
      // Graphics go on their own text tracks ("Grafismos"), a free one or a new one, so they never sit on the captions.
      const len = Math.max(minLen, duration);
      const free = (x: Track) => !x.clips.some((c) => c.start < start + len - 0.001 && end(c) > start + 0.001);
      let t = p.tracks.find((x) => x.kind === 'text' && /^Grafismos/.test(x.name) && free(x));
      if (!t) {
        const n = p.tracks.filter((x) => x.kind === 'text' && /^Grafismos/.test(x.name)).length;
        t = { id: uid('g'), kind: 'text', name: n ? `Grafismos ${n + 1}` : 'Grafismos', clips: [] };
        const last = p.tracks.map((x) => x.kind).lastIndexOf('text');
        p.tracks.splice(last + 1, 0, t);
      }
      const g = graphicOf({ ...patch, kind });
      const graphic: Graphic = { kind: g.kind, title: g.title, subtitle: g.subtitle, ...patch };
      t.clips.push({ id, start: r3(Math.max(0, start)), in: 0, out: r3(Math.max(minLen, duration)), text: g.title || g.kind, graphic });
      t.clips.sort((a, b) => a.start - b.start);
    });
    set({ selected: id });
    return id;
  },
  updateGraphic(id, patch) {
    get().commit((p) => {
      const f = findClip(p, id);
      if (!f?.clip.graphic) throw new Error('Este clip não é um grafismo');
      const next = { ...f.clip.graphic, ...patch };
      for (const k of Object.keys(next) as (keyof Graphic)[]) if (next[k] === undefined || next[k] === null) delete next[k];
      f.clip.graphic = next;
      f.clip.text = next.title || next.kind;
    });
  },
  addMarker(t, label, color) {
    const id = uid('mk');
    get().commit((p) => {
      (p.markers ??= []).push({ id, t: r3(Math.max(0, t)), ...(label ? { label } : {}), ...(color ? { color } : {}) });
      p.markers.sort((a, b) => a.t - b.t);
    });
    return id;
  },
  removeMarker(id) {
    get().commit((p) => {
      p.markers = (p.markers ?? []).filter((m) => m.id !== id);
      if (!p.markers.length) delete p.markers;
    });
  },
  setBeats(times) {
    const list = [...new Set(times.filter((t) => Number.isFinite(t) && t >= 0).map(r3))].sort((a, b) => a - b);
    get().commit((p) => {
      const keep = (p.markers ?? []).filter((m) => !m.beat);
      const beats: Marker[] = list.map((t) => ({ id: uid('bt'), t, beat: true }));
      p.markers = [...keep, ...beats].sort((a, b) => a.t - b.t);
      if (!p.markers.length) delete p.markers;
    });
    return list.length;
  },
  clearMarkers(beatsOnly = false) {
    let n = 0;
    get().commit((p) => {
      const before = p.markers?.length ?? 0;
      p.markers = beatsOnly ? (p.markers ?? []).filter((m) => !m.beat) : [];
      n = before - p.markers.length;
      if (!p.markers.length) delete p.markers;
    });
    return n;
  },
  beatPulse(ids, amount = 0.08) {
    const beats = (get().project.markers ?? []).filter((m) => m.beat).map((m) => m.t);
    if (!beats.length) throw new Error('Ainda não há batidas: deteta-as primeiro na música');
    let n = 0;
    get().commit((p) => {
      for (const t of p.tracks) {
        if (t.kind !== 'video') continue;
        for (const c of t.clips) {
          if (!c.mediaId || (ids !== 'all' && !ids.includes(c.id))) continue;
          const d = dur(c);
          const local = beats.map((b) => b - c.start).filter((b) => b >= 0 && b < d);
          if (!local.length) continue;
          const base = c.keyframes?.zoom?.length === 1 ? c.keyframes.zoom[0]!.v : 1;
          c.keyframes = { ...c.keyframes, zoom: pulseKeys(local, d, Math.max(0.01, Math.min(0.4, amount)), base) };
          n++;
        }
      }
    });
    return n;
  },
  snapCutsToBeats(maxShift = 0.25) {
    const beats = (get().project.markers ?? []).filter((m) => m.beat).map((m) => m.t);
    if (!beats.length) throw new Error('Ainda não há batidas: deteta-as primeiro na música');
    let n = 0;
    get().commit((p) => {
      for (const t of p.tracks) {
        if (t.kind !== 'video') continue;
        const clips = [...t.clips].sort((a, b) => a.start - b.start);
        // Walk left to right: each clip's out moves to the nearest beat, the rest of the track follows.
        for (let i = 0; i < clips.length; i++) {
          const c = clips[i]!;
          const e = end(c);
          const next = clips[i + 1];
          if (!next || Math.abs(next.start - e) > 0.05) continue;
          const beat = beats.reduce((b, x) => (Math.abs(x - e) < Math.abs(b - e) ? x : b), beats[0]!);
          const shift = beat - e;
          if (Math.abs(shift) < 0.005 || Math.abs(shift) > maxShift) continue;
          const m = mediaOf(p, c.mediaId);
          const maxOut = m && m.kind !== 'image' ? m.duration : 3600;
          const out = r3(Math.min(maxOut, Math.max(c.in + minLen, c.out + shift * speedOf(c))));
          const real = (out - c.out) / speedOf(c);
          if (Math.abs(real) < 0.005) continue;
          c.out = out;
          for (let j = i + 1; j < clips.length; j++) clips[j]!.start = r3(clips[j]!.start + real);
          n++;
        }
      }
    });
    return n;
  },
  addSfxClip(mediaId, start, volume = 0.8) {
    const id = uid('c');
    get().commit((p) => {
      const m = mediaOf(p, mediaId);
      if (!m || m.kind !== 'audio') throw new Error('Efeito sonoro desconhecido');
      let track = p.tracks.find((t) => t.kind === 'audio' && /^(sfx|efeitos)/i.test(t.name));
      if (!track) {
        track = { id: uid('a'), kind: 'audio', name: 'SFX', clips: [] };
        p.tracks.push(track);
      }
      track.clips.push({ id, mediaId, start: r3(Math.max(0, start)), in: 0, out: r3(m.duration), volume: Math.max(0, Math.min(2, volume)) });
      track.clips.sort((a, b) => a.start - b.start);
    });
    return id;
  },
  insertFreeze(clipId, time, imageId, length) {
    const id = uid('c');
    get().commit((p) => {
      const f = findClip(p, clipId);
      if (!f || f.track.kind !== 'video' || !f.clip.mediaId) throw new Error('Congelar imagem só em clips de vídeo');
      const c = f.clip;
      const len = r3(Math.max(minLen, length));
      const at = r3(Math.max(c.start, Math.min(end(c), time)));
      // Split the clip at `at` (if inside), push everything after it back and put the still in the gap.
      if (at > c.start + 0.05 && at < end(c) - 0.05) {
        const cut = r3(c.in + (at - c.start) * speedOf(c));
        const right: Clip = { ...clone(c), id: uid('c'), start: at, in: cut, transitionIn: null };
        delete right.keyframes;
        c.out = cut;
        c.transitionOut = null;
        f.track.clips.push(right);
      }
      for (const x of f.track.clips) if (x.start >= at - 0.001) x.start = r3(x.start + len);
      f.track.clips.push({ id, mediaId: imageId, start: at, in: 0, out: len, fit: c.fit ?? 'fill', ...(c.orient ? { orient: c.orient } : {}), ...(c.color ? { color: clone(c.color) } : {}) });
      f.track.clips.sort((a, b) => a.start - b.start);
    });
    set({ selected: id });
    return id;
  },
  replaceProject(p) {
    set((s) => ({ project: p, past: [...s.past, s.project].slice(-MAX_HISTORY), future: [], dirty: true, selected: null, playhead: 0, playing: false, filePath: null }));
  },
  setGrade(ids, grade, replace = false) {
    let n = 0;
    get().commit((p) => {
      for (const t of p.tracks) {
        if (t.kind !== 'video') continue;
        for (const c of t.clips) {
          if (!c.mediaId || (ids !== 'all' && !ids.includes(c.id))) continue;
          if (!grade) delete c.color;
          else {
            const next: Grade = { ...(replace ? {} : c.color), ...grade };
            for (const k of ['exposure', 'contrast', 'saturation', 'temperature'] as const) if (next[k] !== undefined) next[k] = r3(Math.max(-1, Math.min(1, next[k]!)));
            if (next.vignette !== undefined) next.vignette = r3(Math.max(0, Math.min(1, next.vignette)));
            if (!next.lut) delete next.lut;
            c.color = next;
          }
          n++;
        }
      }
    });
    return n;
  },
  setCaptionStyle(patch, replace = false) {
    // "O meu estilo" is a saved style now (MY_STYLE_ID); null removes it from the project.
    get().commit((p) => {
      delete p.captionStyle;
      if (!patch) {
        if (p.styles) delete p.styles[MY_STYLE_ID];
        return;
      }
      const cur = p.styles?.[MY_STYLE_ID] ?? get().userStyles[MY_STYLE_ID] ?? STYLES.elite!;
      const st = validateStyle({ ...(replace ? STYLES.elite! : cur), ...patch, label: 'O meu estilo' });
      if (!st) throw new Error('Estilo inválido');
      (p.styles ??= {})[MY_STYLE_ID] = st;
      void get().saveUserStyle(MY_STYLE_ID, st).catch(() => {});
    });
  },
  styleAllCaptions(style) {
    return get().applyCaptionStyle(style, 'all');
  },
  userStyles: {},
  async loadUserStyles() {
    const list = (await window.ec?.listCaptionStyles?.().catch(() => null)) ?? {};
    set({ userStyles: list });
  },
  async saveUserStyle(id, style) {
    const r = await window.ec.saveCaptionStyle(id, style);
    set((s) => ({ userStyles: { ...s.userStyles, [r.id]: r.style } }));
    // Captions already using it show the new version (embedded copy updated without an undo step).
    const p = get().project;
    if (p.styles?.[r.id] || p.tracks.some((t) => t.clips.some((c) => c.style === r.id))) get().live((q) => void ((q.styles ??= {})[r.id] = clone(r.style)));
    return r.id;
  },
  async deleteUserStyle(id) {
    const ok = await window.ec.deleteCaptionStyle(id);
    set((s) => {
      const next = { ...s.userStyles };
      delete next[id];
      return { userStyles: next };
    });
    return ok;
  },
  applyCaptionStyle(style, ids) {
    let n = 0;
    const id = style === 'custom' ? MY_STYLE_ID : style;
    get().commit((p) => {
      for (const t of p.tracks)
        if (t.kind === 'text')
          for (const c of t.clips) {
            if (ids !== 'all' && !ids.includes(c.id)) continue;
            c.style = id;
            delete c.size;
            delete c.y;
            n++;
          }
      embedStyle(p, id, get().userStyles);
    });
    return n;
  },
  copyCaptionLook(fromId) {
    const src = findClip(get().project, fromId)?.clip;
    if (!src) throw new Error(`Clip não encontrado: ${fromId}`);
    let n = 0;
    const style = src.style ?? 'elite';
    // "Todas" = every caption: the auto captions and every text with the same style (a title in
    // another style is left alone). Everything goes: style, colours, fonts, size, layout, line
    // gap, animation, line positions and place on screen.
    const isCaption = (c: Clip) => c.id === src.id || c.auto || (c.style ?? 'elite') === style;
    get().commit((p) => {
      for (const t of p.tracks)
        if (t.kind === 'text')
          for (const c of t.clips) {
            if (!isCaption(c)) continue;
            c.style = style;
            for (const k of ['x', 'y'] as const) {
              if (src[k] !== undefined) c[k] = src[k];
              else delete c[k];
            }
            if (src.override) c.override = clone(src.override);
            else delete c.override;
            if (src.size !== undefined) c.size = src.size;
            else delete c.size;
            if (src.lines) c.lines = clone(src.lines);
            else delete c.lines;
            n++;
          }
    });
    return n;
  },
  setCaptionOverride(ids, patch) {
    let n = 0;
    get().commit((p) => {
      for (const t of p.tracks)
        if (t.kind === 'text')
          for (const c of t.clips) {
            if (ids !== 'all' && !ids.includes(c.id)) continue;
            if (!patch) {
              delete c.override;
              delete c.size;
              delete c.lines;
            } else {
              const o = cleanOverride({ ...c.override, ...patch });
              if (o) c.override = o;
              else delete c.override;
            }
            n++;
          }
    });
    return n;
  },
  mergeCaptionWithNext(id) {
    let ok = false;
    get().commit((p) => {
      const f = findClip(p, id);
      if (!f || f.track.kind !== 'text') return;
      const sorted = [...f.track.clips].sort((a, b) => a.start - b.start);
      const next = sorted[sorted.indexOf(f.clip) + 1];
      if (!next) return;
      const a = f.clip;
      const shift = next.start - a.start;
      const wa = a.words?.length ? a.words : null;
      const wb = next.words?.length ? next.words : null;
      if (wa && wb) a.words = [...wa, ...wb.map((w) => ({ ...w, s: r3(w.s + shift), e: r3(w.e + shift) }))];
      else delete a.words;
      a.text = `${a.text ?? ''} ${next.text ?? ''}`.replace(/\s+/g, ' ').trim();
      a.in = 0;
      a.out = r3(Math.max(a.out - a.in, shift + (next.out - next.in)));
      delete a.keyword;
      f.track.clips = f.track.clips.filter((c) => c.id !== next.id);
      ok = true;
    });
    return ok;
  },
  updateCaptions(ids, patch) {
    get().commit((p) => {
      for (const t of p.tracks) if (t.kind === 'text') for (const c of t.clips) if (ids.includes(c.id)) Object.assign(c, patch);
    });
  },
  setCaptionLines(ids, lines) {
    let n = 0;
    get().commit((p) => {
      for (const t of p.tracks)
        if (t.kind === 'text')
          for (const c of t.clips) {
            if (ids !== 'all' && !ids.includes(c.id)) continue;
            const l = cleanLines(lines);
            if (l) c.lines = l;
            else delete c.lines;
            n++;
          }
    });
    return n;
  },
  addMask(clipId, shape = 'ellipse', mode = 'blur') {
    const id = uid('mk');
    get().commit((p) => {
      const f = findClip(p, clipId);
      if (!f || !f.clip.mediaId || f.track.kind !== 'video') throw new Error('Máscaras só em clips de vídeo ou imagem');
      const free = shape === 'pen' || shape === 'person';
      (f.clip.masks ??= []).push({
        id,
        shape,
        x: 0.5,
        y: free ? 0.5 : 0.4,
        w: free ? 1 : 0.36,
        h: free ? 1 : shape === 'ellipse' ? 0.24 : 0.2,
        feather: shape === 'person' ? 0.002 : 0.02,
        invert: false,
        mode,
        amount: mode === 'darken' ? 0.6 : 0.7,
        ...(shape === 'pen' ? { points: [] } : {}),
      });
    });
    if (shape === 'pen' || shape === 'person') set({ maskTool: { clipId, maskId: id, kind: shape === 'pen' ? 'pen' : 'pick' }, selected: clipId });
    return id;
  },
  maskTool: null,
  setMaskTool(t) {
    set({ maskTool: t });
  },
  updateMask(clipId, maskId, patch) {
    get().commit((p) => {
      const m = findClip(p, clipId)?.clip.masks?.find((x) => x.id === maskId);
      if (!m) throw new Error('Máscara não encontrada');
      Object.assign(m, patch);
      const c01 = (v: number) => r3(Math.max(0, Math.min(1, v)));
      m.x = r3(Math.max(-0.5, Math.min(1.5, m.x)));
      m.y = r3(Math.max(-0.5, Math.min(1.5, m.y)));
      m.w = r3(Math.max(0.01, Math.min(2, m.w)));
      m.h = r3(Math.max(0.01, Math.min(2, m.h)));
      m.feather = r3(Math.max(0, Math.min(0.2, m.feather)));
      m.amount = c01(m.amount);
      for (const k of ['toX', 'toY'] as const) if (m[k] === null || m[k] === undefined || Number.isNaN(m[k])) delete m[k];
    });
  },
  removeMask(clipId, maskId) {
    get().commit((p) => {
      const c = findClip(p, clipId)?.clip;
      if (c?.masks) c.masks = c.masks.filter((m) => m.id !== maskId);
      if (c?.masks && !c.masks.length) delete c.masks;
    });
  },
  addNode(clipId, type, after, at) {
    if (type === 'mediaIn' || type === 'mediaOut' || NODE_INPUTS[type] === undefined) throw new Error(`Nó desconhecido: ${type}`);
    const id = uid('n');
    get().commit((p) => {
      const f = fusionOf(p, clipId);
      // By default the new node goes just before the output.
      const out = f.nodes.find((n) => n.type === 'mediaOut')!;
      const prev = after ? f.nodes.find((n) => n.id === after) : f.nodes.find((n) => n.id === f.links.find((l) => l.to === out.id && l.port === 0)?.from);
      const base = prev ?? out;
      const node: FNode = { id, type, x: at?.x ?? base.x + 200, y: at?.y ?? (NODE_INPUTS[type] ? base.y : base.y + 120), p: {} };
      f.nodes.push(node);
      if (NODE_INPUTS[type] && prev && prev.type !== 'mediaOut') {
        // Insert into the chain: prev -> node -> (everything prev fed).
        for (const l of f.links) if (l.from === prev.id) l.from = id;
        f.links.push({ from: prev.id, to: id, port: 0 });
        // Push the nodes on the right further right so they do not overlap.
        for (const n of f.nodes) if (n.id !== id && n.x >= node.x - 10 && Math.abs(n.y - node.y) < 60) n.x += 200;
      }
    });
    return id;
  },
  setNodeParams(clipId, nodeId, patch) {
    get().commit((p) => {
      const n = fusionOf(p, clipId).nodes.find((x) => x.id === nodeId);
      if (!n) throw new Error('Nó não encontrado');
      n.p = { ...n.p, ...patch };
    });
  },
  removeNode(clipId, nodeId) {
    get().commit((p) => {
      const f = fusionOf(p, clipId);
      const n = f.nodes.find((x) => x.id === nodeId);
      if (!n || n.type === 'mediaIn' || n.type === 'mediaOut') return;
      // Reconnect: what fed its first input now feeds what it fed.
      const src = f.links.find((l) => l.to === nodeId && l.port === 0)?.from;
      f.links = f.links.filter((l) => l.to !== nodeId);
      for (const l of f.links) if (l.from === nodeId) l.from = src ?? '';
      f.links = f.links.filter((l) => l.from);
      f.nodes = f.nodes.filter((x) => x.id !== nodeId);
    });
  },
  linkNodes(clipId, from, to, port) {
    get().commit((p) => {
      const f = fusionOf(p, clipId);
      const a = f.nodes.find((n) => n.id === from);
      const b = f.nodes.find((n) => n.id === to);
      if (!a || !b) throw new Error('Nó não encontrado');
      if (a.type === 'mediaOut') throw new Error('A Saída não tem saída');
      if (port < 0 || port >= (NODE_INPUTS[b.type] ?? 0)) throw new Error('Esse nó não tem essa entrada');
      if (reaches(f, from, to)) throw new Error('Essa ligação faria um ciclo');
      f.links = f.links.filter((l) => !(l.to === to && l.port === port));
      f.links.push({ from, to, port });
    });
  },
  unlinkPort(clipId, to, port) {
    get().commit((p) => {
      const f = fusionOf(p, clipId);
      f.links = f.links.filter((l) => !(l.to === to && l.port === port));
    });
  },
  resetFusion(clipId) {
    get().commit((p) => {
      const f = findClip(p, clipId);
      if (f) delete f.clip.fusion;
    });
  },
  setAudio(patch) {
    get().commit((p) => void (p.audio = { ...p.audio, ...patch }));
  },
  addCaptions(list, replace, style = 'clean') {
    get().commit((p) => {
      const t = p.tracks.find((x) => x.kind === 'text')!;
      if (replace) t.clips = [];
      for (const s of list) {
        const len = r3(Math.max(minLen, s.end - s.start));
        t.clips.push({ id: uid('c'), start: r3(Math.max(0, s.start)), in: 0, out: len, text: s.text, style });
      }
      t.clips.sort((a, b) => a.start - b.start);
    });
    return list.length;
  },
  toggleTrack(id, key) {
    get().commit((p) => {
      const t = p.tracks.find((x) => x.id === id);
      if (t) t[key] = !t[key];
    });
  },

  select(id) {
    set({ selected: id });
  },
  seek(t) {
    set({ playhead: r3(Math.max(0, Math.min(t, Math.max(projectDuration(get().project), 0)))) });
  },
  setPlaying(v) {
    if (v && get().playhead >= projectDuration(get().project) - 0.02) set({ playhead: 0 });
    set({ playing: v });
  },
  setZoom(z) {
    set({ zoom: Math.max(8, Math.min(600, z)) });
  },
  setSnap(v) {
    set({ snap: v });
  },
  setStatus(s, busy = false) {
    set({ status: s, busy });
  },
  setExportProgress(p) {
    set({ exportProgress: p });
  },
  markSaved(path) {
    set({ filePath: path, dirty: false });
  },
}));

export { activeClip };
