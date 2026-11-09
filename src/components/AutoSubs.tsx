// "Legendas automáticas" panel on the Captions page, with the options AutoSubs offers (model,
// language, translate to English, density / characters per line, lines, case, punctuation,
// censored words, prompt). Re-implemented natively: Whisper runs in engine/transcribe.py and the
// grouping in electron/captions.cjs. The options are remembered on this PC.
import { useState } from 'react';
import { useEditor } from '../store';
import { autoCaptions, type AutoCaptionOptions } from '../actions';
import { Icon } from './Icon';
import { ColorField, FontPicker, LayoutFields, useStyleOptions } from './CaptionStyleEditor';
import { baseStyle } from '../lib/project';
import type { CaptionOverride, CaptionStyle } from '../types';

type Opts = Required<Pick<AutoCaptionOptions, 'style' | 'model' | 'language' | 'translate' | 'density' | 'maxChars' | 'maxLines' | 'maxWords' | 'textCase' | 'stripPunct' | 'prompt'>> & { censor: string; onlySelected: boolean; look: CaptionOverride; size: number | null };

const DEFAULTS: Opts = { style: 'elite', model: 'auto', language: 'pt', translate: false, density: 'custom', maxChars: 0, maxLines: 2, maxWords: 3, textCase: 'none', stripPunct: false, prompt: '', censor: '', onlySelected: false, look: {}, size: null };
const KEY = 'elite-cinema.autosubs';

function load(): Opts {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Opts>) };
  } catch {
    return DEFAULTS;
  }
}

const MODELS: [string, string][] = [
  ['auto', 'Automático'],
  ['large-v3-turbo', 'Large v3 Turbo (rápido)'],
  ['large-v3', 'Large v3 (mais preciso)'],
  ['medium', 'Medium'],
  ['small', 'Small'],
  ['base', 'Base'],
  ['tiny', 'Tiny (muito rápido)'],
];
const LANGS: [string, string][] = [
  ['auto', 'Detetar automaticamente'],
  ['pt', 'Português'],
  ['en', 'Inglês'],
  ['es', 'Espanhol'],
  ['fr', 'Francês'],
  ['it', 'Italiano'],
  ['de', 'Alemão'],
];
const DENSITIES: [Opts['density'], string][] = [
  ['single', 'Uma palavra'],
  ['less', 'Menos'],
  ['standard', 'Normal'],
  ['more', 'Mais'],
  ['custom', 'Palavras'],
];
const CASES: [Opts['textCase'], string][] = [
  ['none', 'Original'],
  ['lower', 'minúsculas'],
  ['upper', 'MAIÚSCULAS'],
  ['title', 'Título'],
];

