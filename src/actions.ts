// Editor actions that touch the PC (import, transcribe, export, save). Used by the buttons and
// by the MCP server, so Claude and the Gui do exactly the same things.
import { useEditor } from './store';
import type { CaptionOptions, CaptionOverride, Clip, Media, Project, TranscribeOptions } from './types';
import { cleanOverride } from './lib/capstyle.js';
import { STYLES, activeClip, decodePeaks, dur, end, findClip, projectDuration, speedOf, srcTime } from './lib/project';
import { detectBeats as findBeats } from './lib/fx.js';

/** The project with every saved caption style its captions use embedded (renders the same on another PC). */
function withStyles(): Project {
  const { project, userStyles } = S();
  const used = new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.style)).filter((x): x is string => Boolean(x && !STYLES[x] && userStyles[x])));
  if (!used.size) return project;
  return { ...project, styles: { ...Object.fromEntries([...used].map((id) => [id, userStyles[id]!])), ...project.styles } };
}

const S = () => useEditor.getState();

export async function importDialog() {
  const r = await window.ec.importDialog();
  if (r.media.length) S().addMedia(r.media);
  if (r.errors.length) S().setStatus(r.errors.join(' · '));
  return r.media;
}

export async function importPaths(paths: string[]) {
  const r = await window.ec.importPaths(paths);
  if (r.media.length) S().addMedia(r.media);
  return r;
}

/** Transcripts made before options existed count as the default (best local model, Portuguese). */
const DEFAULT_KEY = 'auto|pt|transcribe|';
export const transcriptKey = (o: TranscribeOptions = {}) => `${o.model || 'auto'}|${o.language || 'pt'}|${o.translate ? 'translate' : 'transcribe'}|${o.prompt ?? ''}`;

async function ensureTranscript(m: Media, opts: TranscribeOptions = {}) {
  const key = transcriptKey(opts);
  if (m.transcript && (m.transcriptKey ?? DEFAULT_KEY) === key) return m.transcript;
  S().setStatus(`A transcrever ${m.name} no teu PC${opts.translate ? ' (a traduzir para inglês)' : ''}…`, true);
  const r = await window.ec.transcribe(m.path, opts);
  S().setTranscript(m.id, r.words, key);
  return r.words;
}

function speechClips(clipId?: string) {
  const p = S().project;
  if (clipId) {
    const f = findClip(p, clipId);
    if (!f || !f.clip.mediaId) throw new Error('Escolhe um clip de vídeo ou áudio');
    return [f.clip];
  }
  return p.tracks.filter((t) => t.kind === 'video' && !t.muted).flatMap((t) => t.clips).filter((c) => p.media.find((m) => m.id === c.mediaId)?.hasAudio);
}

export type AutoCaptionOptions = CaptionOptions &
  TranscribeOptions & {
    clipId?: string;
    /** Look given to every new caption (colours, fonts) over its style. */
    override?: CaptionOverride;
    /** Size of every new caption (fraction of the frame height). */
    size?: number;
  };

export async function autoCaptions(opts: AutoCaptionOptions = {}) {
  const clips = speechClips(opts.clipId);
  if (!clips.length) throw new Error('Não há clips com som na timeline');
  let total = 0;
  try {
    for (const c of clips) {
      const m = S().project.media.find((x) => x.id === c.mediaId)!;
      const words = await ensureTranscript(m, { model: opts.model, language: opts.language, translate: opts.translate, prompt: opts.prompt });
      const caps = await window.ec.captionClips(c, words, {
        style: opts.style ?? 'elite',
        maxWords: opts.maxWords === undefined ? undefined : Math.max(1, Math.min(12, opts.maxWords)),
        density: opts.density,
        maxChars: opts.maxChars,
        maxLines: opts.maxLines,
        textCase: opts.textCase,
        stripPunct: opts.stripPunct,
        censor: opts.censor,
      });
      const look = cleanOverride(opts.override);
      const sized = opts.size && opts.size >= 0.02 && opts.size <= 0.3 ? opts.size : undefined;
      const styled = caps.map((x) => ({ ...x, ...(look ? { override: look } : {}), ...(sized ? { size: sized } : {}) }));
      if (styled.length) total += S().replaceAutoCaptions({ start: c.start, end: end(c) }, styled);
    }
    S().setStatus(total ? `${total} legendas criadas` : 'Não encontrei fala para legendar');
    return { captions: total };
  } catch (e) {
    S().setStatus(`Legendas: ${(e as Error).message}`);
    throw e;
  }
}

