// Pure helpers of the IA panel (src/components/AiPanel.tsx): breath cut edges, safe zones, split
// screen, zoom suggestions and voice commands. No DOM, no Electron: tested in test/autoedit.test.mjs.
import { setCrop } from './crop.js';

const r3 = (n) => Math.round(n * 1000) / 1000;
const speedOf = (c) => Math.max(0.25, Math.min(4, c.speed ?? 1));
const clipEnd = (c) => c.start + Math.max(0, (c.out - c.in) / speedOf(c));

// ----------------------------------------------------------------- breath / silence cut

/** Pace presets of "Corte de respiros": shortest pause that is cut and the air kept around words. */
export const CUT_PACES = {
  suave: { label: 'Suave', minPause: 0.8, padding: 0.2 },
  normal: { label: 'Normal', minPause: 0.5, padding: 0.14 },
  rapido: { label: 'Rápido', minPause: 0.3, padding: 0.1 },
};

/**
 * Widens speech segments (source time) while the sound is still loud, so a cut never eats the
 * start or the end of a word that Whisper timed a bit short. peaks: 0..255 levels, `rate` per
 * second of source; thr: level that counts as sound (0..255). Overlapping segments merge.
 */
export function refineEdges(segs, peaks, opts = {}) {
  if (!peaks?.length || !segs.length) return segs;
  const rate = opts.rate ?? 100;
  const thr = opts.thr ?? 40;
  const maxExtend = opts.maxExtend ?? 0.3;
  const mergeGap = opts.mergeGap ?? 0.15;
  const lo = opts.min ?? 0;
  const hi = opts.max ?? peaks.length / rate;
  const loud = (t) => {
    const i = Math.floor(t * rate);
    return i >= 0 && i < peaks.length && peaks[i] >= thr;
  };
  const step = 1 / rate;
  const out = segs.map((s) => {
    let a = s.in;
    let b = s.out;
    for (let k = 0; k * step < maxExtend && a - step >= lo && loud(a - step); k++) a -= step;
    for (let k = 0; k * step < maxExtend && b + step <= hi && loud(b); k++) b += step;
    return { in: r3(Math.max(lo, a)), out: r3(Math.min(hi, b)) };
  });
  const merged = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    // A gap shorter than mergeGap is not worth a jump cut.
    if (last && s.in - last.out < mergeGap) last.out = Math.max(last.out, s.out);
    else merged.push({ ...s });
  }
  return merged;
}

// ----------------------------------------------------------------- safe zones

/**
 * Areas the platforms cover with their own buttons and text on a 9:16 video, as fractions of the
 * frame (approximate, measured on 1080x1920 screenshots of each app, 2026). Only drawn on the viewer.
 */
export const SAFE_ZONES = {
  reels: { label: 'Instagram Reels', top: 0.14, bottom: 0.2, left: 0.04, right: 0.13 },
  tiktok: { label: 'TikTok', top: 0.1, bottom: 0.22, left: 0.04, right: 0.15 },
  shorts: { label: 'YouTube Shorts', top: 0.08, bottom: 0.18, left: 0.04, right: 0.13 },
};

// ----------------------------------------------------------------- split screen

/**
 * Crop and position of two clips for a split screen. Each clip shows the middle band of its own
 * picture, moved into its half (crop first, then the move: the same order as the export).
 * layout: 'top-bottom' (a on top) or 'left-right' (a on the left); ratio: share of a (0.2..0.8).
 */
export function splitLayout(layout = 'top-bottom', ratio = 0.5) {
  const r = Math.max(0.2, Math.min(0.8, Number(ratio) || 0.5));
  if (layout === 'left-right') {
    return {
      a: { crop: { left: (1 - r) / 2, right: (1 - r) / 2, top: 0, bottom: 0 }, px: -(1 - r) / 2, py: 0 },
      b: { crop: { left: r / 2, right: r / 2, top: 0, bottom: 0 }, px: r / 2, py: 0 },
    };
  }
  return {
    a: { crop: { top: (1 - r) / 2, bottom: (1 - r) / 2, left: 0, right: 0 }, px: 0, py: -(1 - r) / 2 },
    b: { crop: { top: r / 2, bottom: r / 2, left: 0, right: 0 }, px: 0, py: r / 2 },
  };
}

