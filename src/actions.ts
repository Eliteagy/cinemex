// Editor actions that touch the PC (import, transcribe, export, save). Used by the buttons and
// by the MCP server, so Claude and the Gui do exactly the same things.
import { useEditor } from './store';
import type { CaptionModel, CaptionOptions, CaptionOverride, Clip, Media, Project, Track, TranscribeOptions } from './types';
import { cleanOverride } from './lib/capstyle.js';
import { STYLES, activeClip, decodePeaks, dur, end, findClip, projectDuration, r3, speedOf, srcTime, textClips, uid } from './lib/project';
import { detectBeats as findBeats } from './lib/fx.js';
import { groupingFor, modelCaptions, validateModel } from './lib/capmodels.js';
import { beatsFromCaptions, ctaClip, moodFromText, musicClips, progressClip, punchKeyframes, sfxPlan } from './lib/polish.js';
import { splitAround } from './lib/broll.js';
import { applySpellFixes, keywordPrompt, parseKeywordPicks, parseSpellFixes, spellPrompt, textBetween, transcriptLines } from './lib/aivideo.js';

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

export async function ensureTranscript(m: Media, opts: TranscribeOptions = {}) {
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

/**
 * "Modelos de legendas": captions in a model's look (big words behind the person, small words in
 * front) for the clip with speech (given, selected, or the longest one). Finds the speaker's face to
 * place the words, cuts the person out (person "front" mask, reused when the clip has one) and puts
 * the captions on two tracks, "Legendas atrás" and "Legendas à frente" (marked front). One undo step.
 */
export type PolishOptions = { punch?: boolean | number; sfx?: boolean; progress?: boolean; cta?: string; music?: 'auto' | 'calma' | 'media' | 'forte' | false; broll?: boolean; clipId?: string };

/**
 * "Short editado": zoom punches and sound effects on the big words (the "Legendas atrás" track, or
 * the long words of the captions), a progress bar and a call to action at the end. Old punches,
 * bars and CTAs made by this action are replaced. Several steps, one undo (the caller wraps it).
 */
export async function polishEdit(opts: PolishOptions = {}) {
  const p0 = S().project;
  const sel = S().selected;
  const clipId = opts.clipId ?? (sel && findClip(p0, sel)?.clip.mediaId ? sel : undefined);
  const clip = speechClips(clipId)
    .filter((c) => p0.media.find((m) => m.id === c.mediaId)?.kind === 'video')
    .sort((a, b) => dur(b) - dur(a))[0];
  if (!clip) throw new Error('Põe um vídeo com fala na timeline (ou seleciona-o)');
  const total = projectDuration(p0);
  const back = p0.tracks.find((t) => t.id === 'cm-back')?.clips ?? textClips(p0).filter((c) => !c.graphic);
  const beats = beatsFromCaptions(back.map((c) => ({ start: c.start, text: c.text, override: c.override })), { duration: total, tail: opts.cta ? 2.5 : 0.8 });
  const front = p0.tracks.some((t) => t.clips.some((c) => c.masks?.some((m) => m.mode === 'front')));
  const added: { punches: number; sfx: number; progress: boolean; cta: boolean; music?: string; broll?: number } = { punches: 0, sfx: 0, progress: false, cta: false };
  S().commit((p) => {
    const f = findClip(p, clip.id);
    if (!f) return;
    if (opts.punch) {
      const keys = punchKeyframes(beats, f.clip, { amount: typeof opts.punch === 'number' ? opts.punch : 0.12 });
      f.clip.keyframes = { ...(f.clip.keyframes ?? {}), zoom: keys };
      added.punches = keys.length / 4;
    }
    if (opts.progress || opts.cta) {
      let t = p.tracks.find((x) => x.id === 'pl-gx');
      if (!t) {
        t = { id: 'pl-gx', kind: 'video', name: 'Barra e CTA', clips: [], ...(front ? { front: true } : {}) };
        p.tracks.splice(p.tracks.map((x) => x.kind).lastIndexOf('video') + 1, 0, t);
      }
      t.clips = [];
      if (opts.progress) {
        t.clips.push({ id: uid('c'), ...progressClip(total) } as Clip);
        added.progress = true;
      }
      const c = opts.cta ? ctaClip(opts.cta, total) : null;
      if (c) {
        t.clips.push({ id: uid('c'), ...c } as Clip);
        added.cta = true;
      }
    }
  });
  if (opts.music) {
    const m0 = p0.media.find((m) => m.id === clip.mediaId);
    const mood = opts.music === 'auto' ? moodFromText(textBetween(m0?.transcript ?? [], clip.in, clip.out)) : opts.music;
    const track = await window.ec.pickMusic(mood, p0.name);
    if (track) {
      const imp = await importPaths([track.path]);
      const mm = imp.media[0];
      if (mm) {
        S().commit((p) => {
          let t = p.tracks.find((x) => x.id === 'pl-music');
          if (!t) {
            t = { id: 'pl-music', kind: 'audio', name: 'Música', clips: [] };
            p.tracks.push(t);
          }
          t.clips = musicClips(track, total, { mediaId: mm.id, volume: 0.16 }).map((x) => ({ id: uid('c'), ...x }) as Clip);
          p.audio = { ...(p.audio ?? {}), duck: true, normalize: true };
        });
        added.music = track.name;
      }
    }
  }
  if (opts.broll) {
    const m0 = p0.media.find((m) => m.id === clip.mediaId);
    const plan = await window.ec.planBroll(m0?.transcript ?? [], clip.in, clip.out);
    if (plan.length) {
      const imp = await importPaths(plan.map((b) => b.path));
      const byPath = new Map(imp.media.map((m) => [m.path.replace(/\\/g, '/').toLowerCase(), m]));
      S().commit((p) => {
        const f = findClip(p, clip.id);
        if (!f) return;
        const sp = speedOf(f.clip);
        const items = plan
          .map((b) => ({ b, m: byPath.get(b.path.replace(/\\/g, '/').toLowerCase()) }))
          .filter((x) => x.m)
          .map(({ b, m }) => {
            const d = Math.max(0.5, Math.min(b.len, (m!.duration || b.len) - 0.1));
            const inn = Math.min(0.4, Math.max(0, (m!.duration || d) - d));
            return { id: uid('c'), mediaId: m!.id, start: r3(f.clip.start + b.at / sp), in: r3(inn), out: r3(inn + d), fit: 'fill' as const, volume: 0, speed: 1 };
          });
        if (!items.length) return;
        // The person mask must not draw the speaker over the B-roll: split the main clip around it.
        if (f.clip.masks?.some((mk) => mk.mode === 'front')) {
          const pieces = splitAround(f.clip, items.map((x) => ({ start: x.start, end: x.start + (x.out - x.in) }))).map((x, k) => ({ ...x, id: k === 0 ? f.clip.id : uid('c') }) as Clip);
          f.track.clips.splice(f.index, 1, ...pieces);
        }
        let t = p.tracks.find((x) => x.id === 'pl-broll');
        if (!t) {
          t = { id: 'pl-broll', kind: 'video', name: 'B-roll', clips: [] };
          p.tracks.splice(p.tracks.indexOf(f.track) + 1, 0, t);
        }
        t.clips = [...t.clips.filter((c) => c.start >= end(f.clip) || c.start + (c.out - c.in) <= f.clip.start), ...items].sort((a, b) => a.start - b.start);
        added.broll = items.length;
      });
    }
  }
  if (opts.sfx) {
    for (const s of sfxPlan(beats)) {
      await addSfx(s.id, s.at, s.volume);
      added.sfx++;
    }
  }
  S().setStatus(`Edição: ${added.punches} zooms, ${added.sfx} sons${added.progress ? ', barra' : ''}${added.cta ? ', CTA' : ''}${added.music ? `, música ${added.music}` : ''}${added.broll ? `, ${added.broll} B-roll` : ''}`);
  return added;
}

/** Last AI review (the Captions page lists what changed). */
export const reviewState: { applied: { wrong: string; right: string; s: number }[] } = { applied: [] };

/**
 * "Rever com IA": Claude reads what was said in each clip with speech and fixes what Whisper heard
 * wrong (words that sound alike but make no sense, names, foreign words). Fixes go into the
 * transcript (future captions) and into the captions already on the timeline (one undo step).
 */
export async function reviewCaptions(opts: { clipId?: string; context?: string } = {}) {
  const clips = speechClips(opts.clipId);
  if (!clips.length) throw new Error('Não há clips com fala na timeline');
  const learned = (await window.ec.learned()).words;
  const all: { wrong: string; right: string; s: number }[] = [];
  const fixesAll: { wrong: string; right: string }[] = [];
  try {
    for (const c of clips) {
      const m = S().project.media.find((x) => x.id === c.mediaId)!;
      const words = await ensureTranscript(m);
      S().setStatus(`A IA está a rever o que foi dito em ${m.name}…`, true);
      const lines = transcriptLines(words, c.in, c.out);
      if (!lines.trim()) continue;
      const fixes = [...learned.map((w) => ({ wrong: w.from, right: w.to })), ...parseSpellFixes(await window.ec.aiAsk(spellPrompt(lines, { context: opts.context, learned }), { model: 'sonnet' }))];
      if (!fixes.length) continue;
      const r = applySpellFixes(words, fixes);
      S().setTranscript(m.id, r.words, m.transcriptKey);
      all.push(...r.applied.filter((x) => x.s >= c.in - 0.5 && x.s <= c.out + 0.5));
      fixesAll.push(...fixes);
    }
    if (fixesAll.length) {
      // Captions already made: same fixes inside each caption's own words.
      S().commit((p) => {
        for (const t of p.tracks)
          for (const c of t.clips) {
            if (c.graphic || c.text === undefined) continue;
            const ws = c.words?.length ? c.words : null;
            if (ws) {
              const r = applySpellFixes(ws, fixesAll);
              if (r.applied.length) {
                c.words = r.words;
                c.text = r.words.map((w) => w.w).join(' ');
              }
            } else {
              const r = applySpellFixes(c.text.split(/\s+/).filter(Boolean).map((w, i) => ({ w, s: i, e: i + 1 })), fixesAll);
              if (r.applied.length) c.text = r.words.map((w) => w.w).join(' ');
            }
          }
      });
    }
    reviewState.applied = all;
    S().setStatus(all.length ? `${all.length} palavras corrigidas pela IA (Ctrl+Z desfaz nas legendas)` : 'A IA não encontrou erros nas legendas');
    return { fixed: all };
  } catch (e) {
    S().setStatus(`Rever legendas: ${(e as Error).message}`);
    throw e;
  }
}

/** Face position per clip source range, so editing a model and applying it again is quick. */
const faceCache = new Map<string, { faceX: number | null; faceY: number | null; faceH: number | null }>();

export async function applyCaptionModel(ref: string | CaptionModel, opts: { clipId?: string; keywordAI?: boolean } = {}) {
  const p0 = S().project;
  const sel = S().selected;
  const clipId = opts.clipId ?? (sel && findClip(p0, sel)?.clip.mediaId ? sel : undefined);
  const cands = speechClips(clipId).filter((c) => p0.media.find((m) => m.id === c.mediaId)?.kind === 'video');
  const clip = cands.sort((a, b) => dur(b) - dur(a))[0];
  if (!clip) throw new Error('Põe um vídeo com fala na timeline (ou seleciona-o)');
  const m = p0.media.find((x) => x.id === clip.mediaId)!;
  const model = typeof ref === 'string' ? (await window.ec.listCaptionModels()).find((x) => x.id === ref) : validateModel(ref);
  if (!model) throw new Error(`Modelo de legendas desconhecido: ${String(ref)}`);
  const off = window.ec.onMatteProgress((pr) => {
    if (pr.status) S().setStatus(pr.status, true);
    if (typeof pr.progress === 'number') S().setStatus(`A recortar a pessoa… ${Math.round(pr.progress * 100)}%`, true);
  });
  try {
    const words = await ensureTranscript(m);
    const groups = await window.ec.captionClips(clip, words, groupingFor(model));
    if (!groups.length) throw new Error('Não encontrei fala neste clip');
    // Face in the source frame -> on the canvas (fill crops the source, fit shows it whole).
    const { w: W, h: H } = p0.canvas;
    const sw = m.width || W;
    const sh = m.height || H;
    const k = clip.fit === 'fit' ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh);
    let face: { y: number; h: number } | null = null;
    try {
      const key = `${m.path}|${clip.in}|${clip.out}`;
      const f = faceCache.get(key) ?? (await window.ec.detectFace({ file: m.path, tin: clip.in, tout: clip.out, w: sw, h: sh }));
      faceCache.set(key, f);
      if (f.faceY != null && f.faceH != null) face = { y: 0.5 + ((f.faceY - 0.5) * sh * k) / H, h: (f.faceH * sh * k) / H };
    } catch {
      /* no face engine: default positions */
    }
    const old = (clip.masks ?? []).find((mk) => mk.shape === 'person' && mk.mode === 'front' && mk.matte && mk.matte.in <= clip.in + 0.01 && mk.matte.out >= clip.out - 0.01);
    const matte = old?.matte ?? { file: await window.ec.matte({ file: m.path, tin: clip.in, tout: clip.out }), in: clip.in, out: clip.out, px: -1, py: -1 };
    let keywords: (number | null)[] | undefined;
    if (model.kind === 'atras-frente' && opts.keywordAI !== false) {
      try {
        S().setStatus('A IA está a escolher a palavra principal de cada legenda…', true);
        const blocks = groups.map((g) => (g.words ?? []).map((w) => w.w));
        keywords = parseKeywordPicks(await window.ec.aiAsk(keywordPrompt(blocks, { learned: (await window.ec.learned()).keywords }), { model: 'haiku' }), blocks);
      } catch {
        keywords = undefined; // automatic pick
      }
    }
    const { back, front } = modelCaptions(model, groups, W, H, face, { keywords });
    const range = { start: clip.start, end: end(clip) };
    S().commit((p) => {
      const f = findClip(p, clip.id);
      if (!f) throw new Error('O clip mudou entretanto');
      if (!old) f.clip.masks = [...(f.clip.masks ?? []).filter((mk) => !(mk.shape === 'person' && mk.mode === 'front')), { id: uid('mk'), shape: 'person', matte, x: 0.5, y: 0.5, w: 1, h: 1, feather: 0, invert: false, mode: 'front', amount: 1 }];
      // Earlier automatic captions over this clip go away (the model replaces them).
      for (const t of p.tracks) t.clips = t.clips.filter((c) => !(c.auto && c.text !== undefined && !c.graphic && c.start < range.end && end(c) > range.start));
      const track = (id: string, name: string, isFront: boolean) => {
        let t = p.tracks.find((x) => x.id === id);
        if (!t) {
          t = { id, kind: 'video', name, clips: [], ...(isFront ? { front: true } : {}) };
          p.tracks.splice(p.tracks.map((x) => x.kind).lastIndexOf('video') + 1, 0, t);
        }
        return t;
      };
      const add = (t: Track, list: Omit<Clip, 'id'>[]) => {
        for (const c of list) t.clips.push({ ...c, id: uid('c'), auto: true });
        t.clips.sort((a, b) => a.start - b.start);
      };
      add(track('cm-back', 'Legendas atrás', false), back as Omit<Clip, 'id'>[]);
      if (front.length) add(track('cm-front', 'Legendas à frente', true), front as Omit<Clip, 'id'>[]);
      // Cards high in the frame would sit on the big words: they move down, over the legs.
      for (const t of p.tracks) for (const c of t.clips) if (c.graphic && c.graphic.kind === 'title' && (c.graphic.y ?? 0.5) < 0.35) c.graphic = { ...c.graphic, y: 0.8 };
      // Graphics (titles, cards) stay readable over the person.
      for (const t of p.tracks) if (t.id !== 'cm-back' && t.kind === 'video' && t.clips.length && t.clips.every((c) => c.graphic)) t.front = true;
    });
    S().setStatus(`Modelo "${model.label}": ${back.length + front.length} legendas`);
    return { model: model.label, back: back.length, front: front.length, face };
  } catch (e) {
    S().setStatus(`Modelo de legendas: ${(e as Error).message}`);
    throw e;
  } finally {
    off();
  }
}

