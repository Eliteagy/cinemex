// "Fusion" page (node compositing, like DaVinci's): node library on the left, the viewer in the
// middle, the selected node's settings on the right and the node editor at the bottom.
// The graph belongs to the clip being edited (selected video clip, or the one under the playhead).
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { useEditor } from '../store';
import { dur, findClip } from '../lib/project';
import { NODES, inputOf, param, paramAt } from '../engine/fusion';
import { EASES, EASE_LABELS } from '../lib/anim.js';
import type { Ease } from '../types';
import type { Clip, FNode, FNodeType } from '../types';
import { useGradeTarget } from './Color';
import { Icon } from './Icon';
import { genLabel } from '../lib/generators.js';

const useUi = create<{ node: string | null; pending: string | null; picker: boolean; set(p: Partial<{ node: string | null; pending: string | null; picker: boolean }>): void }>((set) => ({
  node: null,
  pending: null,
  picker: false,
  set: (p) => set(p),
}));

/** Opens the node search of the Fusion page (Shift+Espaço, as Resolve's Select Tool). */
export const openNodePicker = () => useUi.getState().set({ picker: true });

const GROUPS: { k: 'gerar' | 'compor' | 'mascara' | 'efeitos'; label: string }[] = [
  { k: 'gerar', label: 'Gerar' },
  { k: 'compor', label: 'Compor' },
  { k: 'mascara', label: 'Máscaras' },
  { k: 'efeitos', label: 'Efeitos' },
];
const W = 150;
const HEAD = 26;
const ROW = 20;

const safe = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    useEditor.getState().setStatus((e as Error).message);
  }
};