/** Applies a split screen to clips a and b of a project (in place). */
export function applySplit(p, aId, bId, layout, ratio) {
  const all = p.tracks.flatMap((t) => t.clips.map((c) => ({ c, t })));
  const A = all.find((x) => x.c.id === aId);
  const B = all.find((x) => x.c.id === bId);
  if (!A || !B) throw new Error('Escolhe dois clips de vídeo');
  if (A.t === B.t) throw new Error('Os dois clips têm de estar em pistas de vídeo diferentes, ao mesmo tempo');
  const L = splitLayout(layout, ratio);
  for (const [x, l] of [[A.c, L.a], [B.c, L.b]]) {
    x.fit = 'fill';
    setCrop(x, { ...l.crop, soft: 0 });
    x.keyframes = { ...(x.keyframes ?? {}), px: [{ t: 0, v: r3(l.px) }], py: [{ t: 0, v: r3(l.py) }], scale: [{ t: 0, v: 1 }] };
  }
  return { a: aId, b: bId };
}

/** The clip on another video track that plays at the same time as clip `id` (for split screen). */
export function partnerForSplit(p, id) {
  const tracks = p.tracks.filter((t) => t.kind === 'video');
  const own = tracks.find((t) => t.clips.some((c) => c.id === id));
  const c = own?.clips.find((x) => x.id === id);
  if (!c) return null;
  let best = null;
  let bestOverlap = 0;
  for (const t of tracks) {
    if (t === own) continue;
    for (const o of t.clips) {
      if (!o.mediaId) continue;
      const ov = Math.min(clipEnd(c), clipEnd(o)) - Math.max(c.start, o.start);
      if (ov > bestOverlap) (best = o), (bestOverlap = ov);
    }
  }
  return best;
}

// ----------------------------------------------------------------- transcript on the timeline

/** Words of the picture clips placed on the timeline (timeline seconds), in order. */
export function timelineWords(p) {
  const media = new Map((p.media ?? []).map((m) => [m.id, m]));
  const out = [];
  for (const t of p.tracks) {
    if (t.kind !== 'video' || t.hidden) continue;
    for (const c of t.clips) {
      const m = c.mediaId && media.get(c.mediaId);
      if (!m?.transcript?.length) continue;
      const sp = speedOf(c);
      for (const w of m.transcript) if (w.s >= c.in && w.e <= c.out) out.push({ w: w.w, s: r3(c.start + (w.s - c.in) / sp), e: r3(c.start + (w.e - c.in) / sp), clip: c.id });
    }
  }
  return out.sort((a, b) => a.s - b.s);
}

/** Lines of about `size` words with their timeline time, for prompts: "[12.4] texto". */
export function wordLines(words, size = 12) {
  const lines = [];
  for (let i = 0; i < words.length; i += size) lines.push(`[${words[i].s.toFixed(1)}] ${words.slice(i, i + size).map((w) => w.w).join(' ').replace(/\s+/g, ' ').trim()}`);
  return lines.join('\n');
}

// ----------------------------------------------------------------- zoom & edit suggestions

export const SUGGEST_KINDS = ['punch', 'zoom_in', 'title'];

export function suggestPrompt(lines, count = 6) {
  return `És editor de vídeo de Reels e TikTok. Lê a transcrição (tempo em segundos entre parênteses retos) e escolhe os ${count} melhores momentos para dar ritmo: frases fortes, números, viragens, punchlines.

Para cada momento escolhe um tipo:
- punch: zoom rápido de impacto (a palavra-chave forte)
- zoom_in: aproximação lenta (momento emotivo ou de tensão)
- title: texto curto no ecrã (máximo 4 palavras, tirado da própria fala)

Responde SÓ com JSON: {"moments":[{"t":12.4,"kind":"punch","why":"motivo curto","text":"só para title"}]}
Os tempos têm de existir na transcrição. Português de Portugal.

TRANSCRIÇÃO:
${lines}`;
}

