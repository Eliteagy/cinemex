// Keyboard shortcuts: one list of actions, each with its keys. The keys are the user's to change
// (Atalhos, in the bottom bar) and are kept on this computer; an action with no saved keys uses its
// defaults. A combination is written "mod+shift+z": mod is Ctrl (Windows) or ⌘ (Mac).
import { create } from 'zustand';
import { useEditor } from './store';
import type { Page } from './store';
import { exportVideo, importDialog, openProject, saveProject } from './actions';
import { openNodePicker } from './components/Fusion';
import type { EditMode } from './lib/edit.js';
import { end } from './lib/project';

type S = ReturnType<typeof useEditor.getState>;
export interface KeyAction {
  id: string;
  label: string;
  group: 'Projeto' | 'Reprodução' | 'Timeline' | 'Edição' | 'Vista' | 'Fusion';
  keys: string[];
  /** Only on these pages (the same key can do something else on another page). */
  pages?: Page[];
  run(s: S): void;
}

const PAGE_IDS: Page[] = ['media', 'edit', 'fusion', 'color', 'captions', 'deliver'];
const PAGE_NAMES: Record<Page, string> = { media: 'Média', edit: 'Editar', fusion: 'Fusion', color: 'Cor', captions: 'Legendas', deliver: 'Entregar' };
const fps = (s: S) => s.project.canvas.fps || 30;
const findFlag = (s: S) => s.project.tracks.flatMap((t) => t.clips).find((c) => c.id === s.selected)?.flag;
/** Edits from the Média panel: the error (no source, locked track...) goes to the status line. */
function tryEdit(s: S, mode: EditMode) {
  try {
    s.editToTimeline(mode);
  } catch (e) {
    s.setStatus((e as Error).message);
  }
}
/** X: In and Out around the selected clip (or the clip under the playhead on the first video track). */
function markClip(s: S) {
  const all = s.project.tracks.flatMap((t) => (t.locked ? [] : t.clips.map((c) => ({ c, t }))));
  const f = all.find((x) => x.c.id === s.selected) ?? all.find((x) => x.t.kind === 'video' && s.playhead >= x.c.start && s.playhead < end(x.c));
  if (!f) return;
  s.setMark('in', f.c.start);
  s.setMark('out', end(f.c));
}