export function AutoSubsPanel() {
  const styleOptions = useStyleOptions();
  const busy = useEditor((s) => s.busy);
  const project = useEditor((s) => s.project);
  const userStyles = useEditor((s) => s.userStyles);
  const hasCaptions = useEditor((s) => s.project.tracks.some((t) => t.kind === 'text' && t.clips.length > 0));
  const selected = useEditor((s) => s.selected);
  const [o, setO] = useState<Opts>(load);
  const set = (patch: Partial<Opts>) =>
    setO((cur) => {
      const next = { ...cur, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* private storage: options last for this session only */
      }
      return next;
    });
  const run = () => {
    const sel = selected ? useEditor.getState().project.tracks.flatMap((t) => (t.kind === 'text' ? [] : t.clips)).find((c) => c.id === selected && c.mediaId) : null;
    void autoCaptions({
      clipId: o.onlySelected && sel ? sel.id : undefined,
      style: o.style,
      model: o.model,
      language: o.language,
      translate: o.translate,
      prompt: o.prompt.trim() || undefined,
      density: o.density,
      maxChars: o.density === 'custom' && o.maxChars ? o.maxChars : undefined,
      maxLines: o.maxLines,
      maxWords: o.density === 'custom' ? o.maxWords : o.density === 'single' ? 1 : 12,
      textCase: o.textCase,
      stripPunct: o.stripPunct,
      censor: o.censor.split(',').map((w) => w.trim()).filter(Boolean),
      override: o.look,
      size: o.size ?? undefined,
    }).catch(() => {});
  };
  return (
    <details className="autosubs" open={!hasCaptions || undefined}>
      <summary>
        <Icon name="captions" /> Legendas automáticas <span className="panel-sub">opções do AutoSubs</span>
      </summary>
      <div className="autosubs-grid">
        <label>
          <span>Estilo</span>
          <select className="select" value={o.style} onChange={(e) => set({ style: e.target.value })}>
            {styleOptions.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
          </select>
        </label>
        <label>
          <span>Modelo</span>
          <select className="select" value={o.model} onChange={(e) => set({ model: e.target.value })}>
            {MODELS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Idioma da fala</span>
          <select className="select" value={o.language} onChange={(e) => set({ language: e.target.value })}>
            {LANGS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={o.translate} onChange={(e) => set({ translate: e.target.checked })} />
          <span>Traduzir para inglês</span>
        </label>
      </div>
      <div className="field">
        <label className="row-label">
          <span>Palavras por legenda</span>
          <span className="panel-sub">quantas aparecem de cada vez</span>
        </label>
        <div className="seg">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <button key={n} className={o.density === 'custom' && o.maxWords === n ? 'on' : o.density === 'single' && n === 1 ? 'on' : ''} onClick={() => set({ density: 'custom', maxWords: n })}>
              {n}
            </button>
          ))}
        </div>
      </div>
      <SubsLook
        st={baseStyle({ id: '', start: 0, in: 0, out: 0, style: o.style }, project, userStyles)}
        look={o.look}
        size={o.size}
        onLook={(patch) => set({ look: { ...o.look, ...patch } })}
        onSize={(size) => set({ size })}
        onReset={() => set({ look: {}, size: null })}
      />
      <div className="field">
        <label>Densidade do texto</label>
        <div className="seg">
          {DENSITIES.map(([k, l]) => (
            <button key={k} className={o.density === k ? 'on' : ''} onClick={() => set({ density: k })}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {o.density === 'custom' && (
        <div className="autosubs-grid">
          <label>
            <span>Palavras por legenda</span>
            <input className="input" type="number" min={1} max={12} value={o.maxWords} onChange={(e) => set({ maxWords: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })} />
          </label>
          <label>
            <span>Caracteres por linha</span>
            <input className="input" type="number" min={0} max={80} value={o.maxChars} placeholder="sem limite" onChange={(e) => set({ maxChars: Math.max(0, Math.min(80, Number(e.target.value) || 0)) })} />
          </label>
        </div>
      )}
      <div className="autosubs-grid">
        <label>
          <span>Linhas no máximo</span>
          <div className="seg">
            {[1, 2, 3].map((n) => (
              <button key={n} className={o.maxLines === n ? 'on' : ''} onClick={() => set({ maxLines: n })}>
                {n}
              </button>
            ))}
          </div>
        </label>
        <label>
          <span>Letras</span>
          <select className="select" value={o.textCase} onChange={(e) => set({ textCase: e.target.value as Opts['textCase'] })}>
            {CASES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={o.stripPunct} onChange={(e) => set({ stripPunct: e.target.checked })} />
          <span>Tirar a pontuação</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={o.onlySelected} onChange={(e) => set({ onlySelected: e.target.checked })} />
          <span>Só o clip selecionado</span>
        </label>
      </div>
      <div className="field">
        <label>Palavras censuradas (separadas por vírgulas)</label>
        <input className="input" value={o.censor} placeholder="ex.: merda, porra" onChange={(e) => set({ censor: e.target.value })} />
      </div>
      <div className="field">
        <label>Contexto para o Whisper (nomes, termos)</label>
        <input className="input" value={o.prompt} placeholder="ex.: Elite Agency, KW, T3, Benfica" onChange={(e) => set({ prompt: e.target.value })} />
      </div>
      <button className="btn primary block" disabled={busy} onClick={run}>
        <Icon name="captions" /> Gerar legendas
      </button>
    </details>
  );
}

/**
 * Look of the captions about to be made: colours, fonts and size over the chosen style. Felipe and
 * Marta get the text and the keyword apart. Remembered with the other options.
 */
function SubsLook({ st, look, size, onLook, onSize, onReset }: { st: CaptionStyle; look: CaptionOverride; size: number | null; onLook: (p: CaptionOverride) => void; onSize: (v: number | null) => void; onReset: () => void }) {
  const em = st.emphasis;
  const changed = Object.keys(look).length > 0 || size !== null;
  return (
    <div className="card subs-look">
      <div className="row-label">
        <h4>Aspeto das legendas</h4>
        {changed && (
          <button className="btn sm ghost" onClick={onReset} title="Voltar ao aspeto do estilo">
            Repor
          </button>
        )}
      </div>
      <FontPicker label={em ? 'Letra do texto' : 'Letra'} value={look.font ?? (em ? em.base.font : st.font)} onChange={(font) => onLook({ font })} />
      <ColorField label="Cor do texto" value={look.color ?? (em ? em.base.color : st.color)} onChange={(color) => onLook({ color })} />
      {em && <LayoutFields o={look} stacked={look.layout ? look.layout === 'stack' : !em.oneLine} marta={em.mode === 'slots'} set={onLook} />}
      {em ? (
        <>
          <FontPicker label="Letra da palavra-chave" value={look.keywordFont ?? em.keyword.font} onChange={(keywordFont) => onLook({ keywordFont })} />
          <ColorField label="Cor da palavra-chave" value={look.keywordColor ?? em.keyword.color} onChange={(keywordColor) => onLook({ keywordColor })} />
        </>
      ) : (
        <ColorField label="Cor da palavra falada" value={look.highlight ?? st.highlight} onChange={(highlight) => onLook({ highlight })} />
      )}
      <div className="field">
        <label className="row-label">
          <span>Tamanho</span>
          <b className="val">{Math.round((size ?? st.size) * 1000) / 10}%</b>
        </label>
        <input className="range" type="range" min={0.02} max={0.2} step={0.001} value={size ?? st.size} onChange={(e) => onSize(Number(e.target.value))} aria-label="Tamanho" />
      </div>
    </div>
  );
}