export async function cutSilences(clipId: string, minPause = 0.5, padding = 0.12) {
  const f = findClip(S().project, clipId);
  const m = f && S().project.media.find((x) => x.id === f.clip.mediaId);
  if (!f || !m) throw new Error('Escolhe um clip de vídeo');
  await ensureTranscript(m);
  const text = S().project.tracks.find((t) => t.kind === 'text');
  const hadCaptions = Boolean(text?.clips.some((c) => c.auto && c.start < end(f.clip) && end(c) > f.clip.start));
  const style = text?.clips.find((c) => c.auto)?.style ?? 'elite';
  const r = S().cutSilences(clipId, minPause, padding);
  // Captions made before the cut no longer line up: remake them for the new pieces.
  if (hadCaptions) {
    S().replaceAutoCaptions(r.range, []);
    for (const id of r.ids) await autoCaptions({ clipId: id, style });
  }
  S().setStatus(`Pausas cortadas: ${r.removed.toFixed(1)} s removidos em ${r.pieces} partes${hadCaptions ? ' · legendas refeitas' : ''}`);
  return { removed: r.removed, pieces: r.pieces, captions_redone: hadCaptions };
}

let exporting = false;
export async function exportVideo(opts: { path?: string; gpu?: boolean; ask?: boolean; quality?: 'alta' | 'media' | 'leve' } = {}) {
  if (exporting) throw new Error('Já está uma exportação a correr');
  const project = withStyles();
  if (projectDuration(project) <= 0) throw new Error('A timeline está vazia');
  exporting = true;
  S().setExportProgress(0);
  S().setStatus('A exportar…', true);
  const off = window.ec.onExportProgress((p) => S().setExportProgress(p));
  try {
    const out = await window.ec.exportVideo(project, opts);
    S().setStatus(out ? `Exportado: ${out}` : 'Exportação cancelada');
    return out;
  } catch (e) {
    S().setStatus(`Exportação falhou: ${(e as Error).message}`);
    throw e;
  } finally {
    off();
    exporting = false;
    S().setExportProgress(null);
  }
}

export async function saveProject(path?: string | null) {
  const out = await window.ec.saveProject(withStyles(), path ?? S().filePath);
  if (out) {
    S().markSaved(out);
    S().setStatus(`Guardado: ${out}`);
  }
  return out;
}

export async function openProject(file?: string) {
  const r = await window.ec.openProject(file);
  if (r) {
    S().load(r.project, r.path);
    void fillPeaks();
  }
  return r;
}

/** Waveforms for media imported before waveforms existed. */
async function fillPeaks() {
  for (const m of S().project.media) {
    if (!m.hasAudio || m.peaks) continue;
    const peaks = await window.ec.peaks(m.path);
    if (peaks) useEditor.setState((s) => ({ project: { ...s.project, media: s.project.media.map((x) => (x.id === m.id ? { ...x, peaks } : x)) } }));
  }
}

