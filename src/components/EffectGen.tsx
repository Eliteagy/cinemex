// "Gerador de efeitos": write the effect you want, Claude, Gemini and ChatGPT each make one (a recipe
// of the editor's own tools), see each one on the video, keep the best in the effects library.
import { useEffect, useMemo, useState } from 'react';
import { useEditor } from '../store';
import { keepTry, runRecipe, tryRecipe, undoTry } from '../effectRecipes';
import { findClip } from '../lib/project';
import { Icon } from './Icon';
import { viewerShot } from '../lib/viewerShot';
import { mediaUrl } from '../lib/project';
import type { EffectCategory, EffectProvider, EffectRecipe, EffectResult } from '../types';

const CATS: [EffectCategory, string, string][] = [
  ['fusion', 'Vídeo', 'brilho dourado com grão de filme e barras de cinema'],
  ['legendas', 'Legendas', 'palavras a saltar com brilho amarelo, estilo TikTok'],
  ['titulos', 'Títulos', 'cartão de preço do imóvel a entrar de baixo com fundo escuro'],
  ['movimento', 'Movimento', 'zoom lento para dentro com um punch no fim'],
];
const PROVIDERS: [EffectProvider, string][] = [
  ['claude', 'Claude'],
  ['gemini', 'Gemini'],
  ['gpt', 'ChatGPT'],
];
const CAT_LABEL = Object.fromEntries(CATS.map(([k, l]) => [k, l])) as Record<EffectCategory, string>;

type Lib = EffectRecipe & { id: string; created: string; thumb?: string };

