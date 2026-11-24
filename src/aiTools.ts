// The eight tools of the IA panel (src/components/AiPanel.tsx). Each one is also an MCP tool, so
// Claude and the Gui run exactly the same code. Everything runs on this PC: Whisper for speech,
// the colour maths of develop.js, and `claude -p` (the Claude subscription) only for the
// suggestions and the voice commands.
import { useEditor } from './store';
import { autoCaptions, cutSilences, ensureTranscript } from './actions';
import { handleMcp } from './mcpHandler';
import { CUT_PACES, parseSuggestions, parseVoice, partnerForSplit, suggestPrompt, timelineWords, voicePrompt, wordLines, zoomKeys } from './lib/autoedit.js';
import type { SplitLayout, Suggestion } from './lib/autoedit.js';
import { autoTone, autoWhiteBalance } from './lib/develop.js';
import type { DevSettings } from './lib/develop.js';
import { dur, end, mediaUrl, projectDuration, r3 } from './lib/project';
import type { Clip } from './types';

const S = () => useEditor.getState();
export type Pace = keyof typeof CUT_PACES;

/** Several steps, one undo: the history keeps only the state from before the first step. */
async function asOneStep<T>(fn: () => Promise<T>): Promise<T> {
  const n0 = S().past.length;
  try {
    return await fn();
  } finally {
    const past = S().past;
    if (past.length > n0 + 1) useEditor.setState({ past: past.slice(0, n0 + 1) });
  }
}

/** Picture clips with speech on the visible video tracks. */
function speechClipIds() {
  const p = S().project;
  return p.tracks
    .filter((t) => t.kind === 'video' && !t.hidden && !t.locked)
    .flatMap((t) => t.clips)
    .filter((c) => p.media.find((m) => m.id === c.mediaId)?.hasAudio)
    .map((c) => c.id);
}

// 1 ------------------------------------------------------------------- transcription
export async function transcribeAll(style = 'elite') {
  return autoCaptions({ style });
}

// 2 ------------------------------------------------------------------- breath cut + auto cut
export async function cutBreaths(pace: Pace = 'normal', clipId?: string) {
  const { minPause, padding } = CUT_PACES[pace] ?? CUT_PACES.normal;
  const ids = clipId ? [clipId] : speechClipIds();
  if (!ids.length) throw new Error('Não há clips com fala na timeline');
  return asOneStep(async () => {
    let removed = 0;
    let pieces = 0;
    for (const id of ids) {
      if (!S().project.tracks.some((t) => t.clips.some((c) => c.id === id))) continue;
      const r = await cutSilences(id, minPause, padding, true);
      removed += r.removed;
      pieces += r.pieces;
    }
    S().setStatus(`Respiros e pausas cortados: ${removed.toFixed(1)} s em ${pieces} partes`);
    return { removed: r3(removed), pieces };
  });
}