export async function importCapcut(file?: string | null) {
  S().setStatus('A importar o projeto do CapCut…', true);
  try {
    const r = await window.ec.capcutImport(file ?? null);
    if (!r) {
      S().setStatus(null);
      return null;
    }
    S().replaceProject(r.project);
    const clips = r.project.tracks.reduce((n, t) => n + t.clips.length, 0);
    S().setStatus(`CapCut importado: ${clips} clips${r.warnings.length ? ' · ' + r.warnings.join(' · ') : ''}`);
    return { name: r.project.name, clips, warnings: r.warnings };
  } catch (e) {
    S().setStatus(`CapCut: ${(e as Error).message}`);
    throw e;
  }
}

/** Short, model-friendly description of the project (MCP get_project). */
export function describeProject() {
  const p = S().project;
  return {
    name: p.name,
    canvas: p.canvas,
    duration: projectDuration(p),
    playhead: S().playhead,
    selected: S().selected,
    media: p.media.map((m) => ({ id: m.id, name: m.name, kind: m.kind, duration: m.duration, hasAudio: m.hasAudio, transcribed: Boolean(m.transcript) })),
    markers: (p.markers ?? []).filter((m) => !m.beat).map((m) => ({ id: m.id, t: m.t, label: m.label })),
    beats: (p.markers ?? []).filter((m) => m.beat).map((m) => m.t),
    tracks: p.tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      name: t.name,
      muted: Boolean(t.muted),
      hidden: Boolean(t.hidden),
      clips: t.clips.map((c: Clip) => ({
        id: c.id,
        start: c.start,
        duration: Math.round(dur(c) * 1000) / 1000,
        ...(c.mediaId ? { media_id: c.mediaId, in: c.in, out: c.out, volume: c.volume ?? 1, fit: c.fit ?? 'fill', speed: c.speed ?? 1 } : {}),
        ...(c.transitionIn ? { transition_in: c.transitionIn } : {}),
        ...(c.transitionOut ? { transition_out: c.transitionOut } : {}),
        ...(c.keyframes ? { keyframes: c.keyframes } : {}),
        ...(c.mods ? { modifiers: c.mods } : {}),
        ...(c.blend ? { blend: c.blend } : {}),
        ...(c.matte ? { matte: c.matte } : {}),
        ...(c.effects ? { effects: c.effects } : {}),
        ...(c.color ? { color: c.color } : {}),
        ...(c.masks ? { masks: c.masks } : {}),
        ...(c.fusion ? { fusion: c.fusion } : {}),
        ...(c.graphic ? { graphic: c.graphic } : c.text !== undefined ? { text: c.text, style: c.style, ...(c.override ? { override: c.override } : {}), ...(c.lines ? { lines: c.lines } : {}), ...(c.size !== undefined ? { size: c.size } : {}) } : {}),
      })),
    })),
  };
}

/**
 * "Pessoa" mask: cut out the person the Gui clicked (x/y on the frame, 0..1) in this clip. The
 * matte covers the clip's source range; trimming the clip later asks for a new one.
 */
export async function personMatte(clipId: string, maskId: string, x: number, y: number) {
  const f = findClip(S().project, clipId);
  const m = f && S().project.media.find((mm) => mm.id === f.clip.mediaId);
  if (!f || !m || m.kind !== 'video') throw new Error('A máscara Pessoa funciona em clips de vídeo');
  const { clip } = f;
  // The click is on the framed picture; the engine works on the whole source frame.
  const src = framedToSource(clip, m, x, y);
  const off = window.ec.onMatteProgress((p) => {
    if (p.status) S().setStatus(p.status, true);
    if (typeof p.progress === 'number') S().setStatus(`A recortar a pessoa… ${Math.round(p.progress * 100)}%`, true);
  });
  try {
    S().updateMask(clipId, maskId, { x, y });
    const file = await window.ec.matte({ id: maskId, file: m.path, tin: clip.in, tout: clip.out, x: src.x, y: src.y });
    S().updateMask(clipId, maskId, { matte: { file, in: clip.in, out: clip.out, px: src.x, py: src.y } });
    S().setStatus('Pessoa recortada');
    return file;
  } catch (e) {
    S().setStatus(`Recorte: ${(e as Error).message}`);
    throw e;
  } finally {
    off();
  }
}

