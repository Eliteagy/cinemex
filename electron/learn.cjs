// What the app learned from the Gui's own corrections (userData/learned.json):
//   words     caption word fixes he made by hand ("tios" -> "planos"): applied before the AI review
//             and sent to the AI as examples
//   keywords  big words he chose himself in a caption block: sent to the AI keyword pick as taste
// Validated on every read; the Gui can list and delete rules ("O que a app aprendeu").
const fs = require('node:fs');
const path = require('node:path');

const MAX = { words: 300, keywords: 200 };
const txt = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function clean(raw) {
  const words = [];
  const seen = new Set();
  for (const r of Array.isArray(raw?.words) ? raw.words : []) {
    const from = txt(r?.from, 80);
    const to = txt(r?.to, 80);
    if (!from || !to || from.toLowerCase() === to.toLowerCase() || seen.has(from.toLowerCase())) continue;
    seen.add(from.toLowerCase());
    words.push({ from, to, n: Math.max(1, Math.min(9999, Math.round(Number(r?.n) || 1))) });
  }
  const keywords = [];
  for (const r of Array.isArray(raw?.keywords) ? raw.keywords : []) {
    const block = txt(r?.block, 120);
    const word = txt(r?.word, 40);
    if (block && word && block.toLowerCase().includes(word.toLowerCase())) keywords.push({ block, word });
  }
  return { version: 1, words: words.slice(-MAX.words), keywords: keywords.slice(-MAX.keywords) };
}

function createLearnStore(file) {
  const read = () => {
    try {
      return clean(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return clean({});
    }
  };
  const write = (d) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(clean(d), null, 1), 'utf8');
    fs.renameSync(`${file}.tmp`, file);
  };
  return {
    get: read,
    /** A word fix the Gui made by hand (repeats count up). */
    addWord(from, to) {
      const d = read();
      const f = txt(from, 80);
      const t = txt(to, 80);
      if (!f || !t || f.toLowerCase() === t.toLowerCase()) return d;
      const old = d.words.find((w) => w.from.toLowerCase() === f.toLowerCase());
      if (old) {
        old.to = t;
        old.n += 1;
      } else d.words.push({ from: f, to: t, n: 1 });
      write(d);
      return read();
    },
    /** A big word the Gui chose in a block. */
    addKeyword(block, word) {
      const d = read();
      d.keywords = d.keywords.filter((k) => k.block.toLowerCase() !== txt(block, 120).toLowerCase());
      d.keywords.push({ block, word });
      write(d);
      return read();
    },
    remove(kind, index) {
      const d = read();
      if (!['words', 'keywords'].includes(kind) || !(index >= 0 && index < d[kind].length)) return d;
      d[kind].splice(index, 1);
      write(d);
      return read();
    },
    clear() {
      write({});
      return read();
    },
  };
}

module.exports = { createLearnStore };