export function EffectGenPanel() {
  const canvas = useEditor((s) => s.project.canvas);
  const selected = useEditor((s) => s.selected);
  const setStatus = useEditor((s) => s.setStatus);
  const [cat, setCat] = useState<EffectCategory>('fusion');
  const [text, setText] = useState('');
  const [use, setUse] = useState<Set<EffectProvider>>(new Set(['claude', 'gemini', 'gpt']));
  const [results, setResults] = useState<Partial<Record<EffectProvider, EffectResult | 'busy'>>>({});
  const [busy, setBusy] = useState(false);
  const [trying, setTrying] = useState<EffectProvider | null>(null);
  const [lib, setLib] = useState<Lib[]>([]);
  const [libCat, setLibCat] = useState<EffectCategory | 'all'>('all');
  const [refImg, setRefImg] = useState<string | null>(null);

  const loadLib = async () => setLib(await window.ec.listEffects());
  useEffect(() => {
    void loadLib();
    return window.ec.onEffectResult((r) => setResults((x) => ({ ...x, [r.provider]: r })));
  }, []);

  const clipDuration = useMemo(() => {
    const f = selected ? findClip(useEditor.getState().project, selected) : null;
    return f ? f.clip.out - f.clip.in : undefined;
  }, [selected]);

  const generate = async () => {
    const providers = PROVIDERS.map(([p]) => p).filter((p) => use.has(p));
    if (!providers.length) return setStatus('Escolhe pelo menos uma IA');
    const request = text.trim() || (refImg ? '' : CATS.find(([k]) => k === cat)![2]);
    setBusy(true);
    setTrying(null);
    setResults(Object.fromEntries(providers.map((p) => [p, 'busy'])));
    try {
      await window.ec.generateEffects(cat, request, { providers, canvas: { w: canvas.w, h: canvas.h }, clipDuration, imagePath: refImg ?? undefined });
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const tryOne = async (p: EffectProvider, r: EffectRecipe) => {
    try {
      await tryRecipe(r);
      setTrying(p);
      setStatus(`A ver «${r.name}» (${PROVIDERS.find(([k]) => k === p)?.[1]})`);
    } catch (e) {
      setTrying(null);
      setStatus((e as Error).message);
    }
  };
  const save = async (r: EffectRecipe, onScreen: boolean) => {
    try {
      const s = await window.ec.saveEffect(r, undefined, onScreen ? viewerShot() : null);
      await loadLib();
      setStatus(`«${s.name}» guardado na biblioteca`);
    } catch (e) {
      setStatus((e as Error).message);
    }
  };
  const apply = async (r: Lib) => {
    try {
      keepTry();
      await runRecipe(r);
      setStatus(`«${r.name}» aplicado`);
    } catch (e) {
      setStatus((e as Error).message);
    }
  };
  const remove = async (r: Lib) => {
    if (!confirm(`Apagar «${r.name}» da biblioteca?`)) return;
    await window.ec.deleteEffect(r.id);
    await loadLib();
  };
  const shown = lib.filter((e) => libCat === 'all' || e.category === libCat);

  return (
    <aside className="panel eg" aria-label="Gerador de efeitos">
      <div className="panel-body">
        <p className="panel-sub">Escreve o efeito. Claude, Gemini e ChatGPT fazem cada um a sua versão; vês as três no vídeo e guardas a melhor.</p>
        <div className="seg sm" role="radiogroup" aria-label="Tipo de efeito">
          {CATS.map(([k, l]) => (
            <button key={k} className={cat === k ? 'on' : ''} onClick={() => setCat(k)}>
              {l}
            </button>
          ))}
        </div>
        <textarea className="input eg-text" rows={3} value={text} maxLength={600} placeholder={`Ex.: ${CATS.find(([k]) => k === cat)![2]}`} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && void generate()} />
        <div className="eg-row">
          {refImg ? (
            <span className="eg-ref">
              <img src={mediaUrl(refImg)} alt="Imagem de referência" />
              <button className="btn sm" onClick={() => setRefImg(null)} title="Tirar a imagem">
                ✕
              </button>
            </span>
          ) : (
            <button className="btn sm" onClick={() => void window.ec.pickEffectImage().then((f) => f && setRefImg(f))} title="Um print de um vídeo de que gostes: as IAs copiam o look">
              Imagem de referência
            </button>
          )}
        </div>
        <div className="eg-row">
          {PROVIDERS.map(([p, l]) => (
            <label key={p} className="sh-check">
              <input
                type="checkbox"
                checked={use.has(p)}
                onChange={(e) =>
                  setUse((s) => {
                    const n = new Set(s);
                    if (e.target.checked) n.add(p);
                    else n.delete(p);
                    return n;
                  })
                }
              />{' '}
              {l}
            </label>
          ))}
          <span className="spacer" />
          {busy ? (
            <button className="btn sm" onClick={() => void window.ec.cancelEffects()}>
              Parar
            </button>
          ) : (
            <button className="btn primary sm" onClick={() => void generate()} title="Ctrl+Enter">
              <Icon name="spark" /> Gerar
            </button>
          )}
        </div>
        {(cat === 'fusion' || cat === 'movimento') && <p className="panel-sub">Vai para o clip selecionado (ou o que está debaixo da cabeça de leitura).</p>}

        {Object.keys(results).length > 0 && (
          <div className="eg-results">
            {PROVIDERS.filter(([p]) => results[p]).map(([p, l]) => {
              const r = results[p]!;
              return (
                <div key={p} className={`eg-card${trying === p ? ' on' : ''}`}>
                  <div className="eg-head">
                    <b>{l}</b>
                    {r !== 'busy' && <span className="panel-sub">{Math.round(r.ms / 1000)} s</span>}
                  </div>
                  {r === 'busy' && <p className="panel-sub">A gerar…</p>}
                  {r !== 'busy' && !r.ok && <p className="eg-err">{r.error}</p>}
                  {r !== 'busy' && r.ok && r.recipe && (
                    <>
                      <div className="eg-name">{r.recipe.name}</div>
                      {r.recipe.description && <p className="panel-sub">{r.recipe.description}</p>}
                      <details>
                        <summary className="panel-sub">{r.recipe.steps.length} passos</summary>
                        <ol className="eg-steps">
                          {r.recipe.steps.map((s, i) => (
                            <li key={i}>
                              <code>{s.tool}</code> {JSON.stringify(s.args).slice(0, 140)}
                            </li>
                          ))}
                        </ol>
                      </details>
                      <div className="row">
                        <button className={`btn sm${trying === p ? ' primary' : ''}`} onClick={() => void tryOne(p, r.recipe!)} title="Põe este efeito no vídeo (ver outro tira este)">
                          {trying === p ? 'A ver' : 'Ver'}
                        </button>
                        <button className="btn sm" onClick={() => void save(r.recipe!, trying === p)} title="Guardar na biblioteca de efeitos (com miniatura se estiver a ver este)">
                          <Icon name="save" /> Guardar
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {trying && (
          <div className="row">
            <button
              className="btn sm primary"
              onClick={() => {
                keepTry();
                setTrying(null);
                setStatus('Efeito aplicado');
              }}
            >
              Ficar com este
            </button>
            <button
              className="btn sm"
              onClick={() => {
                undoTry();
                setTrying(null);
              }}
            >
              Tirar
            </button>
          </div>
        )}

        <div className="field" style={{ marginTop: 16 }}>
          <label className="row-label">
            <span>Biblioteca de efeitos</span>
            <span className="panel-sub">{lib.length} guardados</span>
          </label>
          <div className="seg sm" role="radiogroup" aria-label="Filtrar">
            <button className={libCat === 'all' ? 'on' : ''} onClick={() => setLibCat('all')}>
              Todos
            </button>
            {CATS.map(([k, l]) => (
              <button key={k} className={libCat === k ? 'on' : ''} onClick={() => setLibCat(k)}>
                {l}
              </button>
            ))}
          </div>
          {!shown.length && <p className="panel-sub">Ainda não guardaste efeitos{libCat !== 'all' ? ' deste tipo' : ''}.</p>}
          <div className="eg-lib">
            {shown.map((e) => (
              <div key={e.id} className="eg-item" title={e.prompt ? `Pedido: ${e.prompt}` : undefined}>
                {e.thumb ? <img className="eg-thumb" src={mediaUrl(e.thumb)} alt="" /> : <span className="eg-thumb" />}
                <div className="eg-item-text">
                  <b>{e.name}</b>
                  <span className="panel-sub">
                    {CAT_LABEL[e.category]}
                    {e.provider ? ` · ${PROVIDERS.find(([k]) => k === e.provider)?.[1]}` : ''}
                  </span>
                </div>
                <button className="btn sm" onClick={() => void apply(e)}>
                  Aplicar
                </button>
                <button className="btn sm icon" aria-label={`Apagar ${e.name}`} onClick={() => void remove(e)}>
                  <Icon name="trash" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}
