// Edit packs ("Pacotes de edição"): one click = a whole edit. A pack names a caption model
// (src/lib/capmodels.js), whether the AI picks the big word, the edited-short touches
// (src/lib/polish.js: punch, SFX, progress bar, CTA), music mood, B-roll and effects from the
// effects library. Used by the Shorts panel (every short of a batch), by "Aplicar pacote" on the
// timeline and by the MCP tools. Saved packs: userData/edit-packs.json (electron/editpacks.cjs).

export const MUSIC = ['off', 'auto', 'calma', 'media', 'forte'];

export const BUILTIN_PACKS = {
  vitor: { label: 'Vitor (imobiliário)', captionModel: 'vitor', keywordAI: true, punch: 0.1, sfx: true, music: 'calma', broll: true, progress: false, cta: 'Fala comigo', effects: [] },
  palestra: { label: 'Palestra', captionModel: 'duas-linhas', keywordAI: true, punch: 0.15, sfx: true, music: 'forte', broll: false, progress: true, cta: 'Segue para mais', effects: [] },
  imovel: { label: 'Imóvel', captionModel: 'atras-cor', keywordAI: true, punch: 0.08, sfx: false, music: 'calma', broll: true, progress: false, cta: 'Marca a tua visita', effects: [] },
};

const txt = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const ID = /^(u-[a-z0-9][a-z0-9-]{0,40}|[a-z][a-z0-9-]{0,40})$/;

/** A clean pack (or null without a caption model). Unknown fields dropped, numbers clamped. */
export function validatePack(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const captionModel = typeof raw.captionModel === 'string' && ID.test(raw.captionModel) ? raw.captionModel : null;
  if (!captionModel) return null;
  const punch = typeof raw.punch === 'number' && Number.isFinite(raw.punch) ? Math.max(0, Math.min(0.3, Math.round(raw.punch * 100) / 100)) : raw.punch === true ? 0.12 : 0;
  return {
    label: txt(raw.label, 60) || 'O meu pacote',
    captionModel,
    keywordAI: raw.keywordAI !== false,
    punch,
    sfx: raw.sfx === true,
    music: MUSIC.includes(raw.music) ? raw.music : 'off',
    broll: raw.broll === true,
    progress: raw.progress === true,
    cta: txt(raw.cta, 80),
    effects: Array.isArray(raw.effects) ? [...new Set(raw.effects.filter((e) => typeof e === 'string' && /^e-[a-z0-9-]{1,48}$/.test(e)))].slice(0, 5) : [],
  };
}

export const isPackId = (id) => typeof id === 'string' && /^p-[a-z0-9][a-z0-9-]{0,40}$/.test(id);

export function validatePackStore(raw) {
  const packs = {};
  for (const [id, p] of Object.entries(raw?.packs && typeof raw.packs === 'object' ? raw.packs : {})) {
    if (!isPackId(id)) continue;
    const v = validatePack(p);
    if (v) packs[id] = v;
  }
  return { version: 1, packs };
}

export function packIdFor(label, taken = new Set()) {
  const base =
    'p-' +
    (String(label || 'pacote')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'pacote');
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

/** The shorts builder options of a pack (electron/shorts.cjs). */
export function packShortOptions(pack) {
  const p = validatePack(pack);
  if (!p) throw new Error('Pacote inválido');
  return { model: p.captionModel, keywordAI: p.keywordAI, punch: p.punch > 0 ? p.punch : false, sfx: p.sfx, music: p.music === 'off' ? false : p.music, broll: p.broll, progress: p.progress, cta: p.cta || undefined };
}
