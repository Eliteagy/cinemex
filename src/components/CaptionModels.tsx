// "Modelos de legendas": whole caption looks (big words behind the person, small words in front).
// Pick a model, apply it to the video on the timeline, change it (colours, fonts, sizes, position,
// accent words) and apply again, then save it as your own model. Built-in models: src/lib/capmodels.js;
// saved ones: userData/caption-models.json (electron/capmodels.cjs).
import { useEffect, useState } from 'react';
import { applyCaptionModel } from '../actions';
import { useEditor } from '../store';
import { ColorField, FontPicker } from './CaptionStyleEditor';
import { Icon } from './Icon';
import { viewerShot } from '../lib/viewerShot';
import { mediaUrl } from '../lib/project';
import type { CaptionModel } from '../types';

type Listed = CaptionModel & { id: string; builtin: boolean; thumb?: string };

const KINDS: [CaptionModel['kind'], string][] = [
  ['atras-frente', 'Atrás + frente'],
  ['gigante', 'Palavra gigante'],
  ['duas-linhas', 'Duas linhas'],
];

const FRONT_DEFAULT = { font: 'Inter Bold', color: '#FFFFFF', size: 0.05, drop: 2.6 };

function Slider({ label, value, min, max, step, onChange, fmt }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt?: (v: number) => string }) {
  return (
    <label className="cm-slider">
      <span>{label}</span>
      <input className="range" type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="cm-val">{fmt ? fmt(value) : value}</span>
    </label>
  );
}

