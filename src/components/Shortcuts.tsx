// "Atalhos": what each key does, and the way to change it. Click a shortcut, press the new keys.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ACTIONS, comboLabel, comboOf, keysOf, useKeys, type KeyAction } from '../keys';
import { Icon } from './Icon';

const GROUPS: KeyAction['group'][] = ['Reprodução', 'Timeline', 'Fusion', 'Vista', 'Projeto'];

export function Shortcuts() {
  const open = useKeys((s) => s.open);
  const custom = useKeys((s) => s.custom);
  const [recording, setRecording] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // While the window is open every key press belongs to it (nothing is cut or deleted behind it).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (!recording) {
        if (e.key === 'Escape') useKeys.getState().setOpen(false);
        return;
      }
      e.preventDefault();
      if (e.key === 'Escape') {
        setRecording(null);
        return;
      }
      const combo = comboOf(e);
      if (!combo) return;
      const mine = ACTIONS.find((a) => a.id === recording)!;
      const taken = ACTIONS.find((a) => a.id !== recording && keysOf(a).includes(combo) && Boolean(a.pages) === Boolean(mine.pages));
      useKeys.getState().assign(recording, combo);
      setNote(taken ? `${comboLabel(combo)} era de "${taken.label}" e passou para "${mine.label}".` : null);
      setRecording(null);
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [open, recording]);
  useEffect(() => {
    if (!open) {
      setRecording(null);
      setNote(null);
    }
  }, [open]);

  if (!open) return null;
  const close = () => useKeys.getState().setOpen(false);
  return createPortal(
    <div className="kb-back" onPointerDown={close}>
      <div className="kb" role="dialog" aria-label="Atalhos de teclado" onPointerDown={(e) => e.stopPropagation()}>
        <div className="kb-head">
          <strong>Atalhos de teclado</strong>
          <span className="spacer" />
          <button className="btn sm" onClick={() => (useKeys.getState().reset(), setNote('Todos os atalhos voltaram ao original.'))} disabled={!Object.keys(custom).length}>
            Repor todos
          </button>
          <button className="btn icon sm" onClick={close} aria-label="Fechar" title="Fechar (Esc)">
            <Icon name="close" />
          </button>
        </div>
        <p className="kb-note">{note ?? 'Clica num atalho e carrega nas teclas novas. Esc cancela. Ficam guardados neste computador.'}</p>
        <div className="kb-body">
          {GROUPS.map((g) => (
            <section key={g}>
              <h4>{g}</h4>
              {ACTIONS.filter((a) => a.group === g).map((a) => {
                const keys = keysOf(a, custom);
                const changed = custom[a.id] !== undefined;
                return (
                  <div className="kb-row" key={a.id}>
                    <span className="kb-label">{a.label}</span>
                    <button className={`kb-keys${recording === a.id ? ' rec' : ''}`} onClick={() => setRecording(recording === a.id ? null : a.id)} title="Clicar e carregar nas teclas novas" aria-label={`Atalho de ${a.label}`}>
                      {recording === a.id ? 'Carrega nas teclas…' : keys.length ? keys.map((k) => <kbd key={k}>{comboLabel(k)}</kbd>) : <em>sem atalho</em>}
                    </button>
                    <button className="kb-x" onClick={() => useKeys.getState().clear(a.id)} disabled={!keys.length} title="Tirar o atalho" aria-label={`Tirar o atalho de ${a.label}`}>
                      <Icon name="close" />
                    </button>
                    <button className="kb-x" onClick={() => useKeys.getState().reset(a.id)} disabled={!changed} title="Repor o original" aria-label={`Repor o atalho de ${a.label}`}>
                      <Icon name="undo" />
                    </button>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
