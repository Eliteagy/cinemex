// AI actions taken from VideoCraft (docs/engenharia-reversa/videocraft.md): best moments -> batch of
// shorts, titles + chapters, caption translation (any language, optional second caption track) and
// caption checks. Used by the Shorts panel and by the MCP tools, like src/actions.ts.
import { useEditor } from './store';
import { ensureTranscript } from './actions';
import { checkCaptions, chaptersPrompt, fixCaptions, parseChapters, parseTranslation, transcriptLines, translatePrompt, TRANSLATE_BATCH, youtubeChapters } from './lib/aivideo.js';
import { end, uid } from './lib/project';
import type { CanvasPreset, Clip, Hotclip, Media, Track } from './types';

const S = () => useEditor.getState();

/** The video whose transcript the AI reads: given id, else the longest video with sound in the project. */
export function sourceMedia(mediaId?: string): Media {
  const p = S().project;
  if (mediaId) {
    const m = p.media.find((x) => x.id === mediaId);
    if (!m) throw new Error('Média não encontrada');
    return m;
  }
  const vids = p.media.filter((m) => m.kind === 'video' && m.hasAudio).sort((a, b) => b.duration - a.duration);
  if (!vids[0]) throw new Error('Importa um vídeo com som primeiro');
  return vids[0];
}

/** Last results, so the panel and Claude (MCP) share them. */
export const hotclipState: { mediaId: string | null; clips: Hotclip[] } = { mediaId: null, clips: [] };

export async function findHotclips(opts: { mediaId?: string; count?: number; min?: number; max?: number; context?: string } = {}) {
  const m = sourceMedia(opts.mediaId);
  const words = await ensureTranscript(m);
  S().setStatus(`A IA está a procurar os melhores momentos de ${m.name}…`, true);
  try {
    const chapters = (S().project.markers ?? []).filter((k) => k.label && !k.beat && /^cap[ií]tulo|^chapter|^§/i.test(k.label)).map((k) => ({ start: k.t }));
    const clips = await window.ec.findHotclips(words, { count: opts.count, min: opts.min, max: opts.max, context: opts.context, chapters: chapters.length ? chapters : undefined });
    hotclipState.mediaId = m.id;
    hotclipState.clips = clips;
    S().setStatus(clips.length ? `${clips.length} momentos encontrados` : 'A IA não encontrou momentos com essa duração');
    return clips;
  } catch (e) {
    S().setStatus(`Melhores momentos: ${(e as Error).message}`);
    throw e;
  }
}

export async function makeShorts(clips: Hotclip[], opts: { mediaId?: string; outDir?: string; style?: string; reframe?: 'cover' | 'fit'; cards?: boolean; preset?: CanvasPreset; gpu?: boolean } = {}) {
  const m = sourceMedia(opts.mediaId ?? hotclipState.mediaId ?? undefined);
  const words = await ensureTranscript(m);
  S().setStatus(`A criar ${clips.length} shorts…`, true);
  try {
    const out = await window.ec.buildShorts({ ...m, transcript: words, thumb: null } as Media, clips, opts);
    S().setStatus(out ? `${out.length} shorts exportados` : null);
    return out;
  } catch (e) {
    S().setStatus(`Shorts: ${(e as Error).message}`);
    throw e;
  }
}

// ------------------------------------------------------------------ titles + chapters
export async function aiChapters(opts: { mediaId?: string; markers?: boolean } = {}) {
  const m = sourceMedia(opts.mediaId);
  const words = await ensureTranscript(m);
  S().setStatus('A IA está a dividir o vídeo em capítulos…', true);
  try {
    const json = await window.ec.aiAsk(chaptersPrompt(transcriptLines(words)));
    const r = parseChapters(json, m.duration);
    // Chapters become markers at their timeline time (the source's first clip on the timeline).
    if (opts.markers !== false) {
      const clip = S()
        .project.tracks.flatMap((t) => t.clips)
        .find((c) => c.mediaId === m.id);
      for (const c of r.chapters) {
        if (!clip || c.start < clip.in || c.start > clip.out) continue;
        S().addMarker(clip.start + (c.start - clip.in) / (clip.speed ?? 1), `Capítulo: ${c.title}`, '#2b72e6');
      }
    }
    S().setStatus(`${r.chapters.length} capítulos`);
    return { ...r, youtube: youtubeChapters(r.chapters) };
  } catch (e) {
    S().setStatus(`Capítulos: ${(e as Error).message}`);
    throw e;
  }
}

