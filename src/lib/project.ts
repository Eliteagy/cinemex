import stylesJson from './styles.json';
import type { CanvasPreset, CaptionStyle, Clip, Grade, Keyframe, KeyProp, Project, Track, Word } from '../types';
import { baseStyleOf, resolveCaptionStyle } from './capstyle.js';
import { kfAt } from './anim.js';
import { remapAt, remapDur } from './xform.js';

export const STYLES = Object.fromEntries(Object.entries(stylesJson).filter(([k]) => k !== '_comment')) as Record<string, CaptionStyle>;
/** The look a caption is drawn with: its style ⊕ its own override (same code as the export). */
export const styleOf = (clip: Clip, project?: Pick<Project, 'styles' | 'captionStyle'>, userStyles?: Record<string, CaptionStyle>): CaptionStyle =>
  resolveCaptionStyle(clip, project, STYLES, userStyles);
/** A caption's style without its override. */
export const baseStyle = (clip: Clip, project?: Pick<Project, 'styles' | 'captionStyle'>, userStyles?: Record<string, CaptionStyle>): CaptionStyle =>
  baseStyleOf(clip, project, STYLES, userStyles);

/** Colour looks (presets) for the Colour page. */
export const LOOKS: Record<string, { label: string; grade: Grade }> = {
  natural: { label: 'Natural', grade: {} },
  cinema: { label: 'Cinema', grade: { contrast: 0.18, saturation: -0.12, temperature: -0.15, vignette: 0.35, exposure: -0.05 } },
  quente: { label: 'Quente', grade: { temperature: 0.45, saturation: 0.08, contrast: 0.08 } },
  frio: { label: 'Frio', grade: { temperature: -0.45, contrast: 0.1 } },
  vivo: { label: 'Vivo', grade: { saturation: 0.35, contrast: 0.15, exposure: 0.04 } },
  imobiliario: { label: 'Imobiliário', grade: { exposure: 0.12, saturation: 0.12, temperature: 0.12, contrast: 0.06 } },
  pb: { label: 'Preto e branco', grade: { saturation: -1, contrast: 0.25 } },
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
/** Grade -> numbers shared by the preview and the export (keep render.cjs gradeMath in sync). */
export function gradeMath(g: Grade | undefined) {
  const e = clamp(g?.exposure ?? 0, -1, 1);
  const c = clamp(g?.contrast ?? 0, -1, 1);
  const s = clamp(g?.saturation ?? 0, -1, 1);
  const t = clamp(g?.temperature ?? 0, -1, 1);
  const bright = 1 + e * 0.6;
  const warm = t > 0 ? [1, 1 - 0.08 * t, 1 - 0.24 * t] : [1 + 0.24 * t, 1 + 0.08 * t, 1];
  return { bright, contrast: 1 + c * 0.8, saturation: 1 + s, warm: warm as [number, number, number], vignette: clamp(g?.vignette ?? 0, 0, 1) };
}
export const isGraded = (g?: Grade) => Boolean(g && (g.lut || ['exposure', 'contrast', 'saturation', 'temperature', 'vignette'].some((k) => Math.abs(Number(g[k as keyof Grade] ?? 0)) > 1e-3)));

/** SRT (subtitles file) from the text clips, and back. */
const srtTime = (t: number) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
export function toSrt(p: Project) {
  const clips = p.tracks.filter((t) => t.kind === 'text' && !t.hidden).flatMap((t) => t.clips).filter((c) => c.text).sort((a, b) => a.start - b.start);
  return clips.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(end(c))}\n${c.text}\n`).join('\n');
}
export function parseSrt(text: string) {
  const out: { start: number; end: number; text: string }[] = [];
  const t = (h: string, m: string, s: string, ms: string) => +h * 3600 + +m * 60 + +s + +ms / 1000;
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const m = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/.exec(block);
    if (!m) continue;
    const body = block.slice(block.indexOf(m[0]) + m[0].length).trim().replace(/<[^>]+>/g, '');
    if (body) out.push({ start: t(m[1]!, m[2]!, m[3]!, m[4]!), end: t(m[5]!, m[6]!, m[7]!, m[8]!), text: body });
  }
  return out;
}

export const PRESETS: Record<CanvasPreset, { w: number; h: number; label: string }> = {
  '9:16': { w: 1080, h: 1920, label: 'Vertical 9:16 · Reels, TikTok' },
  '16:9': { w: 1920, h: 1080, label: 'Horizontal 16:9 · YouTube' },
  '1:1': { w: 1080, h: 1080, label: 'Quadrado 1:1' },
  '4:5': { w: 1080, h: 1350, label: 'Retrato 4:5 · Feed' },
};

export const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 9)}`;
export const r3 = (n: number) => Math.round(n * 1000) / 1000;
export const speedOf = (c: Clip) => Math.max(0.25, Math.min(4, c.speed ?? 1));
/** Length on the timeline (speed applied). */
export const dur = (c: Clip) => remapDur(c) ?? Math.max(0, (c.out - c.in) / speedOf(c));
/** Source time shown at timeline time t (time remap: the remap curve). */
export const srcTime = (c: Clip, t: number) => (c.remap && c.remap.length >= 2 ? remapAt(c, t - c.start) : c.in + (t - c.start) * speedOf(c));
/** Timeline time for a source time. */
export const timeOfSrc = (c: Clip, s: number) => c.start + (s - c.in) / speedOf(c);
export const end = (c: Clip) => c.start + dur(c);

export function newProject(name = 'Projeto sem título', preset: CanvasPreset = '9:16'): Project {
  const p = PRESETS[preset];
  return {
    version: 1,
    name,
    canvas: { w: p.w, h: p.h, fps: 30, preset },
    media: [],
    tracks: [
      { id: 'v1', kind: 'video', name: 'V1', clips: [] },
      { id: 'v2', kind: 'video', name: 'V2', clips: [] },
      { id: 'tx', kind: 'text', name: 'Legendas', clips: [] },
      { id: 'a1', kind: 'audio', name: 'Música', clips: [] },
    ],
  };
}

export function projectDuration(p: Project) {
  let e = 0;
  for (const t of p.tracks) for (const c of t.clips) e = Math.max(e, end(c));
  return r3(e);
}

export function findClip(p: Project, id: string): { track: Track; clip: Clip; index: number } | null {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === id);
    if (index >= 0) return { track, clip: track.clips[index]!, index };
  }
  return null;
}

