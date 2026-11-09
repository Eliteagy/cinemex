// "Fusion" page (node compositing, like DaVinci's): node library on the left, the viewer in the
// middle, the selected node's settings on the right and the node editor at the bottom.
// The graph belongs to the clip being edited (selected video clip, or the one under the playhead).
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useEditor } from '../store';
import { findClip } from '../lib/project';
import { NODES, inputOf, param } from '../engine/fusion';
import type { Clip, FNode, FNodeType } from '../types';
import { useGradeTarget } from './Color';
import { Icon } from './Icon';

const useUi = create<{ node: string | null; pending: string | null; set(p: Partial<{ node: string | null; pending: string | null }>): void }>((set) => ({
  node: null,
  pending: null,
  set: (p) => set(p),
}));

const GROUPS: { k: 'gerar' | 'compor' | 'efeitos'; label: string }[] = [
  { k: 'gerar', label: 'Gerar' },
  { k: 'compor', label: 'Compor' },
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
  const clip = useGradeTarget();
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
          <p className="panel-sub">Escolhe um clip de vídeo na timeline (página Editar) ou põe a cabeça de leitura sobre ele.</p>
        ) : (
          <>
            <p className="panel-sub">
              Um clique junta o nó a seguir ao nó escolhido. Liga saídas (à direita) a entradas (à esquerda) no editor em baixo. Delete apaga o nó.
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
  const clip = useGradeTarget();
  const nodeId = useUi((s) => s.node);
  const media = useEditor((s) => s.project.media);
  const n = clip?.fusion?.nodes.find((x) => x.id === nodeId);
  const set = (k: string, v: number | string | boolean) => clip && n && safe(() => useEditor.getState().setNodeParams(clip.id, n.id, { [k]: v }));
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
            const v = param(n, k);
            if (spec.type === 'number')
              return (
                <div className="field" key={k}>
                  <label className="row-label">
                    <span>{spec.label}</span>
                    <b className="val">{Math.round(Number(v) * 100) / 100}</b>
                  </label>
                  <input className="range" type="range" min={spec.min} max={spec.max} step={spec.step} value={Number(v)} onPointerDown={() => useEditor.getState().startSlide()} onDoubleClick={() => set(k, spec.default)} onChange={(e) => set(k, Number(e.target.value))} />
                </div>
              );
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
  const clip = useGradeTarget();
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

  if (!clip) return <section className="node-editor empty-ne">Sem clip de vídeo para compor.</section>;
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
        <span className="panel-sub">{pending ? 'Clica numa entrada (à esquerda de um nó) para ligar. Esc cancela.' : 'Liga uma saída (●) a uma entrada. Clicar numa entrada ligada desliga.'}</span>
      </div>
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
  return m?.name ?? c.id;
}
