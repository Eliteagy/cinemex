// "Pacotes de edição": one click = the whole edit (captions model, AI big word, effects, zoom punch,
// sound effects, music, B-roll, progress bar, CTA). Apply to the video on the timeline, change it and
// save it as your own pack. Built-in packs: src/lib/editpacks.js; saved: userData/edit-packs.json.
import { useEffect, useState } from 'react';
import { useEditor } from '../store';
import { applyEditPack } from '../packs';
import { Icon } from './Icon';
import type { CaptionModel, EditPack, EffectRecipe } from '../types';

type Listed = EditPack & { id: string; builtin: boolean };
const MUSIC: [EditPack['music'], string][] = [
  ['off', 'Sem música'],
  ['auto', 'Pelo que é dito'],
  ['calma', 'Calma'],
  ['media', 'Média'],
  ['forte', 'Forte'],
];

export function EditPacksPanel() {
  const setStatus = useEditor((s) => s.setStatus);
  const [packs, setPacks] = useState<Listed[]>([]);
  const [models, setModels] = useState<(CaptionModel & { id: string })[]>([]);
  const [effects, setEffects] = useState<(EffectRecipe & { id: string })[]>([]);
  const [pick, setPick] = useState('vitor');
  const [draft, setDraft] = useState<EditPack | null>(null);
  const [busy, setBusy] = useState(false);
  const [folders, setFolders] = useState<{ music: number; broll: string; pexels: boolean } | null>(null);

  const load = async () => {
    setPacks(await window.ec.listEditPacks());
    setModels(await window.ec.listCaptionModels());
    setEffects(await window.ec.listEffects());
  };
  useEffect(() => {
    void load();
    void Promise.all([window.ec.musicLibrary(), window.ec.brollStatus()]).then(([m, b]) => setFolders({ music: m.tracks.filter((t) => t.source === 'pasta').length, broll: b.folder, pexels: b.pexels }));
  }, []);
  const current = packs.find((p) => p.id === pick);
  useEffect(() => {
    if (current) {
      const { id: _i, builtin: _b, ...p } = current;
      setDraft({ ...p, effects: [...p.effects] });
    }
  }, [pick, packs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const set = (patch: Partial<EditPack>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const save = () =>
    run(async () => {
      if (!draft) return;
      const r = await window.ec.saveEditPack(current?.builtin ? null : pick, current?.builtin && draft.label === current.label ? { ...draft, label: `${draft.label} (meu)` } : draft);
      await load();
      setPick(r.id);
      setStatus(`Pacote «${r.pack.label}» guardado`);
    });

  return (
    <aside className="panel ep" aria-label="Pacotes de edição">
      <div className="panel-body">
        <p className="panel-sub">Um clique faz a edição toda: legendas, palavra principal pela IA, efeitos, zoom, sons, música, B-roll, barra e CTA. Também serve para os Shorts.</p>
        <div className="ep-list" role="listbox" aria-label="Pacotes">
          {packs.map((p) => (
            <button key={p.id} role="option" aria-selected={p.id === pick} className={`ep-card${p.id === pick ? ' on' : ''}`} onClick={() => setPick(p.id)}>
              <b>{p.label}</b>
              <span className="panel-sub">
                {models.find((m) => m.id === p.captionModel)?.label ?? p.captionModel}
                {p.punch > 0 ? ' · zoom' : ''}
                {p.sfx ? ' · sons' : ''}
                {p.music !== 'off' ? ' · música' : ''}
                {p.broll ? ' · B-roll' : ''}
                {p.progress ? ' · barra' : ''}
                {p.cta ? ` · «${p.cta}»` : ''}
                {!p.builtin ? ' · meu' : ''}
              </span>
            </button>
          ))}
        </div>
        <button className="btn primary" disabled={busy || !draft} onClick={() => void run(() => applyEditPack(draft!))}>
          <Icon name="spark" /> {busy ? 'A editar…' : 'Aplicar ao vídeo'}
        </button>
        {folders && (
          <p className="panel-sub">
            Música: {folders.music} na pasta{' '}
            <button className="link" onClick={() => void window.ec.openMusicFolder()}>
              abrir
            </button>{' '}
            · B-roll: {folders.pexels ? 'pasta + Pexels' : 'só a pasta'}{' '}
            <button className="link" onClick={() => void window.ec.openBrollFolder()}>
              abrir
            </button>
          </p>
        )}
        {draft && (
          <details className="cm-edit">
            <summary>Mudar este pacote</summary>
            <label className="cm-words">
              Legendas
              <select className="select" value={draft.captionModel} onChange={(e) => set({ captionModel: e.target.value })}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="sh-check">
              <input type="checkbox" checked={draft.keywordAI} onChange={(e) => set({ keywordAI: e.target.checked })} /> Palavra principal escolhida pela IA
            </label>
            <label className="cm-slider">
              <span>Zoom punch</span>
              <input className="range" type="range" min={0} max={0.3} step={0.01} value={draft.punch} onChange={(e) => set({ punch: Number(e.target.value) })} aria-label="Zoom punch" />
              <span className="cm-val">{draft.punch ? `${Math.round(draft.punch * 100)} %` : 'não'}</span>
            </label>
            <label className="sh-check">
              <input type="checkbox" checked={draft.sfx} onChange={(e) => set({ sfx: e.target.checked })} /> Sons nas palavras grandes
            </label>
            <label className="cm-words">
              Música
              <select className="select" value={draft.music} onChange={(e) => set({ music: e.target.value as EditPack['music'] })}>
                {MUSIC.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="sh-check">
              <input type="checkbox" checked={draft.broll} onChange={(e) => set({ broll: e.target.checked })} /> B-roll automático
            </label>
            <label className="sh-check">
              <input type="checkbox" checked={draft.progress} onChange={(e) => set({ progress: e.target.checked })} /> Barra de progresso
            </label>
            <label className="cm-words">
              CTA no fim
              <input className="input" value={draft.cta} maxLength={80} placeholder="Ex.: Segue para mais" onChange={(e) => set({ cta: e.target.value })} />
            </label>
            {effects.length > 0 && (
              <div className="cm-words">
                Efeitos da biblioteca
                {effects.map((fx) => (
                  <label key={fx.id} className="sh-check">
                    <input
                      type="checkbox"
                      checked={draft.effects.includes(fx.id)}
                      onChange={(e) => set({ effects: e.target.checked ? [...draft.effects, fx.id].slice(0, 5) : draft.effects.filter((x) => x !== fx.id) })}
                    />{' '}
                    {fx.name}
                  </label>
                ))}
              </div>
            )}
            <label className="cm-words">
              Nome
              <input className="input" value={draft.label} maxLength={60} onChange={(e) => set({ label: e.target.value })} />
            </label>
            <div className="row">
              <button className="btn primary" disabled={busy} onClick={() => void save()}>
                <Icon name="save" /> Guardar pacote
              </button>
              {current && !current.builtin && (
                <button
                  className="btn danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (!confirm(`Apagar o pacote «${current.label}»?`)) return;
                      await window.ec.deleteEditPack(current.id);
                      setPick('vitor');
                      await load();
                    })
                  }
                >
                  <Icon name="trash" /> Apagar
                </button>
              )}
            </div>
          </details>
        )}
      </div>
    </aside>
  );
}