/** Cleans the model's answer: known kinds, times inside the video, at least 1.2 s apart. */
export function parseSuggestions(raw, duration) {
  const list = Array.isArray(raw?.moments) ? raw.moments : Array.isArray(raw) ? raw : [];
  const out = [];
  for (const m of list) {
    const t = Number(m?.t);
    if (!Number.isFinite(t) || t < 0 || t > duration) continue;
    const kind = SUGGEST_KINDS.includes(m.kind) ? m.kind : 'punch';
    if (out.some((o) => Math.abs(o.t - t) < 1.2)) continue;
    const text = kind === 'title' ? String(m.text ?? '').split(/\s+/).slice(0, 4).join(' ').slice(0, 40) : '';
    if (kind === 'title' && !text) continue;
    out.push({ t: r3(t), kind, why: String(m.why ?? '').slice(0, 120), ...(text ? { text } : {}) });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Zoom keyframes (clip local time) of a suggestion: punch = quick kick and back, zoom_in = slow push. */
export function zoomKeys(kind, local, clipLen) {
  const at = (t) => r3(Math.max(0, Math.min(clipLen, t)));
  if (kind === 'zoom_in') return [{ t: at(local), v: 1 }, { t: at(local + 2.2), v: 1.12 }, { t: at(local + 2.6), v: 1 }];
  return [{ t: at(local - 0.02), v: 1 }, { t: at(local + 0.12), v: 1.16 }, { t: at(local + 1.3), v: 1.16 }, { t: at(local + 1.5), v: 1 }];
}

// ----------------------------------------------------------------- voice commands

/** What a spoken command may do: editing only (never export, save, open, import or delete tracks). */
export const VOICE_TOOLS = {
  split_clip: 'corta: {time?, clip_id?}',
  delete_clip: 'apaga: {clip_id, ripple?}',
  trim_clip: 'apara: {clip_id, in?, out?}',
  move_clip: 'move: {clip_id, start}',
  seek: 'vai para: {time}',
  add_marker: 'marcador: {time?, label?}',
  add_text: 'texto/título: {text, start, duration, style?}',
  animate_clip: 'animação: {clip_id, preset: zoom_in|zoom_out|ken_burns|punch|shake|pulse|spin_in|fade_in_out}',
  set_keyframe: 'keyframe: {clip_id, time, zoom?, x?, y?, rotate?, opacity?}',
  set_speed: 'velocidade: {clip_id, speed 0.25..4}',
  set_transition: 'transição: {clip_id, side: in|out, type: fade|slide|whip|zoom|spin|flash|dip|blur, duration}',
  cut_silences: 'corta pausas: {clip_id, min_pause?, padding?}',
  auto_captions: 'legendas: {style?}',
  set_tool: 'ferramenta: {tool: select|trim|blade}',
  mark_in_out: 'marcas: {in?, out?, clear?}',
  edit_to_timeline: 'pôr da Média: {mode: insert|overwrite|replace|fit|top|append, media_id?, time?}',
  trim_edit: 'trim: {kind: ripple|roll|slip|slide, clip_id, delta, edge?}',
  ripple_delete_range: 'apaga troço In-Out: {from?, to?}',
  set_color: 'cor: {clip_id? (sem = todos), look?: natural|cinema|quente|frio|vivo|imobiliario|pb, exposure? -1..1, contrast? -1..1, saturation? -1..1, temperature? -1..1}',
  update_clip: 'muda clip: {clip_id, volume?, text?, style?}',
  show_page: 'página: {page: media|edit|fusion|color|captions|deliver}',
};

export function voicePrompt(said, ctx) {
  const tools = Object.entries(VOICE_TOOLS).map(([k, v]) => `- ${k} ${v}`).join('\n');
  return `És o assistente de voz do editor de vídeo Cinemex. O utilizador disse: "${String(said).slice(0, 500)}"

Transforma isto em ações. Usa SÓ estas ferramentas (argumentos em JSON, tempos em segundos da timeline):
${tools}

Estado: cabeça de leitura em ${ctx.playhead.toFixed(2)} s; clip escolhido: ${ctx.selected ?? 'nenhum'}; clip na cabeça de leitura: ${ctx.under ?? 'nenhum'}.
"aqui" = a cabeça de leitura; "este clip" = o escolhido, senão o da cabeça de leitura.
Clips (id, pista, início-fim):
${ctx.clips}

Responde SÓ com JSON: {"actions":[{"tool":"split_clip","args":{"time":12.3}}],"say":"frase curta do que fizeste, português de Portugal"}
Se não perceberes, devolve {"actions":[],"say":"Não percebi. Diz por exemplo: corta aqui."}`;
}

/** Keeps only allowed tools with object arguments (at most 8 actions). */
export function parseVoice(raw) {
  const list = Array.isArray(raw?.actions) ? raw.actions : [];
  const actions = list
    .filter((a) => a && typeof a.tool === 'string' && Object.hasOwn(VOICE_TOOLS, a.tool))
    .slice(0, 8)
    .map((a) => ({ tool: a.tool, args: a.args && typeof a.args === 'object' && !Array.isArray(a.args) ? a.args : {} }));
  const say = typeof raw?.say === 'string' ? raw.say.slice(0, 200) : '';
  return { actions, say };
}
