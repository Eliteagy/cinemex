// "Aprender com as correções": caption fixes the Gui makes by hand go to the learned store
// (electron/learn.cjs), so the next AI review applies the same fix and the AI big-word pick follows
// his taste. Called when a caption field loses focus (not on every key) and when he picks a word.

import { wordFixes, words } from './lib/wordfix.js';

/** Learn from a caption the Gui finished editing (text before focus -> text at blur). */
export function learnFromEdit(before: string | undefined, after: string | undefined) {
  for (const f of wordFixes(before, after)) void window.ec.learnWord(f.from, f.to).catch(() => {});
}

/** Learn the big word the Gui picked in a caption. */
export function learnKeyword(text: string | undefined, index: number | undefined) {
  if (!Number.isInteger(index) || index! < 0) return;
  const w = words(text)[index!];
  if (w) void window.ec.learnKeyword(text ?? '', w).catch(() => {});
}