/** A point on the framed picture (fill crops the source, fit shows it whole) back to source-frame fractions. */
function framedToSource(clip: Clip, m: Media, x: number, y: number) {
  const { w: W, h: H } = S().project.canvas;
  const sw = m.width ?? W;
  const sh = m.height ?? H;
  const k = clip.fit === 'fit' ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh);
  const dw = sw * k;
  const dh = sh * k;
  const sx = (x * W - (W - dw) / 2) / dw;
  const sy = (y * H - (H - dh) / 2) / dh;
  return { x: Math.max(0, Math.min(1, sx)), y: Math.max(0, Math.min(1, sy)) };
}

// ------------------------------------------------------------------ sound effects, beats, freeze frame

let sfxCache: { id: string; label: string; path: string; duration: number }[] | null = null;
/** The built-in sound effects (whoosh, pop, riser, impacto…). */
export async function sfxLibrary() {
  sfxCache ??= await window.ec.sfxList();
  return sfxCache;
}

/** Media id of a sound effect (imported into the project on first use). */
async function sfxMedia(id: string) {
  const fx = (await sfxLibrary()).find((x) => x.id === id);
  if (!fx) throw new Error(`Efeito sonoro desconhecido: usa ${(await sfxLibrary()).map((x) => x.id).join(', ')}`);
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  let m = S().project.media.find((x) => norm(x.path) === norm(fx.path));
  if (!m) {
    const r = await importPaths([fx.path]);
    m = r.media[0];
    if (!m) throw new Error(r.errors[0] ?? 'Não consegui importar o efeito');
    m = { ...m, name: fx.label };
    S().live((p) => {
      const x = p.media.find((y) => y.id === m!.id);
      if (x) x.name = fx.label;
    });
  }
  return m;
}

/** Put a sound effect on the SFX track. `at` is when its loudest moment should land (timeline s). */
export async function addSfx(id: string, at = S().playhead, volume = 0.8) {
  const m = await sfxMedia(id);
  // Whooshes peak in the middle, risers at the end, hits at the start.
  const lead = id === 'riser' ? m.duration : id === 'whoosh' || id === 'swoosh' ? m.duration / 2 : id === 'flash' ? 0.22 : 0;
  return S().addSfxClip(m.id, Math.max(0, at - lead), volume);
}

/**
 * Sound effects placed automatically (like CapCut's auto SFX): a whoosh on every push/zoom/spin
 * transition, an impact on flashes, a swoosh on plain cuts of the main track, a pop on graphics.
 */
export async function autoSfx(modes: ('transitions' | 'cuts' | 'graphics')[] = ['transitions', 'graphics'], volume = 0.7) {
  const p = S().project;
  const want: { id: string; at: number }[] = [];
  const video = p.tracks.filter((t) => t.kind === 'video');
  for (const t of video)
    for (const c of t.clips) {
      const tr = c.transitionIn?.type;
      if (modes.includes('transitions') && tr && ['whip', 'slide', 'zoom', 'spin'].includes(tr)) want.push({ id: tr === 'zoom' ? 'whoosh' : 'swoosh', at: c.start + Math.min(0.15, c.transitionIn!.d / 2) });
      else if (modes.includes('transitions') && tr === 'flash') want.push({ id: 'impacto', at: c.start });
      else if (modes.includes('transitions') && tr === 'bflash') want.push({ id: 'flash', at: c.start });
    }
  if (modes.includes('cuts') && video[0])
    for (const c of video[0].clips) if (c.start > 0.05 && !c.transitionIn) want.push({ id: 'swoosh', at: c.start });
  if (modes.includes('graphics'))
    for (const t of p.tracks) if (t.kind === 'text') for (const c of t.clips) if (c.graphic && c.graphic.kind !== 'progress') want.push({ id: 'pop', at: c.start + 0.05 });
  // Skip places that already have an effect close by.
  const sfxTrack = p.tracks.find((t) => t.kind === 'audio' && /^(sfx|efeitos)/i.test(t.name));
  const taken = (sfxTrack?.clips ?? []).map((c) => c.start);
  const lib = await sfxLibrary();
  let n = 0;
  for (const w of want.sort((a, b) => a.at - b.at)) {
    const len = lib.find((x) => x.id === w.id)?.duration ?? 0.5;
    const start = w.at - (w.id === 'whoosh' || w.id === 'swoosh' ? len / 2 : w.id === 'flash' ? 0.22 : 0);
    if (taken.some((t) => Math.abs(t - start) < 0.25)) continue;
    await addSfx(w.id, w.at, volume);
    taken.push(start);
    n++;
  }
  S().setStatus(n ? `${n} efeitos sonoros colocados` : 'Não encontrei sítios novos para efeitos');
  return { added: n };
}

