// Automatic B-roll: the AI reads what is said and proposes a few short cut-aways over concrete
// things ("carro de luxo", "Maldivas", "supermercado"); each one is matched to the Gui's folder
// (Vídeos\B-roll, by file name and a short description) or searched on Pexels (electron/broll.cjs).
// Pure helpers shared by the shorts builder and the timeline action.

const r3 = (n) => Math.round(n * 1000) / 1000;
const STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'a', 'o', 'as', 'os', 'e', 'em', 'um', 'uma', 'com', 'para', 'por', 'no', 'na', 'nos', 'nas', 'the', 'of', 'and', 'in', 'on', 'with', 'mp4', 'mov', 'clip', 'video', 'broll', 'b-roll']);

/** Words of a name or description, lower case, without accents, without stop words. */
export function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Prompt: where a cut-away helps (concrete things said), 2-4 per minute, never over the hook. */
export function brollPrompt(lines, { max = 4, library = [] } = {}) {
  const lib = library.length ? `\nPlanos que o editor já tem (prefere estes quando servem):\n${library.slice(0, 120).map((l) => `- ${l}`).join('\n')}\n` : '';
  return `És editor de vídeos curtos (Reels/TikTok). Nesta fala, escolhe até ${max} momentos onde um plano de B-roll (imagem de apoio, 1,5 a 2,5 s) por cima da pessoa ajuda: quando ela fala de uma coisa concreta e visual (um carro de luxo, uma praia, dinheiro, uma casa, um supermercado, uma família à mesa). Nunca nos primeiros 3 segundos, nunca em frases abstratas.${lib}
Fala (tempo em segundos do vídeo):
${lines}

Responde APENAS com JSON: {"inserts":[{"at":12.4,"len":2,"pt":"carro de luxo na estrada","en":"luxury car driving"}]}
"at" = segundo em que começa a palavra; "pt" = o que se vê (português, 2-5 palavras); "en" = pesquisa em inglês para banco de vídeos.`;
}

/** Cleans the model's inserts: inside [from, to], 3 s after the start, 1.2-2.5 s, no overlaps. */
export function parseInserts(json, { from = 0, to = Infinity, max = 4, gap = 2 } = {}) {
  const list = Array.isArray(json?.inserts) ? json.inserts : Array.isArray(json) ? json : [];
  const out = [];
  for (const x of list) {
    const at = Number(x?.at);
    const len = Math.max(1.2, Math.min(2.5, Number(x?.len) || 2));
    const pt = String(x?.pt ?? '').trim().slice(0, 60);
    const en = String(x?.en ?? '').trim().slice(0, 60);
    if (!Number.isFinite(at) || at < from + 3 || at + len > to - 0.5 || (!pt && !en)) continue;
    if (out.some((o) => at < o.at + o.len + gap && at + len + gap > o.at)) continue;
    out.push({ at: r3(at), len: r3(len), pt, en });
  }
  return out.sort((a, b) => a.at - b.at).slice(0, max);
}

/** Best folder clip for an insert (shared words with name + description), or null under `min`. */
export function matchLibrary(insert, library, { min = 1, used = new Set() } = {}) {
  const want = new Set([...tokens(insert.pt), ...tokens(insert.en)]);
  let best = null;
  let score = 0;
  for (const item of library || []) {
    const have = new Set([...tokens(item.name), ...tokens(item.desc)]);
    let s = 0;
    for (const w of want) if (have.has(w)) s++;
    if (used.has(item.path)) s -= 0.5;
    if (s > score) {
      score = s;
      best = item;
    }
  }
  return score >= min ? best : null;
}

/**
 * The main clip split around the cut-aways (timeline seconds): pieces under a B-roll lose their
 * person "front" masks (the person is not on screen there, so it must not be drawn over the
 * B-roll). Returns the clip bodies in order (ids left to the caller).
 */
export function splitAround(clip, ranges) {
  const sp = clip.speed || 1;
  const end = clip.start + (clip.out - clip.in) / sp;
  const cuts = [];
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    const s = Math.max(clip.start, r.start);
    const e = Math.min(end, r.end);
    if (e - s > 0.05) cuts.push({ s, e });
  }
  const pieces = [];
  let t = clip.start;
  const piece = (s, e, under) => {
    const body = { ...clip, start: r3(s), in: r3(clip.in + (s - clip.start) * sp), out: r3(clip.in + (e - clip.start) * sp) };
    delete body.id;
    if (under && body.masks) body.masks = body.masks.filter((m) => m.mode !== 'front');
    if (body.keyframes) body.keyframes = shiftKeys(body.keyframes, s - clip.start);
    pieces.push(body);
  };
  for (const c of cuts) {
    if (c.s - t > 0.05) piece(t, c.s, false);
    piece(c.s, c.e, true);
    t = c.e;
  }
  if (end - t > 0.05) piece(t, end, false);
  return pieces;
}

/** Keyframes of a piece that starts `dt` s into the original clip. */
function shiftKeys(kf, dt) {
  const out = {};
  for (const [k, list] of Object.entries(kf)) out[k] = (list || []).map((x) => ({ ...x, t: r3(x.t - dt) })).filter((x) => x.t >= -0.5);
  return out;
}
