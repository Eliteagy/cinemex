// Caption look controls: colour field (brand swatches + hex + picker), font picker (bundled +
// installed fonts, each shown in its own face), the per-caption look card and the style editor.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor } from '../store';
import { STYLES, baseStyle, findClip, styleOf } from '../lib/project';
import { applyOverride } from '../lib/capstyle.js';
import { USER_FONTS, lineOffset } from '../lib/emphasis.js';
import { getDragScope, setDragScope, targetIds, type DragScope } from './CaptionOverlay';
import { BUNDLED_FONTS, requestFont } from '../engine/caption';
import type { CaptionAnim, CaptionOverride, CaptionStyle, Clip } from '../types';
import { CaptionBlocks } from './CaptionBlocks';
import { Icon } from './Icon';

/** Brand colours: white, Elite gold, Marta bordeaux, Felipe blue, black. */
export const BRAND_SWATCHES = [
  { hex: '#FFFFFF', name: 'Branco' },
  { hex: '#D4AF37', name: 'Dourado Elite' },
  { hex: '#83163A', name: 'Bordeaux (Marta)' },
  { hex: '#5FBEF8', name: 'Azul (Felipe)' },
  { hex: '#000000', name: 'Preto' },
];

export const ANIMS: { k: CaptionAnim; label: string }[] = [
  { k: 'pop', label: 'Pop' },
  { k: 'fade', label: 'Aparecer' },
  { k: 'slide', label: 'Deslizar' },
  { k: 'words', label: 'Palavra a palavra' },
  { k: 'bounce', label: 'Salto' },
  { k: 'karaoke', label: 'Karaoke' },
  { k: 'marker', label: 'Marcador' },
];

const HEX = /^#?[0-9a-f]{6}$/i;

export function ColorField({ label, value, onChange, onStart }: { label: string; value: string; onChange: (hex: string) => void; onStart?: () => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (HEX.test(draft)) onChange(`#${draft.replace('#', '').toUpperCase()}`);
    else setDraft(value);
  };
  return (
    <div className="field colorfield">
      <label>{label}</label>
      <div className="cf-row">
        <div className="cf-swatches" role="group" aria-label={`${label}: cores da marca`}>
          {BRAND_SWATCHES.map((s) => (
            <button key={s.hex} className={`cf-sw${value.toUpperCase() === s.hex ? ' on' : ''}`} style={{ background: s.hex }} title={s.name} aria-label={s.name} aria-pressed={value.toUpperCase() === s.hex} onClick={() => onChange(s.hex)} />
          ))}
        </div>
        <input className="input cf-hex" value={draft} spellCheck={false} aria-label={`${label}: código hex`} maxLength={7} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        <label className="cf-native" title="Escolher outra cor">
          <input type="color" value={HEX.test(value) ? value.slice(0, 7) : '#ffffff'} onPointerDown={onStart} onChange={(e) => onChange(e.target.value.toUpperCase())} aria-label={`${label}: escolher cor`} />
        </label>
      </div>
    </div>
  );
}

type FontItem = { family: string; group: 'app' | 'pc' | 'personal' };
let fontsPromise: Promise<FontItem[]> | null = null;
function allFonts() {
  fontsPromise ??= (window.ec?.listFonts?.() ?? Promise.resolve([]))
    .catch(() => [])
    .then((installed) => {
      const app = Object.keys(BUNDLED_FONTS).map((family) => ({ family, group: 'app' as const }));
      const personal = Object.keys(USER_FONTS).map((family) => ({ family, group: 'personal' as const }));
      const known = new Set([...app, ...personal].map((f) => f.family.toLowerCase()));
      const pc = installed.filter((f) => !known.has(f.family.toLowerCase())).map((f) => ({ family: f.family, group: 'pc' as const }));
      return [...app, ...personal, ...pc];
    });
  return fontsPromise;
}

const GROUPS = { app: 'Incluídas na app', personal: 'Pessoais (só no teu PC)', pc: 'Instaladas no PC' } as const;