/** Actions are tried in this order: a page-specific one comes before a general one with the same keys. */
export const ACTIONS: KeyAction[] = [
  { id: 'fusion.picker', label: 'Procurar nó', group: 'Fusion', keys: ['shift+space'], pages: ['fusion'], run: () => openNodePicker() },
  { id: 'undo', label: 'Desfazer', group: 'Projeto', keys: ['mod+z'], run: (s) => s.undo() },
  { id: 'redo', label: 'Refazer', group: 'Projeto', keys: ['mod+shift+z', 'mod+y'], run: (s) => s.redo() },
  { id: 'save', label: 'Guardar projeto', group: 'Projeto', keys: ['mod+s'], run: () => void saveProject() },
  { id: 'open', label: 'Abrir projeto', group: 'Projeto', keys: ['mod+o'], run: () => void openProject() },
  { id: 'import', label: 'Importar ficheiros', group: 'Projeto', keys: ['mod+i'], run: () => void importDialog() },
  { id: 'export', label: 'Exportar vídeo', group: 'Projeto', keys: ['mod+e'], run: () => void exportVideo().catch(() => {}) },
  { id: 'play', label: 'Reproduzir / parar', group: 'Reprodução', keys: ['space', 'shift+space'], run: (s) => s.setPlaying(!s.playing) },
  { id: 'start', label: 'Ir para o início', group: 'Reprodução', keys: ['home'], run: (s) => s.seek(0) },
  { id: 'end', label: 'Ir para o fim', group: 'Reprodução', keys: ['end'], run: (s) => s.seek(1e9) },
  { id: 'prevFrame', label: 'Frame anterior', group: 'Reprodução', keys: ['arrowleft'], run: (s) => s.seek(s.playhead - 1 / fps(s)) },
  { id: 'nextFrame', label: 'Frame seguinte', group: 'Reprodução', keys: ['arrowright'], run: (s) => s.seek(s.playhead + 1 / fps(s)) },
  { id: 'prevSecond', label: 'Recuar 1 segundo', group: 'Reprodução', keys: ['shift+arrowleft'], run: (s) => s.seek(s.playhead - 1) },
  { id: 'nextSecond', label: 'Avançar 1 segundo', group: 'Reprodução', keys: ['shift+arrowright'], run: (s) => s.seek(s.playhead + 1) },
  { id: 'split', label: 'Cortar na cabeça de leitura', group: 'Timeline', keys: ['s', 'c'], run: (s) => void s.splitAt(s.playhead, s.selected) },
  { id: 'delete', label: 'Apagar o clip', group: 'Timeline', keys: ['delete', 'backspace'], run: (s) => s.selected && s.deleteClip(s.selected, false) },
  { id: 'rippleDelete', label: 'Apagar e fechar o espaço (com In e Out: apaga esse troço)', group: 'Timeline', keys: ['shift+delete', 'shift+backspace'], run: (s) => (s.markIn !== null && s.markOut !== null ? void s.rippleDeleteMarked() : s.selected && s.deleteClip(s.selected, true)) },
  { id: 'addText', label: 'Acrescentar texto', group: 'Timeline', keys: ['mod+t'], run: (s) => void s.addText('Texto', s.playhead, 3, 'title') },
  { id: 'tool.select', label: 'Ferramenta Seleção', group: 'Edição', keys: ['a'], run: (s) => s.setTool('select') },
  { id: 'tool.trim', label: 'Ferramenta Trim (ripple, roll, slip, slide)', group: 'Edição', keys: ['t'], run: (s) => s.setTool('trim') },
  { id: 'tool.blade', label: 'Ferramenta Blade (cortar com clique)', group: 'Edição', keys: ['b'], run: (s) => s.setTool('blade') },
  { id: 'bladePlayhead', label: 'Cortar todas as pistas na cabeça de leitura', group: 'Edição', keys: ['mod+b'], run: (s) => void s.splitAt(s.playhead, null) },
  { id: 'markIn', label: 'Marcar In', group: 'Edição', keys: ['i'], run: (s) => s.setMark('in', s.playhead) },
  { id: 'markOut', label: 'Marcar Out', group: 'Edição', keys: ['o'], run: (s) => s.setMark('out', s.playhead) },
  { id: 'clearIn', label: 'Limpar In', group: 'Edição', keys: ['alt+i'], run: (s) => s.setMark('in', null) },
  { id: 'clearOut', label: 'Limpar Out', group: 'Edição', keys: ['alt+o'], run: (s) => s.setMark('out', null) },
  { id: 'clearMarks', label: 'Limpar In e Out', group: 'Edição', keys: ['alt+x'], run: (s) => (s.setMark('in', null), s.setMark('out', null)) },
  { id: 'markClip', label: 'Marcar In e Out à volta do clip', group: 'Edição', keys: ['x'], run: (s) => markClip(s) },
  { id: 'edit.insert', label: 'Insert (empurra o resto)', group: 'Edição', keys: ['f9'], run: (s) => tryEdit(s, 'insert') },
  { id: 'edit.overwrite', label: 'Overwrite (por cima)', group: 'Edição', keys: ['f10'], run: (s) => tryEdit(s, 'overwrite') },
  { id: 'edit.replace', label: 'Replace (troca o clip)', group: 'Edição', keys: ['f11'], run: (s) => tryEdit(s, 'replace') },
  { id: 'edit.fit', label: 'Fit to fill (encaixa entre In e Out)', group: 'Edição', keys: ['shift+f11'], run: (s) => tryEdit(s, 'fit') },
  { id: 'edit.top', label: 'Place on top (pista de cima)', group: 'Edição', keys: ['f12'], run: (s) => tryEdit(s, 'top') },
  { id: 'edit.append', label: 'Append (no fim)', group: 'Edição', keys: ['shift+f12'], run: (s) => tryEdit(s, 'append') },
  { id: 'flag', label: 'Pôr / tirar flag no clip', group: 'Edição', keys: ['g'], run: (s) => s.selected && s.setFlag(s.selected, findFlag(s) ? null : '#f2c14e') },
  { id: 'shuttle.back', label: 'J: para trás (mais vezes = mais rápido)', group: 'Reprodução', keys: ['j'], run: (s) => s.setShuttle(s.shuttle >= 0 ? -1 : s.shuttle * 2) },
  { id: 'shuttle.stop', label: 'K: parar', group: 'Reprodução', keys: ['k'], run: (s) => s.setShuttle(0) },
  { id: 'shuttle.fwd', label: 'L: para a frente (mais vezes = mais rápido)', group: 'Reprodução', keys: ['l'], run: (s) => s.setShuttle(s.shuttle <= 0 ? 1 : s.shuttle * 2) },
  { id: 'marker', label: 'Acrescentar marcador', group: 'Timeline', keys: ['m'], run: (s) => void s.addMarker(s.playhead) },
  { id: 'deselect', label: 'Tirar a seleção', group: 'Timeline', keys: ['escape'], run: (s) => s.select(null) },
  { id: 'snap', label: 'Ligar / desligar o íman', group: 'Timeline', keys: ['n'], run: (s) => s.setSnap(!s.snap) },
  { id: 'linked', label: 'Ligar / desligar imagem e som', group: 'Timeline', keys: ['mod+shift+l'], run: (s) => s.setLinked(!s.linked) },
  { id: 'zoomIn', label: 'Aproximar a timeline', group: 'Vista', keys: ['+', 'shift++', '=', 'shift+='], run: (s) => s.setZoom(s.zoom * 1.4) },
  { id: 'zoomOut', label: 'Afastar a timeline', group: 'Vista', keys: ['-'], run: (s) => s.setZoom(s.zoom / 1.4) },
  ...PAGE_IDS.map((p, i): KeyAction => ({ id: `page.${p}`, label: `Página ${PAGE_NAMES[p]}`, group: 'Vista', keys: [`shift+${i + 1}`], run: (s) => s.setPage(p) })),
  { id: 'shortcuts', label: 'Abrir os atalhos de teclado', group: 'Vista', keys: ['mod+alt+k'], run: () => useKeys.getState().setOpen(true) },
];

