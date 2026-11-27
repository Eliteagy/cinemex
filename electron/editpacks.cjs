// Saved edit packs ("Guardar pacote"), shared by every project: userData/edit-packs.json.
// Validated on every read (src/lib/editpacks.js); built-in packs are never overwritten.
const fs = require('node:fs');
const path = require('node:path');
const ep = require('../src/lib/editpacks.js');

function createPackStore(file) {
  const read = () => {
    try {
      return ep.validatePackStore(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return { version: 1, packs: {} };
    }
  };
  const write = (d) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(d, null, 1), 'utf8');
    fs.renameSync(`${file}.tmp`, file);
  };
  return {
    list: () => [...Object.entries(ep.BUILTIN_PACKS).map(([id, p]) => ({ id, builtin: true, ...p })), ...Object.entries(read().packs).map(([id, p]) => ({ id, builtin: false, ...p }))],
    save(id, raw) {
      const pack = ep.validatePack(raw);
      if (!pack) throw new Error('Pacote inválido: escolhe um modelo de legendas');
      const d = read();
      if (id && !ep.isPackId(id)) id = null;
      const key = id || ep.packIdFor(pack.label, new Set(Object.keys(d.packs)));
      if (!d.packs[key] && Object.keys(d.packs).length >= 100) throw new Error('Limite de 100 pacotes');
      d.packs[key] = pack;
      write(d);
      return { id: key, pack };
    },
    delete(id) {
      const d = read();
      if (!d.packs[id]) return false;
      delete d.packs[id];
      write(d);
      return true;
    },
    resolve(ref) {
      if (ref && typeof ref === 'object') {
        const p = ep.validatePack(ref);
        if (!p) throw new Error('Pacote inválido');
        return p;
      }
      const p = ep.BUILTIN_PACKS[String(ref)] || read().packs[String(ref)];
      if (!p) throw new Error(`Pacote desconhecido: ${ref}`);
      return ep.validatePack(p);
    },
  };
}

module.exports = { createPackStore };