export function FontPicker({ label, value, onChange }: { label: string; value: string; onChange: (family: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [list, setList] = useState<FontItem[]>([]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) void allFonts().then(setList);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    addEventListener('pointerdown', away);
    return () => removeEventListener('pointerdown', away);
  }, [open]);
  useEffect(() => requestFont(value), [value]);
  const shown = useMemo(() => {
    const f = q.trim().toLowerCase();
    return (f ? list.filter((x) => x.family.toLowerCase().includes(f)) : list).slice(0, 300);
  }, [list, q]);
  const pick = (family: string) => {
    requestFont(family);
    onChange(family);
    setOpen(false);
    setQ('');
  };
  let lastGroup = '';
  return (
    <div className="field fontpicker" ref={box}>
      <label>{label}</label>
      <button className="select fp-button" style={{ fontFamily: `"${value}", "Segoe UI", sans-serif` }} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} title={value}>
        {value}
      </button>
      {open && (
        <div className="fp-pop" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setOpen(false))}>
          <input className="input" autoFocus placeholder="Procurar fonte" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && shown[0] && pick(shown[0].family)} aria-label="Procurar fonte" />
          <div className="fp-list" role="listbox" aria-label={label}>
            {!shown.length && <p className="panel-sub pad">{list.length ? 'Nenhuma fonte com esse nome.' : 'A ler as fontes do PC…'}</p>}
            {shown.map((f) => {
              const head = f.group !== lastGroup ? GROUPS[f.group] : null;
              lastGroup = f.group;
              return (
                <div key={`${f.group}:${f.family}`}>
                  {head && <div className="fp-group">{head}</div>}
                  <button role="option" aria-selected={f.family === value} className={`fp-item${f.family === value ? ' on' : ''}`} onClick={() => pick(f.family)}>
                    <span style={{ fontFamily: `"${f.family}", "Segoe UI", sans-serif` }}>{f.family}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** The selected caption's own look (over its style): colours, fonts, size. */
export function CaptionLook({ clip }: { clip: Clip }) {
  const project = useEditor((s) => s.project);
  const userStyles = useEditor((s) => s.userStyles);
  const s = () => useEditor.getState();
  const base = baseStyle(clip, project, userStyles);
  const st = styleOf(clip, project, userStyles);
  const em = Boolean(st.emphasis);
  const o = clip.override ?? {};
  const [scope, setScope] = useState<DragScope>(getDragScope);
  const pickScope = (v: DragScope) => (setDragScope(v), setScope(v));
  const ids = () => targetIds(s().project, clip, scope);
  const set = (patch: CaptionOverride) => s().setCaptionOverride(ids(), patch);
  const changed = Boolean(clip.override) || clip.size !== undefined || Boolean(clip.lines);
  const size = clip.size ?? base.size;
  return (
    <div className="card look-card">
      <div className="row-label">
        <h4>{scope === 'all' ? 'Todas as legendas' : 'Esta legenda'}</h4>
        {changed && <span className="tag">Alterada</span>}
      </div>
      <div className="seg" role="group" aria-label="As mudanças aplicam-se a">
        <button className={scope === 'one' ? 'on' : ''} aria-pressed={scope === 'one'} onClick={() => pickScope('one')}>
          Só esta legenda
        </button>
        <button className={scope === 'all' ? 'on' : ''} aria-pressed={scope === 'all'} onClick={() => pickScope('all')} title="Todas as legendas do vídeo (os títulos noutro estilo ficam como estão)">
          Todas as legendas
        </button>
      </div>
      <p>{scope === 'all' ? 'Cada mudança (cor, letra, tamanho, disposição, espaço, movimento, posição) vai para todas as legendas.' : `Muda só a legenda selecionada; o resto continua com o estilo «${base.label}».`}</p>
      <FontPicker label={em ? 'Fonte do texto' : 'Fonte'} value={o.font ?? (em ? st.emphasis!.base.font : st.font)} onChange={(font) => set({ font })} />
      <ColorField label="Cor do texto" value={o.color ?? (em ? st.emphasis!.base.color : st.color)} onStart={() => s().startSlide()} onChange={(color) => set({ color })} />
      {em ? (
        <>
          <FontPicker label="Fonte da palavra-chave" value={o.keywordFont ?? st.emphasis!.keyword.font} onChange={(keywordFont) => set({ keywordFont })} />
          <ColorField label="Cor da palavra-chave" value={o.keywordColor ?? st.emphasis!.keyword.color} onStart={() => s().startSlide()} onChange={(keywordColor) => set({ keywordColor })} />
        </>
      ) : (
        <ColorField label="Cor de destaque (palavra falada)" value={o.highlight ?? st.highlight} onStart={() => s().startSlide()} onChange={(highlight) => set({ highlight })} />
      )}
      <div className="field">
        <label className="row-label">
          <span>Tamanho</span>
          <b className="val">{Math.round(size * 1000) / 10}%</b>
        </label>
        <input className="range" type="range" min={0.02} max={0.2} step={0.001} value={size} onPointerDown={() => s().startSlide()} onChange={(e) => s().updateCaptions(ids(), { size: Number(e.target.value) })} aria-label="Tamanho" />
      </div>
      {em && <LayoutFields o={o} stacked={!st.emphasis!.oneLine} marta={base.emphasis?.mode === 'slots'} set={set} />}
      <LinePlaces clip={clip} keywordStyle={em} marta={st.emphasis?.mode === 'slots'} scope={scope} />
      <div className="row">
        <button className="btn sm" onClick={() => s().setStatus(`${s().copyCaptionLook(clip.id)} legendas com este aspeto (Ctrl+Z desfaz)`)} title="Todas as legendas ficam com estas cores, fontes, tamanho e posições">
          Aplicar a todas
        </button>
        <button className="btn sm ghost" disabled={!changed} onClick={() => s().setCaptionOverride(ids(), null)} title="Volta ao estilo">
          Repor
        </button>
      </div>
    </div>
  );
}

const ROLES = [
  ['base', 'Texto (linha de cima)'],
  ['kw', 'Palavra-chave'],
  ['rest', 'Segunda linha'],
] as const;

/**
 * Where each line of the caption sits. Felipe/Marta: the top words and the keyword move apart
 * (drag them on the viewer, or nudge here); other styles move as one block.
 */
function LinePlaces({ clip, keywordStyle, marta, scope }: { clip: Clip; keywordStyle: boolean; marta: boolean; scope: DragScope }) {
  const s = () => useEditor.getState();
  const project = useEditor((x) => x.project);
  const userStyles = useEditor((x) => x.userStyles);
  const ids = () => targetIds(s().project, clip, scope);
  const nudge = (role: 'base' | 'kw' | 'rest', axis: 'x' | 'y', v: number) => {
    const o = lineOffset(clip.lines, role);
    s().setCaptionLines(ids(), { ...clip.lines, [role]: { ...o, [axis]: v } });
  };
  const oneLine = Boolean(styleOf(clip, project, userStyles).emphasis?.oneLine);
  const roles = oneLine ? ROLES.filter(([r]) => r === 'base') : ROLES.filter(([r]) => r !== 'rest' || marta);
  return (
    <div className="field line-places">
      <label className="row-label">
        <span>Posição {keywordStyle && !oneLine ? 'das linhas' : 'da legenda'}</span>
        <span className="panel-sub">arrasta no visor</span>
      </label>
      {keywordStyle &&
        roles.map(([role, label]) => {
          const o = lineOffset(clip.lines, role);
          return (
            <div key={role} className="line-place">
              <span>{oneLine ? 'Linha' : label}</span>
              <input className="range" type="range" min={-0.5} max={0.5} step={0.002} value={o.x} aria-label={`${label}: para os lados`} title="Para os lados" onPointerDown={() => s().startSlide()} onChange={(e) => nudge(role, 'x', Number(e.target.value))} />
              <input className="range" type="range" min={-0.5} max={0.5} step={0.002} value={o.y} aria-label={`${label}: para cima e para baixo`} title="Para cima / baixo" onPointerDown={() => s().startSlide()} onChange={(e) => nudge(role, 'y', Number(e.target.value))} />
            </div>
          );
        })}
      {keywordStyle && clip.lines && (
        <button className="btn sm ghost" onClick={() => s().setCaptionLines(ids(), null)}>
          Repor posições
        </button>
      )}
    </div>
  );
}

const ANIM_OPTIONS = [
  ['reveal', 'Varrer'],
  ['rise', 'Subir'],
  ['none', 'Sem'],
] as const;

/** Felipe/Marta layout: one line or stacked, the gap between lines and how text and keyword come in. */
export function LayoutFields({ o, stacked, marta, set }: { o: CaptionOverride; stacked: boolean; marta: boolean; set: (p: CaptionOverride) => void }) {
  const gap = o.lineGap ?? 1;
  return (
    <>
      <div className="field">
        <label>Disposição</label>
        <div className="seg">
          <button className={stacked ? 'on' : ''} aria-pressed={stacked} onClick={() => set({ layout: 'stack' })}>
            {marta ? 'Em blocos' : 'Uma por baixo da outra'}
          </button>
          <button className={!stacked ? 'on' : ''} aria-pressed={!stacked} onClick={() => set({ layout: 'line' })}>
            Tudo numa linha
          </button>
        </div>
      </div>
      {stacked && (
        <div className="field">
          <label className="row-label">
            <span>Espaço entre linhas</span>
            <b className="val">{Math.round(gap * 100)}%</b>
          </label>
          <input className="range" type="range" min={0.3} max={3} step={0.01} value={gap} onPointerDown={() => useEditor.getState().startSlide()} onChange={(e) => set({ lineGap: Number(e.target.value) })} aria-label="Espaço entre linhas" />
        </div>
      )}
      <div className="field">
        <label>{stacked ? 'Movimento do texto' : 'Movimento'}</label>
        <div className="seg">
          {ANIM_OPTIONS.map(([k, l]) => (
            <button key={k} className={o.textAnim === k ? 'on' : ''} aria-pressed={o.textAnim === k} onClick={() => set({ textAnim: k })}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {stacked && (
        <div className="field">
          <label>Movimento da palavra-chave</label>
          <div className="seg">
            {ANIM_OPTIONS.map(([k, l]) => (
              <button key={k} className={o.keywordAnim === k ? 'on' : ''} aria-pressed={o.keywordAnim === k} onClick={() => set({ keywordAnim: k })}>
                {l}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

const KEYWORD_TEMPLATES = { felipe: 'Estilo Felipe', marta: 'Estilo Marta' } as const;

/** Create or edit a saved caption style. `from` is the style it starts from. */
export function StyleEditor({ id, from, onClose }: { id: string | null; from: CaptionStyle; onClose: (savedId?: string) => void }) {
  const [d, setD] = useState<CaptionStyle>(() => structuredClone({ ...from, label: id ? from.label : `${from.label} (cópia)` }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const plain = (patch: Partial<CaptionStyle>) => setD((x) => ({ ...x, ...patch }));
  const look = (patch: CaptionOverride) => setD((x) => applyOverride({ ...x, ...(patch.font ? { font: patch.font } : {}), ...(patch.color ? { color: patch.color } : {}) }, patch));
  const em = d.emphasis;
  const kwMode = em ? (em.mode === 'slots' ? 'marta' : 'felipe') : 'none';
  const setKeyword = (mode: string) => {
    if (mode === 'none') {
      setD((x) => {
        const n = { ...x };
        delete n.emphasis;
        return n;
      });
      return;
    }
    const t = STYLES[mode]!;
    setD((x) => applyOverride({ ...x, size: t.size, y: t.y, emphasis: structuredClone(t.emphasis!) }, { font: x.font, color: x.color }));
  };
  const save = async () => {
    if (!d.label.trim()) return setErr('Dá um nome ao estilo');
    setSaving(true);
    try {
      const saved = await useEditor.getState().saveUserStyle(id, { ...d, label: d.label.trim() });
      onClose(saved);
    } catch (e) {
      setErr((e as Error).message);
      setSaving(false);
    }
  };
  return (
    <div className="card style-editor">
      <div className="row-label">
        <h4>{id ? 'Editar estilo' : 'Novo estilo'}</h4>
        <button className="btn icon sm ghost" onClick={() => onClose()} title="Fechar sem guardar" aria-label="Fechar">
          ✕
        </button>
      </div>
      <CaptionBlocks styles={[['__draft', d]]} current="__draft" onPick={() => {}} />
      <div className="field" style={{ marginTop: 12 }}>
        <label>Nome</label>
        <input className="input" value={d.label} maxLength={60} onChange={(e) => plain({ label: e.target.value })} />
      </div>
      <FontPicker label={em ? 'Fonte do texto' : 'Fonte'} value={em ? em.base.font : d.font} onChange={(font) => look({ font })} />
      <div className="field">
        <label className="row-label">
          <span>Tamanho</span>
          <b className="val">{Math.round(d.size * 1000) / 10}%</b>
        </label>
        <input className="range" type="range" min={0.02} max={0.2} step={0.001} value={d.size} onChange={(e) => plain({ size: Number(e.target.value) })} aria-label="Tamanho" />
      </div>
      <div className="field">
        <label className="row-label">
          <span>Posição vertical</span>
          <b className="val">{Math.round(d.y * 100)}%</b>
        </label>
        <input className="range" type="range" min={0.05} max={0.95} step={0.01} value={d.y} onChange={(e) => plain({ y: Number(e.target.value) })} aria-label="Posição vertical" />
      </div>
      {!em && (
        <div className="field">
          <label>Efeito</label>
          <select className="select" value={d.anim ?? 'pop'} onChange={(e) => plain({ anim: e.target.value as CaptionAnim })}>
            {ANIMS.map((a) => (
              <option key={a.k} value={a.k}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <label>Palavra-chave</label>
        <div className="seg">
          <button className={kwMode === 'none' ? 'on' : ''} onClick={() => setKeyword('none')}>
            Não
          </button>
          {Object.entries(KEYWORD_TEMPLATES).map(([k, l]) => (
            <button key={k} className={kwMode === k ? 'on' : ''} onClick={() => setKeyword(k)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <ColorField label="Cor do texto" value={em ? em.base.color : d.color} onChange={(color) => look({ color })} />
      {em ? (
        <>
          <FontPicker label="Fonte da palavra-chave" value={em.keyword.font} onChange={(keywordFont) => look({ keywordFont })} />
          <ColorField label="Cor da palavra-chave" value={em.keyword.color} onChange={(keywordColor) => look({ keywordColor })} />
        </>
      ) : (
        <>
          <ColorField label="Cor de destaque (palavra falada)" value={d.highlight} onChange={(highlight) => plain({ highlight })} />
          <ColorField label="Cor do contorno" value={d.outlineColor} onChange={(outlineColor) => plain({ outlineColor })} />
          <div className="field">
            <label className="row-label">
              <span>Contorno</span>
              <b className="val">{Math.round(d.outline * 1000)}</b>
            </label>
            <input className="range" type="range" min={0} max={0.02} step={0.0005} value={d.outline} onChange={(e) => plain({ outline: Number(e.target.value) })} aria-label="Contorno" />
          </div>
          <ColorField label="Cor da sombra" value={d.shadowColor ?? '#000000'} onChange={(shadowColor) => plain({ shadowColor })} />
          <div className="field">
            <label className="row-label">
              <span>Sombra</span>
              <b className="val">{Math.round((d.shadow ?? d.outline / 2) * 1000)}</b>
            </label>
            <input className="range" type="range" min={0} max={0.015} step={0.0005} value={d.shadow ?? d.outline / 2} onChange={(e) => plain({ shadow: Number(e.target.value) })} aria-label="Sombra" />
          </div>
          <div className="seg" style={{ marginBottom: 14 }}>
            <button className={d.uppercase ? 'on' : ''} aria-pressed={d.uppercase} onClick={() => plain({ uppercase: !d.uppercase })}>
              MAIÚSCULAS
            </button>
            <button className={d.box ? 'on' : ''} aria-pressed={d.box} onClick={() => plain({ box: !d.box })}>
              Caixa
            </button>
            <button className={d.glow ? 'on' : ''} aria-pressed={Boolean(d.glow)} onClick={() => plain({ glow: !d.glow })}>
              Brilho
            </button>
          </div>
          {d.box && <ColorField label="Cor da caixa" value={d.boxColor ?? '#000000'} onChange={(boxColor) => plain({ boxColor })} />}
          {d.anim === 'marker' && <ColorField label="Cor do marcador" value={d.marker ?? d.highlight} onChange={(marker) => plain({ marker })} />}
        </>
      )}
      {err && <p className="form-error">{err}</p>}
      <div className="row">
        <button className="btn primary" disabled={saving} onClick={() => void save()}>
          <Icon name="save" /> Guardar estilo
        </button>
        <button className="btn ghost" onClick={() => onClose()}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

/** The caption the Captions page works on: the selected text clip. */
export function useSelectedCaption(): Clip | null {
  return useEditor((s) => {
    const f = s.selected ? findClip(s.project, s.selected) : null;
    return f && f.track.kind === 'text' ? f.clip : null;
  });
}

/** Every caption style for pickers: app presets, then saved styles (store + embedded in the project). */
export function useStyleOptions(): [string, string][] {
  const userStyles = useEditor((s) => s.userStyles);
  const embedded = useEditor((s) => s.project.styles);
  return useMemo(() => {
    const saved = Object.entries({ ...embedded, ...userStyles }).filter(([k]) => !STYLES[k]);
    return [...Object.entries(STYLES), ...saved].map(([k, v]) => [k, v.label] as [string, string]);
  }, [userStyles, embedded]);
}