const STORE = 'cinemex.keys.v1';
function load(): Record<string, string[]> {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? '{}');
    return v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k, x]) => ACTIONS.some((a) => a.id === k) && Array.isArray(x) && x.every((y) => typeof y === 'string'))) as Record<string, string[]> : {};
  } catch {
    return {};
  }
}
function save(custom: Record<string, string[]>) {
  try {
    localStorage.setItem(STORE, JSON.stringify(custom));
  } catch {
    /* storage not available: the keys last until the app closes */
  }
}

export const useKeys = create<{
  /** Only what the user changed: action id -> its keys (an empty list = no key). */
  custom: Record<string, string[]>;
  open: boolean;
  setOpen(v: boolean): void;
  /** Gives the combination to this action only: any other action that had it loses it. */
  assign(id: string, combo: string): void;
  clear(id: string): void;
  reset(id?: string): void;
}>((set, get) => ({
  custom: load(),
  open: false,
  setOpen: (open) => set({ open }),
  assign(id, combo) {
    const custom = { ...get().custom };
    const mine = ACTIONS.find((a) => a.id === id);
    for (const a of ACTIONS) {
      if (a.id === id) continue;
      // The same keys may stay on an action of another page (Shift+Espaço: nós no Fusion, reproduzir no resto).
      const apart = a.pages && mine?.pages ? !a.pages.some((p) => mine.pages!.includes(p)) : Boolean(a.pages) !== Boolean(mine?.pages);
      if (!apart && keysOf(a, custom).includes(combo)) custom[a.id] = keysOf(a, custom).filter((k) => k !== combo);
    }
    custom[id] = [combo];
    save(custom);
    set({ custom });
  },
  clear(id) {
    const custom = { ...get().custom, [id]: [] };
    save(custom);
    set({ custom });
  },
  reset(id) {
    const custom = id ? { ...get().custom } : {};
    if (id) delete custom[id];
    save(custom);
    set({ custom });
  },
}));

export const keysOf = (a: KeyAction, custom = useKeys.getState().custom) => custom[a.id] ?? a.keys;

/** The combination of a key press ("mod+shift+z"), or '' for a modifier on its own. */
export function comboOf(e: KeyboardEvent): string {
  let k = /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key === ' ' ? 'space' : e.key.toLowerCase();
  if (k === 'control' || k === 'meta' || k === 'shift' || k === 'alt' || k === 'dead' || k === 'capslock') return '';
  if (k === 'spacebar') k = 'space';
  return [e.ctrlKey || e.metaKey ? 'mod' : '', e.altKey ? 'alt' : '', e.shiftKey ? 'shift' : '', k].filter(Boolean).join('+');
}

const MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);
const NAMES: Record<string, string> = { mod: MAC ? '⌘' : 'Ctrl', alt: MAC ? '⌥' : 'Alt', shift: MAC ? '⇧' : 'Shift', space: 'Espaço', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓', escape: 'Esc', delete: 'Delete', backspace: '⌫', enter: 'Enter', home: 'Home', end: 'End', tab: 'Tab' };
/** A combination as shown to the user: "⌘ ⇧ Z", "Ctrl + Shift + Z". */
export function comboLabel(combo: string) {
  // The key itself can be "+": split on the + between parts only.
  const parts = combo.endsWith('++') ? [...combo.slice(0, -2).split('+'), '+'] : combo === '+' ? ['+'] : combo.split('+');
  return parts.map((p) => NAMES[p] ?? (p.length === 1 ? p.toUpperCase() : p[0]!.toUpperCase() + p.slice(1))).join(MAC ? ' ' : ' + ');
}

/** Runs the action of a key press. Returns true when one ran. */
export function handleKey(e: KeyboardEvent): boolean {
  const combo = comboOf(e);
  if (!combo) return false;
  const s = useEditor.getState();
  const custom = useKeys.getState().custom;
  const a = ACTIONS.find((x) => (!x.pages || x.pages.includes(s.page)) && keysOf(x, custom).includes(combo));
  if (!a) return false;
  a.run(s);
  return true;
}