export function FusionLibrary() {
  const clip = useGradeTarget('fusion');
  const node = useUi((s) => s.node);
  const add = (type: FNodeType) =>
    safe(() => {
      if (!clip) return;
      const id = useEditor.getState().addNode(clip.id, type, node);
      useUi.getState().set({ node: id });
    });
  return (
    <aside className="panel" aria-label="Nós">
      <div className="ph">Nós</div>
      <div className="panel-body">
        {!clip ? (
          <p className="panel-sub">Escolhe um clip de vídeo ou uma Composição Fusion na timeline (página Editar) ou põe a cabeça de leitura sobre ele.</p>
        ) : (
          <>
            <p className="panel-sub">
              Um clique junta o nó a seguir ao nó escolhido. Shift+Espaço procura um nó pelo nome. Liga saídas (à direita) a entradas (à esquerda) no editor em baixo. Delete apaga o nó.
            </p>
            {GROUPS.map((g) => (
              <div className="field" key={g.k}>
                <label>{g.label}</label>
                <div className="node-lib">
                  {(Object.entries(NODES) as [FNodeType, (typeof NODES)[FNodeType]][])
                    .filter(([, n]) => n.group === g.k)
                    .map(([k, n]) => (
                      <button key={k} className={`btn sm node-chip g-${g.k}`} onClick={() => add(k)}>
                        <Icon name="plus" /> {n.label}
                      </button>
                    ))}
                </div>
              </div>
            ))}
            {clip.fusion && (
              <button className="btn sm" onClick={() => (useEditor.getState().resetFusion(clip.id), useUi.getState().set({ node: null }))}>
                Apagar o Fusion deste clip
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

export function FusionInspector() {
  const clip = useGradeTarget('fusion');
  const nodeId = useUi((s) => s.node);
  const media = useEditor((s) => s.project.media);
  const n = clip?.fusion?.nodes.find((x) => x.id === nodeId);
  const set = (k: string, v: number | string | boolean) => clip && n && safe(() => useEditor.getState().setNodeParams(clip.id, n.id, { [k]: v }));
  // Keyframes are placed at the playhead, in seconds from the start of the clip.
  const playhead = useEditor((s) => s.playhead);
  const local = clip ? Math.max(0, Math.min(dur(clip), playhead - clip.start)) : 0;
  return (
    <aside className="panel" aria-label="Definições do nó">
      <div className="ph">{n ? NODES[n.type].label : 'Nó'}</div>
      <div className="panel-body">
        {!n ? (
          <p className="panel-sub">Clica num nó no editor para ver as definições.</p>
        ) : !Object.keys(NODES[n.type].params).length ? (
          <p className="panel-sub">{n.type === 'mediaIn' ? 'A imagem do clip (com cor, zoom e enquadramento).' : 'O que chega aqui é o que aparece no vídeo.'}</p>
        ) : (
          Object.entries(NODES[n.type].params).map(([k, spec]) => {
            // Settings that only make sense for some choices (the second colour of a gradient…).
            if (spec.when && !Object.entries(spec.when).every(([dep, values]) => values.includes(String(param(n, dep))))) return null;
            const v = param(n, k);
            if (spec.type === 'number') {
              // A setting with keyframes shows its value at the playhead, and a change there is a keyframe.
              const keys = (spec.key && clip && n.k?.[k]) || [];
              const animated = keys.length > 0;
              const here = keys.some((x) => Math.abs(x.t - local) < 0.02);
              const shown = animated ? Number(paramAt(n, k, local)) : Number(v);
              const st = useEditor.getState;
              const change = (val: number) => (animated && clip ? safe(() => st().setNodeKey(clip.id, n.id, k, clip.start + local, val)) : set(k, val));
              return (
                <div className="field" key={k}>
                  <label className="row-label">
                    <span>{spec.label}</span>
                    <b className="val">{Math.round(shown * 100) / 100}</b>
                    {spec.key && clip && (
                      <button
                        className={`kf-btn${here ? ' on' : animated ? ' armed' : ''}`}
                        title={here ? 'Tirar o keyframe deste momento' : animated ? 'Pôr um keyframe neste momento' : 'Animar: pôr o primeiro keyframe neste momento'}
                        aria-label={`Keyframe de ${spec.label}`}
                        aria-pressed={here}
                        onClick={(e) => {
                          e.preventDefault();
                          safe(() => (here ? st().removeNodeKey(clip.id, n.id, k, clip.start + local) : st().setNodeKey(clip.id, n.id, k, clip.start + local, shown)));
                        }}
                      >
                        ◆
                      </button>
                    )}
                  </label>
                  <input className="range" type="range" min={spec.min} max={spec.max} step={spec.step} value={shown} onPointerDown={() => st().startSlide()} onDoubleClick={() => change(Number(spec.default))} onChange={(e) => change(Number(e.target.value))} />
                  {animated && clip && (
                    <div className="kf-row">
                      <span>
                        {keys.length} {keys.length === 1 ? 'keyframe' : 'keyframes'}
                      </span>
                      <select className="select" value={keys[0]!.ease ?? 'smooth'} aria-label={`Curva de ${spec.label}`} onChange={(e) => safe(() => st().setNodeKeyEase(clip.id, n.id, k, e.target.value as Ease))}>
                        {(EASES as Ease[])
                          .filter((x) => x !== 'bezier')
                          .map((x) => (
                            <option key={x} value={x}>
                              {(EASE_LABELS as Record<string, string>)[x] ?? x}
                            </option>
                          ))}
                      </select>
                      <button className="btn sm ghost" title="Tirar todos os keyframes: a definição fica fixa" onClick={() => safe(() => st().removeNodeKey(clip.id, n.id, k))}>
                        Tirar animação
                      </button>
                    </div>
                  )}
                </div>
              );
            }
            if (spec.type === 'color')
              return (
                <div className="field" key={k}>
                  <label>{spec.label}</label>
                  <label className="swatch">
                    <input type="color" value={String(v).slice(0, 7)} onPointerDown={() => useEditor.getState().startSlide()} onChange={(e) => set(k, e.target.value.toUpperCase())} />
                    <span>{String(v).toUpperCase()}</span>
                  </label>
                </div>
              );
            if (spec.type === 'bool')
              return (
                <label className="check" key={k}>
                  <input type="checkbox" checked={v === true} onChange={(e) => set(k, e.target.checked)} />
                  <span>{spec.label}</span>
                </label>
              );
            if (spec.type === 'select')
              return (
                <div className="field" key={k}>
                  <label>{spec.label}</label>
                  <select className="select" value={String(v)} onChange={(e) => set(k, e.target.value)}>
                    {Object.entries(spec.options ?? {}).map(([o, l]) => (
                      <option key={o} value={o}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
              );
            return (
              <div className="field" key={k}>
                <label>{spec.label}</label>
                <select className="select" value={String(v)} onChange={(e) => set(k, e.target.value)}>
                  <option value="">Escolher…</option>
                  {media
                    .filter((m) => m.kind !== 'audio')
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </select>
              </div>
            );
          })
        )}
        {n && n.type !== 'mediaIn' && n.type !== 'mediaOut' && clip && (
          <button className="btn sm" style={{ marginTop: 10 }} onClick={() => (useEditor.getState().removeNode(clip.id, n.id), useUi.getState().set({ node: null }))}>
            <Icon name="trash" /> Apagar nó
          </button>
        )}
      </div>
    </aside>
  );
}

const portIn = (n: FNode, i: number) => ({ x: n.x, y: n.y + HEAD + ROW * i + ROW / 2 });
const portOut = (n: FNode) => ({ x: n.x + W, y: n.y + HEAD / 2 });
const nodeH = (n: FNode) => HEAD + Math.max(1, NODES[n.type].inputs.length) * ROW + 4;

export function NodeEditor() {
  const clip = useGradeTarget('fusion');
  const sel = useUi((s) => s.node);
  const pending = useUi((s) => s.pending);
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null);
  const area = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      const { node } = useUi.getState();
      if (e.key === 'Escape') useUi.getState().set({ pending: null });
      if ((e.key === 'Delete' || e.key === 'Backspace') && node && clip) {
        e.stopImmediatePropagation();
        e.preventDefault();
        useEditor.getState().removeNode(clip.id, node);
        useUi.getState().set({ node: null });
      }
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [clip]);

  if (!clip) return <section className="node-editor empty-ne">Sem clip para compor: escolhe um clip de vídeo ou arrasta uma Composição Fusion dos Efeitos para a timeline.</section>;
  const f = clip.fusion ?? {
    nodes: [
      { id: 'in', type: 'mediaIn' as const, x: 30, y: 90, p: {} },
      { id: 'out', type: 'mediaOut' as const, x: 560, y: 90, p: {} },
    ],
    links: [{ from: 'in', to: 'out', port: 0 }],
  };
  const byId = new Map(f.nodes.map((n) => [n.id, n]));
  const local = (e: { clientX: number; clientY: number }) => {
    const r = area.current!.getBoundingClientRect();
    return { x: e.clientX - r.left + area.current!.scrollLeft, y: e.clientY - r.top + area.current!.scrollTop };
  };

  const dragNode = (e: React.PointerEvent, n: FNode) => {
    e.stopPropagation();
    useUi.getState().set({ node: n.id });
    const s = useEditor.getState();
    if (!clip.fusion) safe(() => s.linkNodes(clip.id, 'in', 'out', 0));
    s.beginGesture();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const start = { x: n.x, y: n.y };
    const move = (ev: PointerEvent) =>
      useEditor.getState().live((p) => {
        const node = findClip(p, clip.id)?.clip.fusion?.nodes.find((x) => x.id === n.id);
        if (node) {
          node.x = Math.max(0, Math.round(start.x + ev.clientX - x0));
          node.y = Math.max(0, Math.round(start.y + ev.clientY - y0));
        }
      });
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };
  const clickOut = (e: React.MouseEvent, n: FNode) => {
    e.stopPropagation();
    useUi.getState().set({ pending: pending === n.id ? null : n.id });
  };
  const clickIn = (e: React.MouseEvent, n: FNode, port: number) => {
    e.stopPropagation();
    if (pending) safe(() => useEditor.getState().linkNodes(clip.id, pending, n.id, port));
    else if (inputOf(f, n.id, port)) safe(() => useEditor.getState().unlinkPort(clip.id, n.id, port));
    useUi.getState().set({ pending: null });
  };

  const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  };

  return (
    <section className="node-editor" aria-label="Editor de nós">
      <div className="ph">
        Nós de {clipName(clip)}
        <span className="spacer" />
        <span className="panel-sub">{pending ? 'Clica numa entrada (à esquerda de um nó) para ligar. Esc cancela.' : 'Shift+Espaço: procurar nó · liga uma saída (●) a uma entrada · clicar numa entrada ligada desliga.'}</span>
      </div>
      <NodePicker clip={clip} />
      <div className="ne-area" ref={area} onPointerMove={(e) => pending && setMouse(local(e))} onPointerDown={() => useUi.getState().set({ node: null, pending: null })}>
        <svg className="ne-links" width={2400} height={900}>
          {f.links.map((l) => {
            const a = byId.get(l.from);
            const b = byId.get(l.to);
            if (!a || !b) return null;
            return <path key={`${l.from}-${l.to}-${l.port}`} d={curve(portOut(a), portIn(b, l.port))} />;
          })}
          {pending && mouse && byId.get(pending) && <path className="pending" d={curve(portOut(byId.get(pending)!), mouse)} />}
        </svg>
        {f.nodes.map((n) => {
          const spec = NODES[n.type];
          return (
            <div key={n.id} className={`fnode g-${spec.group}${sel === n.id ? ' sel' : ''}`} style={{ left: n.x, top: n.y, width: W, height: nodeH(n) }} onPointerDown={(e) => dragNode(e, n)}>
              <div className="fn-head">{spec.label}</div>
              {spec.inputs.map((name, i) => (
                <div className="fn-in" key={name} style={{ top: HEAD + ROW * i }}>
                  <button className={`port in${inputOf(f, n.id, i) ? ' on' : ''}${pending ? ' wait' : ''}`} aria-label={`Entrada ${name}`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => clickIn(e, n, i)} />
                  <span>{name}</span>
                </div>
              ))}
              {n.type !== 'mediaOut' && (
                <button className={`port out${pending === n.id ? ' on' : ''}`} style={{ top: HEAD / 2 - 6 }} aria-label="Saída" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => clickOut(e, n)} />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function clipName(c: Clip) {
  const m = useEditor.getState().project.media.find((x) => x.id === c.mediaId);
  return m?.name ?? (genLabel(c) || c.id);
}

const plain = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Node search (Shift+Espaço): type a name, Enter adds the node after the selected one. */
function NodePicker({ clip }: { clip: Clip }) {
  const open = useUi((s) => s.picker);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const all = useMemo(() => (Object.entries(NODES) as [FNodeType, (typeof NODES)[FNodeType]][]).filter(([, n]) => n.group !== 'io'), []);
  const list = useMemo(() => {
    const k = plain(q.trim());
    return k ? all.filter(([id, n]) => plain(n.label).includes(k) || plain(id).includes(k)) : all;
  }, [all, q]);
  useEffect(() => {
    if (open) {
      setQ('');
      setAt(0);
    }
  }, [open]);
  if (!open) return null;
  const close = () => useUi.getState().set({ picker: false });
  const add = (type: FNodeType | undefined) => {
    close();
    if (!type) return;
    safe(() => {
      const id = useEditor.getState().addNode(clip.id, type, useUi.getState().node);
      useUi.getState().set({ node: id });
    });
  };
  const sel = Math.min(at, Math.max(0, list.length - 1));
  return createPortal(
    <div className="np-back" onPointerDown={close}>
      <div className="np" role="dialog" aria-label="Procurar nó" onPointerDown={(e) => e.stopPropagation()}>
        <input
          className="np-input"
          autoFocus
          placeholder="Procurar nó…"
          value={q}
          aria-label="Nome do nó"
          onChange={(e) => (setQ(e.target.value), setAt(0))}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            else if (e.key === 'Enter') add(list[sel]?.[0]);
            else if (e.key === 'ArrowDown') (e.preventDefault(), setAt(Math.min(list.length - 1, sel + 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setAt(Math.max(0, sel - 1)));
            e.stopPropagation();
          }}
        />
        <div className="np-list" role="listbox">
          {list.map(([id, n], i) => (
            <button key={id} role="option" aria-selected={i === sel} className={`np-item g-${n.group}${i === sel ? ' on' : ''}`} onPointerEnter={() => setAt(i)} onClick={() => add(id)}>
              <i />
              <span>{n.label}</span>
              <small>{GROUPS.find((g) => g.k === n.group)?.label}</small>
            </button>
          ))}
          {!list.length && <p className="panel-sub">Nenhum nó com esse nome.</p>}
        </div>
        <p className="np-foot">Enter junta · ↑↓ escolhe · Esc fecha</p>
      </div>
    </div>,
    document.body,
  );
}
