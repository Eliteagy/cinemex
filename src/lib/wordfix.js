// Word fixes between an old and a new caption text (src/learn.ts sends them to electron/learn.cjs).
export const words = (t) => String(t ?? '').split(/\s+/).filter(Boolean);
const bare = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '');

/** Word fixes between an old and a new caption text (same number of words only). */
export function wordFixes(before, after) {
  const a = words(before);
  const b = words(after);
  if (!a.length || a.length !== b.length) return [];
  const out = [];
  for (let i = 0; i < a.length; i++) {
    const x = bare(a[i]);
    const y = bare(b[i]);
    if (x && y && x !== y) out.push({ from: x, to: b[i].replace(/[.,!?;:…"»”]+$/, '') });
  }
  return out.length <= 2 ? out : [];
}

