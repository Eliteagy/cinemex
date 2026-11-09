// Saved caption styles ("Novo estilo"), shared by every project: userData/caption-styles.json.
// The file is validated on every load (src/lib/capstyle.js validateStore), so a hand-edited or
// damaged file can never inject anything into the ASS export.
const fs = require('node:fs');
const path = require('node:path');
const { validateStore, validateStyle, isStyleId, styleIdFor } = require('../src/lib/capstyle.js');

function createStyleStore(file) {
  const read = () => {
    try {
      return validateStore(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return { version: 1, styles: {} };
    }
  };
  const write = (data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  };
  return {
    list: () => read().styles,
    /** Save (id given: replace that style; null: new id from the name). Returns { id, style }. */
    save(id, raw) {
      const style = validateStyle(raw);
      if (!style) throw new Error('Estilo inválido: precisa de fonte, tamanho e cor (#RRGGBB)');
      const data = read();
      if (id !== null && id !== undefined && !isStyleId(id)) throw new Error('Id de estilo inválido');
      const key = id || styleIdFor(style.label, new Set(Object.keys(data.styles)));
      if (!data.styles[key] && Object.keys(data.styles).length >= 200) throw new Error('Limite de 200 estilos guardados');
      data.styles[key] = style;
      write(data);
      return { id: key, style };
    },
    delete(id) {
      const data = read();
      if (!data.styles[id]) return false;
      delete data.styles[id];
      write(data);
      return true;
    },
  };
}

module.exports = { createStyleStore };