export async function cutSilences(clipId: string, minPause = 0.5, padding = 0.12, byLevel = false) {
  const f = findClip(S().project, clipId);
  const m = f && S().project.media.find((x) => x.id === f.clip.mediaId);
  if (!f || !m) throw new Error('Escolhe um clip de vídeo');
  await ensureTranscript(m);
  const texts = textClips(S().project);
  const hadCaptions = texts.some((c) => c.auto && c.start < end(f.clip) && end(c) > f.clip.start);
  const style = texts.find((c) => c.auto)?.style ?? 'elite';
  const r = S().cutSilences(clipId, minPause, padding, byLevel && m.peaks ? decodePeaks(m.peaks) : null);
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
    tool: S().tool,
    mark_in: S().markIn,
    mark_out: S().markOut,
    source_media: S().source,
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
      ...(t.locked ? { locked: true } : {}),
      ...(t.of ? { sound_of: t.of } : {}),
      clips: t.clips.map((c: Clip) => ({
        id: c.id,
        ...(c.flag ? { flag: c.flag } : {}),
        start: c.start,
        duration: Math.round(dur(c) * 1000) / 1000,
        ...(c.mediaId ? { media_id: c.mediaId, in: c.in, out: c.out, volume: c.volume ?? 1, fit: c.fit ?? 'fill', speed: c.speed ?? 1 } : {}),
        ...(c.gen ? { generator: c.gen, ...(c.gen === 'solid' ? { solid_color: c.genColor ?? '#000000' } : {}) } : {}),
        ...(c.link ? { link: c.link } : {}),
        ...(c.silent ? { silent: true } : {}),
        ...(c.transitionIn ? { transition_in: c.transitionIn } : {}),
        ...(c.transitionOut ? { transition_out: c.transitionOut } : {}),
        ...(c.keyframes ? { keyframes: c.keyframes } : {}),
        ...(c.mods ? { modifiers: c.mods } : {}),
        ...(c.blend ? { blend: c.blend } : {}),
        ...(c.blendIf ? { blend_if: c.blendIf } : {}),
        ...(c.colorToAlpha ? { color_to_alpha: c.colorToAlpha } : {}),
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
    for (const c of video[0].clips) if (c.mediaId && c.start > 0.05 && !c.transitionIn) want.push({ id: 'swoosh', at: c.start });
  if (modes.includes('graphics'))
    for (const c of textClips(p)) if (c.graphic && c.graphic.kind !== 'progress') want.push({ id: 'pop', at: c.start + 0.05 });
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
  else clip = p.tracks.filter((t) => t.kind === 'audio' && !t.of && !/^(sfx|efeitos)/i.test(t.name)).flatMap((t) => t.clips)[0];
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