export function CaptionModels() {
  const [models, setModels] = useState<Listed[]>([]);
  const [pick, setPick] = useState<string>('vitor');
  const [draft, setDraft] = useState<CaptionModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const setStatus = useEditor((s) => s.setStatus);

  const load = async () => setModels(await window.ec.listCaptionModels());
  useEffect(() => {
    void load();
  }, []);
  const current = models.find((m) => m.id === pick);
  useEffect(() => {
    if (current) {
      const { id: _id, builtin: _b, ...m } = current;
      setDraft(structuredClone(m));
      setName(current.builtin ? `${current.label} (meu)` : current.label);
    }
  }, [pick, models.length]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const [applied, setApplied] = useState(false);
  const apply = () => run(async () => {
    await applyCaptionModel(draft ?? pick);
    setApplied(true);
  });
  const save = (asNew: boolean) =>
    run(async () => {
      if (!draft) return;
      const r = await window.ec.saveCaptionModel(asNew || current?.builtin ? null : pick, { ...draft, label: name.trim() || draft.label }, applied ? viewerShot() : null);
      await load();
      setPick(r.id);
      setStatus(`Modelo «${r.model.label}» guardado`);
    });
  const remove = () =>
    run(async () => {
      if (!current || current.builtin || !confirm(`Apagar o modelo «${current.label}»?`)) return;
      await window.ec.deleteCaptionModel(current.id);
      setPick('vitor');
      await load();
    });

  const set = (patch: Partial<CaptionModel>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const back = (patch: Partial<CaptionModel['back']>) => setDraft((d) => (d ? { ...d, back: { ...d.back, ...patch } } : d));
  const front = (patch: Partial<NonNullable<CaptionModel['front']>>) => setDraft((d) => (d ? { ...d, front: { ...FRONT_DEFAULT, ...d.front, ...patch } } : d));
  const pct = (v: number) => `${Math.round(v * 100)} %`;

  return (
    <div className="field cm">
      <label className="row-label">
        <span>Modelos de legendas</span>
        <span className="panel-sub">Palavras grandes atrás da pessoa</span>
      </label>
      <div className="cm-grid" role="listbox" aria-label="Modelos de legendas">
        {models.map((m) => (
          <button key={m.id} role="option" aria-selected={m.id === pick} className={`cm-card${m.id === pick ? ' on' : ''}`} onClick={() => setPick(m.id)} title={m.label}>
            {m.thumb ? <img className="cm-thumb" src={mediaUrl(m.thumb)} alt="" /> : null}
            <span className="cm-demo" data-kind={m.kind} hidden={Boolean(m.thumb)}>
              <b style={{ color: m.accent ? m.accent.color : m.back.color }}>{m.kind === 'duas-linhas' ? 'DUAS' : 'CASA'}</b>
              {m.kind === 'duas-linhas' && <b className="cm-l2">LINHAS</b>}
              {m.kind === 'atras-frente' && <i style={{ color: m.front?.color }}>a tua nova</i>}
            </span>
            <span className="cm-name">
              {m.label}
              {!m.builtin && <em> · meu</em>}
            </span>
          </button>
        ))}
      </div>
      <button className="btn primary" disabled={busy || !draft} onClick={() => void apply()} title="Legenda o vídeo da timeline (ou o selecionado) com este modelo: recorta a pessoa e põe as palavras atrás e à frente">
        <Icon name="spark" /> {busy ? 'A aplicar…' : 'Aplicar ao vídeo'}
      </button>
      {draft && (
        <details className="cm-edit">
          <summary>Mudar este modelo</summary>
          <div className="seg sm" role="radiogroup" aria-label="Tipo">
            {KINDS.map(([k, l]) => (
              <button key={k} className={draft.kind === k ? 'on' : ''} onClick={() => set({ kind: k, maxWords: k === 'gigante' ? 1 : k === 'duas-linhas' ? 4 : 3, ...(k === 'atras-frente' && !draft.front ? { front: FRONT_DEFAULT } : {}) })}>
                {l}
              </button>
            ))}
          </div>
          <p className="panel-sub">Atrás da pessoa</p>
          <FontPicker label="Fonte" value={draft.back.font} onChange={(font) => back({ font })} />
          <ColorField label="Cor" value={draft.back.color} onChange={(color) => back({ color })} />
          <Slider label="Largura" value={draft.back.width} min={0.4} max={0.98} step={0.01} onChange={(width) => back({ width })} fmt={pct} />
          <Slider label="Tamanho máx." value={draft.back.maxSize} min={0.06} max={0.32} step={0.01} onChange={(maxSize) => back({ maxSize })} fmt={pct} />
          <Slider label="Altura (sobre a cabeça)" value={draft.back.lift} min={-1} max={2} step={0.05} onChange={(lift) => back({ lift })} />
          {draft.kind !== 'gigante' && <Slider label="Palavras por legenda" value={draft.maxWords} min={2} max={5} step={1} onChange={(maxWords) => set({ maxWords })} />}
          {draft.kind === 'atras-frente' && (
            <>
              <p className="panel-sub">À frente (no peito)</p>
              <FontPicker label="Fonte" value={draft.front?.font ?? FRONT_DEFAULT.font} onChange={(font) => front({ font })} />
              <ColorField label="Cor" value={draft.front?.color ?? FRONT_DEFAULT.color} onChange={(color) => front({ color })} />
              <Slider label="Tamanho" value={draft.front?.size ?? 0.05} min={0.025} max={0.1} step={0.005} onChange={(size) => front({ size })} fmt={pct} />
              <Slider label="Distância da cara" value={draft.front?.drop ?? 2.6} min={1} max={6} step={0.1} onChange={(drop) => front({ drop })} />
            </>
          )}
          <label className="sh-check">
            <input type="checkbox" checked={Boolean(draft.accent)} onChange={(e) => set({ accent: e.target.checked ? { color: '#D4AF37', numbers: true, words: [] } : undefined })} /> Palavras com cor de destaque
          </label>
          {draft.accent && (
            <>
              <ColorField label="Cor de destaque" value={draft.accent.color} onChange={(color) => set({ accent: { ...draft.accent!, color } })} />
              <label className="sh-check">
                <input type="checkbox" checked={draft.accent.numbers} onChange={(e) => set({ accent: { ...draft.accent!, numbers: e.target.checked } })} /> Números, preços e %
              </label>
              <label className="cm-words">
                Palavras (separadas por vírgula)
                <input className="input" value={draft.accent.words.join(', ')} onChange={(e) => set({ accent: { ...draft.accent!, words: e.target.value.split(',').map((w) => w.trim()).filter(Boolean) } })} placeholder="vendido, casa, dinheiro" />
              </label>
            </>
          )}
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => void apply()}>
              Ver no vídeo
            </button>
          </div>
          <label className="cm-words">
            Nome do modelo
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </label>
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => void save(false)} title={current?.builtin ? 'Os modelos da app não mudam: fica guardado como modelo teu' : 'Guarda as alterações neste modelo'}>
              <Icon name="save" /> Guardar modelo
            </button>
            {!current?.builtin && (
              <>
                <button className="btn" disabled={busy} onClick={() => void save(true)}>
                  Guardar como novo
                </button>
                <button className="btn danger" disabled={busy} onClick={() => void remove()}>
                  <Icon name="trash" /> Apagar
                </button>
              </>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