/** The clip shown on a track at time t (the last one wins when clips overlap). */
export function activeClip(track: Track, t: number): Clip | null {
  let found: Clip | null = null;
  for (const c of track.clips) if (t >= c.start && t < end(c)) found = c;
  return found;
}

export function trackEnd(track: Track) {
  return track.clips.reduce((m, c) => Math.max(m, end(c)), 0);
}

/**
 * Speech segments of a clip from its source transcript: words inside [in, out] merged when the
 * pause between them is shorter than minPause, padded on both sides. Source time.
 */
export function speechSegments(clip: Clip, words: Word[], minPause = 0.5, padding = 0.12) {
  const inside = words.filter((w) => w.e > clip.in && w.s < clip.out);
  const segs: { in: number; out: number }[] = [];
  for (const w of inside) {
    const s = Math.max(clip.in, w.s - padding);
    const e = Math.min(clip.out, w.e + padding);
    const last = segs[segs.length - 1];
    if (last && s - last.out < minPause) last.out = Math.max(last.out, e);
    else segs.push({ in: s, out: e });
  }
  return segs.map((s) => ({ in: r3(s.in), out: r3(s.out) })).filter((s) => s.out - s.in > 0.08);
}

export function fmtTime(t: number, fps = 30) {
  const sign = t < 0 ? '-' : '';
  t = Math.abs(t);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const f = Math.floor((t % 1) * fps);
  return `${sign}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

export function fmtShort(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.round(t % 60);
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

export const KEY_DEFAULT: Record<KeyProp, number> = { zoom: 1, x: 0, y: 0, rotate: 0, opacity: 1, scale: 1, px: 0, py: 0 };

/** Value of an animated property at local time t (each segment eased like its keyframe says, src/lib/anim.js). */
export function kfValue(list: Keyframe[] | undefined, t: number, def: number) {
  return kfAt(list, t, def);
}

export function hasKeyframes(c: Clip) {
  return Boolean(c.keyframes && Object.values(c.keyframes).some((l) => l && l.length));
}

/** Audio fade of a clip's in/out transitions at local time t (every type fades the sound, as the export's afade). */
export function audioFade(c: Clip, local: number) {
  const d = dur(c);
  let gain = 1;
  const tin = c.transitionIn;
  const tout = c.transitionOut;
  if (tin && tin.d > 0 && local < tin.d) gain *= Math.max(0, local / tin.d);
  if (tout && tout.d > 0 && local > d - tout.d) gain *= Math.max(0, (d - local) / tout.d);
  return gain;
}

/** Decode waveform peaks (base64 bytes, 100 per second). */
const peakCache = new Map<string, Uint8Array>();
export function decodePeaks(b64: string) {
  let p = peakCache.get(b64);
  if (!p) {
    const bin = atob(b64);
    p = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) p[i] = bin.charCodeAt(i);
    peakCache.set(b64, p);
  }
  return p;
}

export const mediaUrl = (path: string) => `ec-media://f/${encodeURIComponent(path)}`;