// 3 ------------------------------------------------------------------- AI colour
async function framePixels(path: string, time: number) {
  const png = await window.ec.freezeFrame(path, time);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = mediaUrl(png);
  await img.decode();
  // Small copy: the analysis only needs the tones, not the detail.
  const k = Math.min(1, 480 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** White balance + tone for each picture clip, from a frame in its middle (like Lightroom's Auto). */
export async function autoColor(ids?: string[], opts: { wb?: boolean } = {}) {
  const p = S().project;
  const list = p.tracks
    .filter((t) => t.kind === 'video' && !t.locked)
    .flatMap((t) => t.clips)
    .filter((c) => (ids ? ids.includes(c.id) : true))
    .filter((c) => {
      const m = p.media.find((x) => x.id === c.mediaId);
      return m && m.kind !== 'audio';
    });
  if (!list.length) throw new Error('Não há clips de imagem para corrigir');
  return asOneStep(async () => {
    let n = 0;
    for (const c of list) {
      const m = S().project.media.find((x) => x.id === c.mediaId)!;
      S().setStatus(`Cor automática: ${n + 1}/${list.length}…`, true);
      const px = await framePixels(m.path, m.kind === 'image' ? 0 : c.in + (c.out - c.in) / 2);
      const cur: DevSettings = { ...(c.color?.dev ?? {}) };
      const wb = opts.wb === false ? {} : autoWhiteBalance(px.data, px.width, px.height);
      const tone = autoTone(px.data, px.width, px.height, { ...cur, ...wb });
      S().setGrade([c.id], { dev: { ...cur, ...wb, ...tone } });
      n++;
    }
    S().setStatus(`Cor corrigida em ${n} ${n === 1 ? 'clip' : 'clips'}`);
    return { clips: n };
  });
}

// 5 ------------------------------------------------------------------- zoom & edit suggestions
export async function suggestEdits(count = 6): Promise<Suggestion[]> {
  // Make sure every speech clip has its transcript.
  for (const id of speechClipIds()) {
    const c = S().project.tracks.flatMap((t) => t.clips).find((x) => x.id === id);
    const m = c && S().project.media.find((x) => x.id === c.mediaId);
    if (m) await ensureTranscript(m);
  }
  const words = timelineWords(S().project);
  if (!words.length) throw new Error('Não encontrei fala na timeline para analisar');
  S().setStatus('O Claude está a ler a timeline…', true);
  const raw = await window.ec.aiAsk(suggestPrompt(wordLines(words), count), { model: 'sonnet' });
  const list = parseSuggestions(raw, projectDuration(S().project));
  S().setStatus(list.length ? `${list.length} sugestões` : 'O Claude não encontrou momentos fortes');
  return list;
}

/** The picture clip on top at time t (the one a zoom should move). */
function pictureAt(t: number): Clip | null {
  const p = S().project;
  const vids = p.tracks.filter((x) => x.kind === 'video' && !x.hidden && !x.locked);
  for (let i = vids.length - 1; i >= 0; i--) {
    const c = vids[i]!.clips.find((x) => x.mediaId && t >= x.start && t < end(x));
    if (c) return c;
  }
  return null;
}

export async function applySuggestions(list: Suggestion[]) {
  return asOneStep(async () => {
    let n = 0;
    for (const s of list) {
      if (s.kind === 'title' && s.text) {
        S().addText(s.text, s.t, 1.8, 'title');
        n++;
        continue;
      }
      const c = pictureAt(s.t);
      if (!c) continue;
      const local = s.t - c.start;
      for (const k of zoomKeys(s.kind, local, dur(c))) S().setKeyframe(c.id, 'zoom', c.start + k.t, k.v);
      n++;
    }
    S().setStatus(`${n} sugestões aplicadas (Ctrl+Z desfaz todas)`);
    return { applied: n };
  });
}

// 6 ------------------------------------------------------------------- split screen
export function splitScreen(layout: SplitLayout = 'top-bottom', ratio = 0.5, aId?: string, bId?: string) {
  const p = S().project;
  const a = aId ?? S().selected;
  if (!a) throw new Error('Escolhe o primeiro clip (o de cima / esquerda)');
  const b = bId ?? partnerForSplit(p, a)?.id;
  if (!b) throw new Error('Põe o segundo vídeo noutra pista de vídeo, ao mesmo tempo que o primeiro');
  // The clip on the higher track is drawn over the other: the halves do not overlap, so order does not matter.
  S().splitScreen(a, b, layout, ratio);
  S().setStatus('Tela dividida');
  return { a, b };
}

// 7 ------------------------------------------------------------------- voice command
let rec: { mr: MediaRecorder; chunks: Blob[]; stream: MediaStream } | null = null;

export const isRecording = () => rec !== null;

export async function startVoice() {
  if (rec) return;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  const chunks: Blob[] = [];
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mr.start();
  rec = { mr, chunks, stream };
  S().setStatus('A ouvir… (clica outra vez para parar)');
}

export async function stopVoice() {
  const r = rec;
  if (!r) return null;
  rec = null;
  const done = new Promise<void>((ok) => (r.mr.onstop = () => ok()));
  r.mr.stop();
  await done;
  r.stream.getTracks().forEach((t) => t.stop());
  const bytes = new Uint8Array(await new Blob(r.chunks, { type: 'audio/webm' }).arrayBuffer());
  S().setStatus('A perceber o que disseste…', true);
  const file = await window.ec.saveVoice(bytes);
  const t = await window.ec.transcribe(file, { language: 'pt' });
  const said = t.words.map((w) => w.w).join(' ').replace(/\s+/g, ' ').trim();
  if (!said) {
    S().setStatus('Não ouvi nada');
    return { said: '', say: 'Não ouvi nada', done: 0 };
  }
  return voiceCommand(said);
}

/** Runs a command in words ("corta aqui e mete zoom"): Claude turns it into editor tools. */
export async function voiceCommand(said: string) {
  const st = S();
  const p = st.project;
  const under = pictureAt(st.playhead);
  const clips = p.tracks
    .flatMap((t) => t.clips.map((c) => `${c.id} ${t.name} ${c.start.toFixed(2)}-${end(c).toFixed(2)}${c.text ? ` "${c.text.slice(0, 30)}"` : ''}`))
    .slice(0, 120)
    .join('\n');
  S().setStatus(`"${said}" · a pensar…`, true);
  const raw = await window.ec.aiAsk(voicePrompt(said, { playhead: st.playhead, selected: st.selected, under: under?.id ?? null, clips }), { model: 'haiku' });
  const { actions, say } = parseVoice(raw);
  let done = 0;
  await asOneStep(async () => {
    for (const a of actions) {
      await handleMcp(a.tool, a.args);
      done++;
    }
  });
  S().setStatus(`🎙 "${said}" → ${say || (done ? `${done} ações` : 'nada a fazer')}`);
  return { said, say, done };
}

// 8 ------------------------------------------------------------------- edit on its own
export type AutoStep = 'captions' | 'cut' | 'audio' | 'color' | 'zoom';
export const AUTO_STEPS: { id: AutoStep; label: string }[] = [
  { id: 'cut', label: 'Cortar respiros e pausas' },
  { id: 'audio', label: 'Nivelar a voz (-14 LUFS)' },
  { id: 'color', label: 'Corrigir a cor' },
  { id: 'captions', label: 'Legendas animadas' },
  { id: 'zoom', label: 'Zooms nos melhores momentos' },
];

export async function autoEdit(opts: { steps?: AutoStep[]; pace?: Pace; style?: string; onStep?: (i: number, step: AutoStep) => void } = {}) {
  const steps = opts.steps?.length ? opts.steps : AUTO_STEPS.map((s) => s.id);
  if (!speechClipIds().length) throw new Error('Põe primeiro um vídeo com fala na timeline');
  const log: string[] = [];
  await asOneStep(async () => {
    for (const [i, step] of AUTO_STEPS.filter((s) => steps.includes(s.id)).entries()) {
      opts.onStep?.(i, step.id);
      if (step.id === 'cut') {
        const r = await cutBreaths(opts.pace ?? 'normal');
        log.push(`${r.removed.toFixed(1)} s de pausas cortados`);
      } else if (step.id === 'audio') {
        await handleMcp('set_audio', { normalize: true });
        log.push('voz nivelada a -14 LUFS na exportação');
      } else if (step.id === 'color') {
        const r = await autoColor();
        log.push(`cor em ${r.clips} clips`);
      } else if (step.id === 'captions') {
        const r = await transcribeAll(opts.style ?? 'elite');
        log.push(`${r.captions} legendas`);
      } else if (step.id === 'zoom') {
        const list = (await suggestEdits(6)).filter((s) => s.kind !== 'title');
        const r = await applySuggestions(list);
        log.push(`${r.applied} zooms`);
      }
    }
  });
  S().setStatus(`Editado: ${log.join(' · ')}. Ctrl+Z desfaz tudo.`);
  return { done: log };
}
