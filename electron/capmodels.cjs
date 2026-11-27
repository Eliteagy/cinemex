// Saved caption models ("Guardar modelo"), shared by every project: userData/caption-models.json.
// Validated on every read (src/lib/capmodels.js validateModelStore), like the caption styles.
const fs = require('node:fs');
const path = require('node:path');
const cm = require('../src/lib/capmodels.js');

function createModelStore(file) {
  const read = () => {
    try {
      return cm.validateModelStore(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return { version: 1, models: {} };
    }
  };
  const write = (data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  };
  return {
    /** Built-in models first, then the saved ones: [{ id, builtin, ...model }]. */
    list() {
      const saved = read().models;
      return [...Object.entries(cm.BUILTIN_MODELS).map(([id, m]) => ({ id, builtin: true, ...m })), ...Object.entries(saved).map(([id, m]) => ({ id, builtin: false, ...m }))];
    },
    /** Save (id of a saved model: replace it; else a new id from the name). Returns { id, model }. */
    save(id, raw) {
      const model = cm.validateModel(raw);
      if (!model) throw new Error('Modelo inválido: escolhe o tipo (atras-frente, gigante ou duas-linhas)');
      const data = read();
      if (id && !cm.isModelId(id)) id = null; // a built-in is never overwritten: saved as a new model
      const key = id || cm.modelIdFor(model.label, new Set(Object.keys(data.models)));
      if (!data.models[key] && Object.keys(data.models).length >= 100) throw new Error('Limite de 100 modelos guardados');
      data.models[key] = model;
      write(data);
      return { id: key, model };
    },
    delete(id) {
      const data = read();
      if (!cm.isModelId(id) || !data.models[id]) return false;
      delete data.models[id];
      write(data);
      return true;
    },
    /** A model from an id (built-in or saved) or from a model object. Throws when unknown. */
    resolve(ref) {
      if (ref && typeof ref === 'object') {
        const m = cm.validateModel(ref);
        if (!m) throw new Error('Modelo de legendas inválido');
        return m;
      }
      const id = String(ref || '');
      const m = cm.BUILTIN_MODELS[id] || read().models[id];
      if (!m) throw new Error(`Modelo de legendas desconhecido: ${id}`);
      return cm.validateModel(m);
    },
  };
}

module.exports = { createModelStore };