// ------------------------------------------------------------------ translation
/** The caption clips (text track 'Legendas' or every auto caption), sorted. */
function captionClips(trackId?: string): { track: Track; clips: Clip[] } {
  const p = S().project;
  const track = (trackId ? p.tracks.find((t) => t.id === trackId) : p.tracks.find((t) => t.kind === 'text' && t.clips.some((c) => c.words?.length || c.auto))) ?? p.tracks.find((t) => t.kind === 'text');
  if (!track) throw new Error('Não há faixa de legendas');
  return { track, clips: track.clips.filter((c) => !c.graphic).sort((a, b) => a.start - b.start) };
}

/**
 * Translates the captions into `language`. mode 'replace' rewrites them; 'bilingual' puts the
 * translation on a new text track ("Legendas <língua>") a bit higher, so both show at once.
 */
export async function translateCaptions(language: string, opts: { mode?: 'replace' | 'bilingual'; trackId?: string } = {}) {
  const lang = String(language || '').trim();
  if (!lang) throw new Error('Diz para que língua');
  const { track, clips } = captionClips(opts.trackId);
  if (!clips.length) throw new Error('Não há legendas para traduzir');
  const out: (string | null)[] = [];
  try {
    for (let i = 0; i < clips.length; i += TRANSLATE_BATCH) {
      S().setStatus(`A traduzir legendas para ${lang} (${Math.min(clips.length, i + TRANSLATE_BATCH)}/${clips.length})…`, true);
      const items = clips.slice(i, i + TRANSLATE_BATCH).map((c, k) => ({ i: i + k, text: String(c.text ?? '') }));
      out.push(...parseTranslation(await window.ec.aiAsk(translatePrompt(items, lang)), items));
    }
  } catch (e) {
    S().setStatus(`Tradução: ${(e as Error).message}`);
    throw e;
  }
  const missing = out.filter((t) => t === null).length;
  S().commit((p) => {
    const t = p.tracks.find((x) => x.id === track.id)!;
    if (opts.mode === 'bilingual') {
      const nt: Track = { id: uid('t'), kind: 'text', name: `Legendas ${lang}`, clips: [] };
      clips.forEach((c, i) => {
        const text = out[i];
        if (!text) return;
        // Plain caption (no per-word timing), placed above the original line.
        nt.clips.push({ id: uid('c'), start: c.start, in: 0, out: c.out - c.in, text, style: 'clean', y: Math.max(0.05, (c.y ?? 0.8) - 0.09), auto: false });
      });
      p.tracks.splice(p.tracks.indexOf(t) + 1, 0, nt);
    } else {
      for (const [i, c] of clips.entries()) {
        const clip = t.clips.find((x) => x.id === c.id);
        const text = out[i];
        if (!clip || !text) continue;
        clip.text = text;
        // The words no longer match the new language: spread them evenly over the caption.
        const ws = text.split(/\s+/).filter(Boolean);
        const len = clip.out - clip.in;
        clip.words = ws.map((w, k) => ({ w, s: (k * len) / ws.length, e: ((k + 1) * len) / ws.length }));
      }
    }
  });
  S().setStatus(`Legendas traduzidas para ${lang}${missing ? ` (${missing} ficaram por traduzir)` : ''}`);
  return { captions: clips.length - missing, missing };
}

// ------------------------------------------------------------------ caption checks
export function checkCaptionTrack(trackId?: string) {
  const { clips } = captionClips(trackId);
  return checkCaptions(clips.map((c) => ({ id: c.id, start: c.start, end: end(c), text: c.text ?? '' })));
}

export function fixCaptionTrack(trackId?: string) {
  const { track, clips } = captionClips(trackId);
  const fixed = fixCaptions(clips.map((c) => ({ id: c.id, start: c.start, end: end(c), text: c.text ?? '' })));
  const keep = new Map(fixed.map((f) => [f.id, f]));
  let removed = 0;
  let changed = 0;
  S().commit((p) => {
    const t = p.tracks.find((x) => x.id === track.id)!;
    t.clips = t.clips.filter((c) => {
      if (c.graphic) return true;
      const f = keep.get(c.id);
      if (!f) {
        removed++;
        return false;
      }
      if (f.text !== c.text) {
        c.text = f.text;
        changed++;
      }
      const len = f.end - f.start;
      if (Math.abs(len - (c.out - c.in)) > 1e-3) {
        c.out = c.in + len;
        if (c.words) c.words = c.words.filter((w) => w.s < len).map((w) => ({ ...w, e: Math.min(w.e, len) }));
        changed++;
      }
      return true;
    });
  });
  return { removed, changed, left: checkCaptionTrack(track.id) };
}


