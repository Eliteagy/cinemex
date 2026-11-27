// "Aplicar pacote" on the timeline: caption model (with the AI big word), effects from the library,
// then the edited-short touches (punch, SFX, music, B-roll, progress bar, CTA). One undo step.
import { useEditor } from './store';
import { applyCaptionModel, polishEdit } from './actions';
import { asOneStep } from './aiTools';
import { runRecipe } from './effectRecipes';
import type { EditPack } from './types';

const S = () => useEditor.getState();

export async function applyEditPack(ref: string | EditPack, opts: { clipId?: string } = {}) {
  const pack = typeof ref === 'string' ? (await window.ec.listEditPacks()).find((p) => p.id === ref) : ref;
  if (!pack) throw new Error(`Pacote desconhecido: ${String(ref)}`);
  return asOneStep(async () => {
    S().setStatus(`Pacote «${pack.label}»: legendas…`, true);
    const caps = await applyCaptionModel(pack.captionModel, { clipId: opts.clipId, keywordAI: pack.keywordAI });
    const effects: string[] = [];
    if (pack.effects.length) {
      const lib = await window.ec.listEffects();
      for (const id of pack.effects) {
        const fx = lib.find((e) => e.id === id);
        if (!fx) continue;
        S().setStatus(`Pacote «${pack.label}»: efeito ${fx.name}…`, true);
        await runRecipe(fx, { clipId: opts.clipId });
        effects.push(fx.name);
      }
    }
    S().setStatus(`Pacote «${pack.label}»: edição…`, true);
    const edit = await polishEdit({ punch: pack.punch > 0 ? pack.punch : false, sfx: pack.sfx, progress: pack.progress, cta: pack.cta || undefined, music: pack.music === 'off' ? false : pack.music, broll: pack.broll, clipId: opts.clipId });
    S().setStatus(`Pacote «${pack.label}» aplicado (Ctrl+Z desfaz tudo)`);
    return { pack: pack.label, captions: caps, effects, edit };
  });
}