/** Beats of a music clip (or the first clip on the music track) as markers on the timeline. */
export async function detectBeats(clipId?: string, sensitivity = 1) {
  const p = S().project;
  let clip: Clip | undefined;
  if (clipId) clip = findClip(p, clipId)?.clip;
  else clip = p.tracks.filter((t) => t.kind === 'audio' && !/^(sfx|efeitos)/i.test(t.name)).flatMap((t) => t.clips)[0];
  if (!clip?.mediaId) throw new Error('Põe uma música na pista de áudio (ou indica o clip)');
  let m = p.media.find((x) => x.id === clip!.mediaId);
  if (!m?.hasAudio) throw new Error('Esse clip não tem som');
  if (!m.peaks) {
    const peaks = await window.ec.peaks(m.path);
    if (!peaks) throw new Error('Não consegui ler o som');
    useEditor.setState((s) => ({ project: { ...s.project, media: s.project.media.map((x) => (x.id === m!.id ? { ...x, peaks } : x)) } }));
    m = { ...m, peaks };
  }
  const beats = findBeats(decodePeaks(m.peaks!), { sensitivity });
  const c = clip;
  const times = beats.filter((b) => b >= c.in && b < c.out).map((b) => c.start + (b - c.in) / speedOf(c));
  const n = S().setBeats(times);
  const bpm = times.length > 2 ? Math.round(60 / ((times[times.length - 1]! - times[0]!) / (times.length - 1))) : 0;
  S().setStatus(`${n} batidas marcadas${bpm ? ` (~${bpm} BPM)` : ''}`);
  return { beats: n, bpm, first: times.slice(0, 8) };
}

/** Freeze frame at `time` (timeline) of the clip shown there (or the given clip), `length` s long. */
export async function freezeFrame(time = S().playhead, length = 1.5, clipId?: string) {
  const p = S().project;
  let clip: Clip | null = clipId ? (findClip(p, clipId)?.clip ?? null) : null;
  if (!clip) for (const t of [...p.tracks].reverse()) if (t.kind === 'video' && !t.hidden && (clip = activeClip(t, time))) break;
  if (!clip?.mediaId) throw new Error('Não há vídeo nesse tempo');
  const m = p.media.find((x) => x.id === clip!.mediaId);
  if (!m || m.kind !== 'video') throw new Error('Congelar imagem só em clips de vídeo');
  S().setStatus('A tirar a imagem…', true);
  try {
    const png = await window.ec.freezeFrame(m.path, srcTime(clip, time));
    const r = await importPaths([png]);
    const still = r.media[0];
    if (!still) throw new Error(r.errors[0] ?? 'Não consegui importar a imagem');
    const id = S().insertFreeze(clip.id, time, still.id, length);
    S().setStatus(`Imagem congelada (${length.toFixed(1)} s)`);
    return { clip_id: id };
  } catch (e) {
    S().setStatus((e as Error).message);
    throw e;
  }
}
