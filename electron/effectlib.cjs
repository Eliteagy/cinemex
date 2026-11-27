// Effects library ("Biblioteca de efeitos"): recipes the Gui kept from the generator (Claude, Gemini,
// ChatGPT), in userData/effects-library.json. Every read goes through validateRecipe, so a
// hand-edited file can only ever hold allow-listed editor tools.
const fs = require('node:fs');
const path = require('node:path');
const { validateRecipe, CATEGORIES, PROVIDERS } = require('./effectgen.cjs');

const ID = /^e-[a-z0-9-]{1,48}$/;

function slug(s) {
  return (
    String(s || 'efeito')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'efeito'
  );
}

function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object' || !CATEGORIES[raw.category]) return null;
  const r = validateRecipe(raw, raw.category);
  if (!r) return null;
  return {
    ...r,
    provider: PROVIDERS.includes(raw.provider) ? raw.provider : null,
    prompt: String(raw.prompt ?? '').slice(0, 600),
    created: typeof raw.created === 'string' && !Number.isNaN(Date.parse(raw.created)) ? raw.created : new Date().toISOString(),
  };
}

function createEffectLibrary(file) {
  const read = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const effects = {};
      for (const [id, e] of Object.entries(raw?.effects || {})) {
        const c = ID.test(id) && cleanEntry(e);
        if (c) effects[id] = c;
      }
      return { version: 1, effects };
    } catch {
      return { version: 1, effects: {} };
    }
  };
  const write = (data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(`${file}.tmp`, file);
  };
  return {
    list: () => Object.entries(read().effects).map(([id, e]) => ({ id, ...e })).sort((a, b) => b.created.localeCompare(a.created)),
    save(raw, name) {
      const e = cleanEntry({ ...raw, ...(name ? { name } : {}) });
      if (!e) throw new Error('Efeito inválido');
      const data = read();
      if (Object.keys(data.effects).length >= 500) throw new Error('Limite de 500 efeitos na biblioteca');
      let id = `e-${slug(e.name)}`;
      for (let n = 2; data.effects[id]; n++) id = `e-${slug(e.name)}-${n}`;
      data.effects[id] = e;
      write(data);
      return { id, ...e };
    },
    rename(id, name) {
      const data = read();
      if (!data.effects[id]) return false;
      data.effects[id].name = String(name || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60) || data.effects[id].name;
      write(data);
      return true;
    },
    delete(id) {
      const data = read();
      if (!data.effects[id]) return false;
      delete data.effects[id];
      write(data);
      return true;
    },
    get: (id) => {
      const e = read().effects[id];
      return e ? { id, ...e } : null;
    },
  };
}

module.exports = { createEffectLibrary };
