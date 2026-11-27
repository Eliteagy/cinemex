// Runs an effect recipe from the generator / library (electron/effectgen.cjs) on the editor: each
// step is one of the editor's own tools (handleMcp), so the values go through the same checks as
// Claude's MCP calls. The whole recipe is one undo step. "$N.campo" in an argument is the field of
// step N's result (e.g. the node made by fusion_add_node, the clip made by add_graphic).
import { useEditor } from './store';
import { handleMcp } from './mcpHandler';
import { asOneStep } from './aiTools';
import { applyCaptionModel } from './actions';
import { activeClip, findClip, isText } from './lib/project';
import type { Clip, EffectCategory, EffectRecipe } from './types';

const S = () => useEditor.getState();

/** Tools that act on a clip (the editor fills clip_id with the target clip). */
const CLIP_TOOLS = new Set(['fusion_add_node', 'fusion_set', 'fusion_set_keyframe', 'add_effect', 'update_effect', 'set_color', 'set_blend', 'set_modifier', 'set_keyframe', 'set_keyframe_ease', 'animate_clip', 'set_transition', 'dissolve', 'set_speed', 'update_graphic']);

/** The clip an effect goes on: the selected picture clip, else the top picture clip under the playhead. */
export function targetClip(category: EffectCategory): Clip | null {
  if (category === 'legendas' || category === 'titulos') return null;
  const p = S().project;
  const sel = S().selected ? findClip(p, S().selected!) : null;
  if (sel && !isText(sel.clip)) return sel.clip;
  const t = S().playhead;
  const vids = p.tracks.filter((x) => x.kind === 'video' && !x.hidden);
  for (let i = vids.length - 1; i >= 0; i--) {
    const c = activeClip(vids[i]!, t);
    if (c) return c;
  }
  return null;
}

const REF = /^\$(\d{1,2})\.([A-Za-z_]+)$/;

function resolveRefs(v: unknown, results: unknown[]): unknown {
  if (typeof v === 'string') {
    const m = REF.exec(v);
    if (!m) return v;
    const r = results[Number(m[1]) - 1] as Record<string, unknown> | undefined;
    const val = r?.[m[2]!];
    if (val === undefined) throw new Error(`O passo ${m[1]} não devolveu ${m[2]}`);
    return val;
  }
  if (Array.isArray(v)) return v.map((x) => resolveRefs(x, results));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveRefs(x, results)]));
  return v;
}

/** Runs the recipe (one undo step). Returns the target clip id and each step's result. */
export async function runRecipe(recipe: EffectRecipe, opts: { clipId?: string } = {}) {
  const needsClip = recipe.steps.some((s) => CLIP_TOOLS.has(s.tool) && !(typeof s.args.clip_id === 'string' && s.args.clip_id.startsWith('$')));
  const clip = opts.clipId ? (findClip(S().project, opts.clipId)?.clip ?? null) : targetClip(recipe.category);
  if (needsClip && recipe.category !== 'titulos' && !clip) throw new Error('Seleciona um clip de vídeo (ou põe a cabeça de leitura em cima dele)');
  const results: unknown[] = [];
  await asOneStep(async () => {
    for (const [i, step] of recipe.steps.entries()) {
      const args = resolveRefs(step.args, results) as Record<string, unknown>;
      if (CLIP_TOOLS.has(step.tool) && args.clip_id === undefined) {
        if (!clip) throw new Error(`Passo ${i + 1} (${step.tool}): falta o clip`);
        args.clip_id = clip.id;
      }
      // "after" must be a node of this clip; anything else (e.g. "in") means "at the end of the chain".
      if (step.tool === 'fusion_add_node' && typeof args.after === 'string') {
        const f = findClip(S().project, String(args.clip_id))?.clip.fusion;
        if (!f?.nodes.some((n) => n.id === args.after)) delete args.after;
      }
      if ((step.tool === 'add_graphic' || step.tool === 'add_text') && args.start === undefined) args.start = S().playhead;
      try {
        results.push(await handleMcp(step.tool, args));
      } catch (e) {
        throw new Error(`Passo ${i + 1} (${step.tool}): ${(e as Error).message}`);
      }
    }
  });
  return { clipId: clip?.id ?? null, results };
}

/** Side-by-side preview: trying another result first takes back the previous try (when nothing else changed since). */
let lastTry: { past: number } | null = null;
export async function tryRecipe(recipe: EffectRecipe) {
  if (lastTry && S().past.length === lastTry.past) S().undo();
  lastTry = null;
  const r = recipe.category === 'modelo' && recipe.model ? await applyCaptionModel(recipe.model, { keywordAI: false }) : await runRecipe(recipe);
  lastTry = { past: S().past.length };
  return r;
}
/** Takes back the last try (if it is still the last change). */
export function undoTry() {
  if (lastTry && S().past.length === lastTry.past) S().undo();
  lastTry = null;
}
/** Keeps the last try (the next try no longer removes it). */
export const keepTry = () => {
  lastTry = null;
};
