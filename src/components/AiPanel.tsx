// IA panel: eight one-click tools as animated cards (approved mock docs/design/ia-resolve-mock.png).
// The ▶ on a card runs it with its defaults; a click on the card opens its options below the grid.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useEditor } from '../store';
import { Icon } from './Icon';
import { STYLES, parseSrt } from '../lib/project';
import { CUT_PACES, SAFE_ZONES } from '../lib/autoedit.js';
import type { SafeZoneId, SplitLayout, Suggestion } from '../lib/autoedit.js';
import { AUTO_STEPS, applySuggestions, autoColor, autoEdit, cutBreaths, isRecording, splitScreen, startVoice, stopVoice, suggestEdits, transcribeAll, voiceCommand } from '../aiTools';
import type { AutoStep, Pace } from '../aiTools';

type CardId = 'auto' | 'voice' | 'texts' | 'transcribe' | 'cut' | 'color' | 'zoom' | 'frame';

const S = () => useEditor.getState();

/** The little looping drawings at the top of each card (SVG + CSS animation, gold accent). */
function Art({ id }: { id: CardId }) {
  switch (id) {
    case 'auto':
      return (
        <svg viewBox="0 0 160 70" className="ai-art">
          <rect x="14" y="10" width="34" height="8" rx="2" className="g" />
          <rect x="52" y="10" width="20" height="8" rx="2" className="g2" />
          <rect x="76" y="10" width="54" height="8" rx="2" className="d" />
          <rect x="14" y="24" width="44" height="8" rx="2" className="ok" />
          <rect x="62" y="24" width="40" height="8" rx="2" className="d" />
          <rect x="14" y="38" width="110" height="6" rx="2" className="d" />
          <rect x="14" y="50" width="80" height="6" rx="2" className="d" />
          <line x1="66" y1="4" x2="66" y2="64" className="ph a-scan" />
          <path d="M140 34l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" className="g a-twinkle" />
        </svg>
      );
    case 'voice':
      return (
        <svg viewBox="0 0 160 70" className="ai-art">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <rect key={i} x={30 + i * 9} y={18} width="4" height="26" rx="2" className="g a-bar" style={{ animationDelay: `${i * 0.12}s` }} />
          ))}
          <rect x="44" y="30" width="14" height="22" rx="7" className="g" />
          <path d="M40 46a11 11 0 0 0 22 0M51 57v7" className="gs" />
          <rect x="94" y="20" width="52" height="18" rx="9" className="gs" />
          <text x="120" y="33" className="t">cortar</text>
        </svg>
      );
    case 'texts':
      return (
        <svg viewBox="0 0 160 70" className="ai-art">
          <rect x="58" y="4" width="44" height="64" rx="6" className="d" />
          <circle cx="80" cy="24" r="8" className="d2" />
          <rect x="68" y="34" width="24" height="12" rx="4" className="d2" />
          <rect x="64" y="48" width="32" height="7" rx="2" className="g a-pop" />
          <rect x="70" y="58" width="20" height="4" rx="2" className="ok" />
        </svg>
      );
    case 'transcribe':
      return (
        <svg viewBox="0 0 160 70" className="ai-art">
          {[10, 22, 14, 28, 18, 24, 12].map((h, i) => (
            <rect key={i} x={18 + i * 6} y={35 - h / 2} width="3" height={h} rx="1.5" className="b a-bar" style={{ animationDelay: `${i * 0.1}s` }} />
          ))}
          <path d="M70 35h18M83 30l5 5-5 5" className="gs" />
          <rect x="98" y="18" width="46" height="6" rx="3" className="w a-type" />
          <rect x="98" y="30" width="38" height="6" rx="3" className="d2 a-type" style={{ animationDelay: '0.3s' }} />
          <rect x="98" y="42" width="30" height="6" rx="3" className="g a-type" style={{ animationDelay: '0.6s' }} />
        </svg>
      );
    case 'cut':
      return (
        <svg viewBox="0 0 160 70" className="ai-art">
          {[14, 24, 18, 10].map((h, i) => (
            <rect key={i} x={16 + i * 7} y={35 - h / 2} width="3" height={h} rx="1.5" className="d2" />
          ))}
          <rect x="48" y="16" width="16" height="38" rx="2" className="br a-gone" />
          <text x="56" y="12" className="t s">silêncio</text>
          {[18, 26, 12, 22].map((h, i) => (
            <rect key={i} x={72 + i * 7} y={35 - h / 2} width="3" height={h} rx="1.5" className="d2" />
          ))}
          <g className="gs a-snip">
            <circle cx="122" cy="26" r="5" />
            <circle cx="122" cy="44" r="5" />
            <path d="M126 29l14 14M126 41l14-14" />
          </g>
        </svg>
      );
    case 'color':
      return (
        <svg viewBox="0 0 160 70" className="ai-art">
          <rect x="16" y="10" width="50" height="50" rx="4" className="d2" />
          <circle cx="41" cy="30" r="8" className="d" />
          <rect x="94" y="10" width="50" height="50" rx="4" className="g a-warm" />
          <circle cx="119" cy="30" r="8" className="g3" />
          <line x1="80" y1="6" x2="80" y2="64" className="ph" />
          <path d="M80 36l5 8-5 6-5-6z" className="g" />
        </svg>
      );
    case 'zoom':
      return (
        <svg viewBox="0 0 160 70" className="ai-art">
          <rect x="30" y="8" width="100" height="54" rx="5" className="d" />
          <path d="M52 22h-6v26h6" className="gs" />
          <g className="a-zoom">
            <circle cx="96" cy="33" r="9" className="gs" />
            <path d="M103 40l7 7" className="gs" />
          </g>
        </svg>
      );
    case 'frame':
      return (
        <svg viewBox="0 0 160 70" className="ai-art">
          <rect x="62" y="2" width="36" height="66" rx="5" className="d" />
          <rect x="66" y="8" width="28" height="52" rx="2" className="okd a-dash" />
          <line x1="58" y1="35" x2="102" y2="35" className="gl" />
        </svg>
      );
  }
}

const CARDS: { id: CardId; tag: string; title: string; badge?: 'IA' | 'NOVO'; text: string }[] = [
  { id: 'auto', tag: 'AUTOMÁTICO', title: 'Editar sozinho', badge: 'IA', text: '1 clique e corta, nivela a voz, corrige a cor, legenda e dá zoom. Tu só aprovas.' },
  { id: 'voice', tag: 'VOZ', title: 'Comando de voz', badge: 'NOVO', text: 'Controla o Cinemex a falar: cortar, legendar, zoom. Sem mãos.' },
  { id: 'texts', tag: 'LEGENDA', title: '+100 textos animados', text: 'Legenda animada aplicada em 1 clique. O que prende o scroll.' },
  { id: 'transcribe', tag: 'ÁUDIO', title: 'Transcrição automática', text: 'O áudio vira legenda no tempo certo. Ou importa um SRT e anima-o.' },
  { id: 'cut', tag: 'CORTE', title: 'Corte de respiros + Auto Cut', text: 'Deteta silêncios e junta os cortes, sem comer o início nem o fim das palavras.' },
  { id: 'color', tag: 'COR', title: 'Correção de cor', badge: 'IA', text: 'Analisa a imagem e acerta balanço de brancos e tons sozinho.' },
  { id: 'zoom', tag: 'DINÂMICA', title: 'Zoom e sugerir edição', text: 'Lê a timeline e mete zooms e títulos nos melhores momentos.' },
  { id: 'frame', tag: 'ENQUADRE', title: 'Safe zone e tela dividida', text: 'Guia da área segura e duas cenas no mesmo quadro, formato de reels.' },
];

/** Runs a tool and shows its error in the status line instead of losing it. */
function useRun() {
  const [busy, setBusy] = useState<CardId | null>(null);
  const run = (id: CardId, fn: () => Promise<unknown> | unknown) => async () => {
    if (busy) return;
    setBusy(id);
    try {
      await fn();
    } catch (e) {
      S().setStatus((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

const styleOptions = () => Object.entries(STYLES).map(([id, st]) => ({ id, label: st.label ?? id }));

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg ai-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="ai-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function AiPanel() {
  const [open, setOpen] = useState<CardId | null>(null);
  const { busy, run } = useRun();
  const [style, setStyle] = useState('elite');
  const [pace, setPace] = useState<Pace>('normal');
  const [steps, setSteps] = useState<AutoStep[]>(AUTO_STEPS.map((s) => s.id));
  const [stepAt, setStepAt] = useState<number | null>(null);
  const [onlySel, setOnlySel] = useState(false);
  const [sugs, setSugs] = useState<(Suggestion & { on: boolean })[]>([]);
  const [layout, setLayout] = useState<SplitLayout>('top-bottom');
  const [ratio, setRatio] = useState(0.5);
  const [typed, setTyped] = useState('');
  const [rec, setRec] = useState(false);
  const [heard, setHeard] = useState<string | null>(null);
  const safeZone = useEditor((s) => s.safeZone);
  const selected = useEditor((s) => s.selected);
  const styles = useMemo(styleOptions, []);

  // Ctrl+Shift+V: start / stop the voice command from anywhere.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyV') {
        e.preventDefault();
        void toggleVoice();
      }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  });

  const toggleVoice = async () => {
    try {
      if (isRecording()) {
        setRec(false);
        const r = await stopVoice();
        if (r) setHeard(r.said ? `"${r.said}" → ${r.say}` : r.say);
      } else {
        await startVoice();
        setRec(true);
      }
    } catch (e) {
      setRec(false);
      S().setStatus(`Microfone: ${(e as Error).message}`);
    }
  };

  const defaults: Record<CardId, () => Promise<unknown> | unknown> = {
    auto: () => autoEdit({ steps, pace, style, onStep: (i) => setStepAt(i) }).finally(() => setStepAt(null)),
    voice: toggleVoice,
    texts: () => S().setPage('captions'),
    transcribe: () => transcribeAll(style),
    cut: () => cutBreaths(pace, onlySel && selected ? selected : undefined),
    color: () => autoColor(onlySel && selected ? [selected] : undefined),
    zoom: async () => setSugs((await suggestEdits(6)).map((s) => ({ ...s, on: true }))),
    frame: () => S().setSafeZone(safeZone ? null : 'reels'),
  };

  const importSrt = async () => {
    const f = await window.ec.openText('srt');
    if (!f) return;
    const list = parseSrt(f.content);
    if (!list.length) return S().setStatus('Este ficheiro não tem legendas SRT');
    S().addCaptions(list, true, style);
    S().setStatus(`${list.length} legendas importadas com o estilo ${STYLES[style]?.label ?? style}`);
  };

  const options: Record<CardId, ReactNode> = {
    auto: (
      <>
        <div className="ai-steps">
          {AUTO_STEPS.map((s, i) => (
            <label key={s.id} className={`ai-check${stepAt === i ? ' now' : ''}${stepAt !== null && i < stepAt ? ' done' : ''}`}>
              <input type="checkbox" checked={steps.includes(s.id)} onChange={(e) => setSteps((l) => (e.target.checked ? [...l, s.id] : l.filter((x) => x !== s.id)))} />
              {s.label}
            </label>
          ))}
        </div>
        <Field label="Ritmo dos cortes">
          <Seg value={pace} onChange={setPace} label="Ritmo" options={Object.entries(CUT_PACES).map(([k, v]) => [k as Pace, v.label])} />
        </Field>
        <Field label="Estilo das legendas">
          <select className="select" value={style} onChange={(e) => setStyle(e.target.value)}>
            {styles.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <p className="ai-note">Tudo fica num só passo: Ctrl+Z desfaz a edição inteira.</p>
      </>
    ),
    voice: (
      <>
        <button className={`btn ai-mic${rec ? ' rec' : ''}`} onClick={() => void toggleVoice()} aria-pressed={rec}>
          <span className="dot" /> {rec ? 'A ouvir… clica para parar' : 'Falar (Ctrl+Shift+V)'}
        </button>
        <form
          className="ai-say"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) void run('voice', async () => setHeard((await voiceCommand(typed.trim())).say))();
          }}
        >
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder='ou escreve: "corta aqui e mete zoom"' aria-label="Comando escrito" />
          <button className="btn sm" type="submit" disabled={!typed.trim()}>
            Fazer
          </button>
        </form>
        {heard && <p className="ai-note">{heard}</p>}
        <p className="ai-note">A voz é transcrita no teu PC (Whisper). O Claude só recebe o texto e a lista de clips.</p>
      </>
    ),
    texts: (
      <>
        <p className="ai-note">Abre a galeria de estilos na página Legendas: escolhe um e aplica-se a todas as legendas.</p>
        <button className="btn sm" onClick={() => S().setPage('captions')}>
          Abrir a galeria
        </button>
      </>
    ),
    transcribe: (
      <>
        <Field label="Estilo">
          <select className="select" value={style} onChange={(e) => setStyle(e.target.value)}>
            {styles.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="ai-row">
          <button className="btn sm primary" onClick={run('transcribe', () => transcribeAll(style))}>
            Legendar o vídeo
          </button>
          <button className="btn sm" onClick={() => void importSrt()}>
            Importar SRT
          </button>
        </div>
      </>
    ),
    cut: (
      <>
        <Field label="Ritmo">
          <Seg value={pace} onChange={setPace} label="Ritmo" options={Object.entries(CUT_PACES).map(([k, v]) => [k as Pace, `${v.label} · ${v.minPause}s`])} />
        </Field>
        <label className="ai-check">
          <input type="checkbox" checked={onlySel} onChange={(e) => setOnlySel(e.target.checked)} /> Só o clip escolhido
        </label>
        <p className="ai-note">Usa as palavras do Whisper e o nível do som: as pontas das palavras ficam sempre.</p>
      </>
    ),
    color: (
      <>
        <label className="ai-check">
          <input type="checkbox" checked={onlySel} onChange={(e) => setOnlySel(e.target.checked)} /> Só o clip escolhido
        </label>
        <p className="ai-note">Balanço de brancos e tons a partir de um frame de cada clip. Afinas depois na página Cor.</p>
      </>
    ),
    zoom: (
      <>
        {!sugs.length && <p className="ai-note">O Claude lê a fala da timeline e propõe zooms e títulos. Vês a lista antes de aplicar.</p>}
        {sugs.length > 0 && (
          <ul className="ai-sugs">
            {sugs.map((s, i) => (
              <li key={i}>
                <label className="ai-check">
                  <input type="checkbox" checked={s.on} onChange={(e) => setSugs((l) => l.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
                  <b>{s.t.toFixed(1)}s</b> <span className={`ai-kind k-${s.kind}`}>{s.kind === 'punch' ? 'Punch' : s.kind === 'zoom_in' ? 'Zoom lento' : `Título "${s.text}"`}</span>
                </label>
                <button className="btn ghost sm" onClick={() => S().seek(s.t)} title="Ver na timeline">
                  Ver
                </button>
                {s.why && <small>{s.why}</small>}
              </li>
            ))}
          </ul>
        )}
        <div className="ai-row">
          <button className="btn sm" onClick={run('zoom', defaults.zoom)}>
            {sugs.length ? 'Analisar outra vez' : 'Analisar'}
          </button>
          {sugs.length > 0 && (
            <button className="btn sm primary" onClick={run('zoom', async () => (await applySuggestions(sugs.filter((s) => s.on)), setSugs([])))}>
              Aplicar {sugs.filter((s) => s.on).length}
            </button>
          )}
        </div>
      </>
    ),
    frame: (
      <>
        <Field label="Safe zone (só no visor)">
          <Seg value={(safeZone ?? 'off') as SafeZoneId | 'off'} onChange={(v) => S().setSafeZone(v === 'off' ? null : v)} label="Safe zone" options={[['off', 'Não'], ...Object.entries(SAFE_ZONES).map(([k, v]) => [k as SafeZoneId, v.label.split(' ').pop()!] as [SafeZoneId, string])]} />
        </Field>
        <Field label="Tela dividida">
          <Seg value={layout} onChange={setLayout} label="Divisão" options={[['top-bottom', 'Cima / baixo'], ['left-right', 'Esquerda / direita']]} />
        </Field>
        <Field label={`Tamanho do primeiro: ${Math.round(ratio * 100)}%`}>
          <input className="range" type="range" min={0.3} max={0.7} step={0.05} value={ratio} onChange={(e) => setRatio(Number(e.target.value))} aria-label="Tamanho do primeiro" />
        </Field>
        <button className="btn sm primary" disabled={!selected} onClick={run('frame', () => splitScreen(layout, ratio))} title={selected ? 'O clip escolhido fica em cima / à esquerda; o outro é o que toca ao mesmo tempo noutra pista' : 'Escolhe primeiro um clip'}>
          Dividir com o clip da outra pista
        </button>
      </>
    ),
  };

  return (
    <aside className="panel ai-panel" aria-label="IA">
      <div className="panel-body">
        <div className="ai-grid">
          {CARDS.map((c, i) => (
            <div key={c.id} className={`ai-card${open === c.id ? ' open' : ''}${busy === c.id || (c.id === 'voice' && rec) ? ' busy' : ''}`}>
              <button className="ai-hit" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id} aria-label={`${c.title}: opções`} />
              <div className="ai-top">
                <span className="ai-tag">
                  <b>CLIP {String(i + 1).padStart(2, '0')}</b> {c.tag}
                </span>
                <button className="ai-play" onClick={run(c.id, defaults[c.id])} title={`${c.title}: correr`} aria-label={`Correr ${c.title}`}>
                  {busy === c.id ? <span className="spin" /> : <Icon name="play" />}
                </button>
                <Art id={c.id} />
              </div>
              <div className="ai-body">
                <h3>
                  {c.title} {c.badge && <span className="ai-badge">{c.badge}</span>}
                </h3>
                <p>{c.text}</p>
              </div>
            </div>
          ))}
        </div>
        {open && (
          <section className="ai-opts" aria-label={`Opções: ${CARDS.find((c) => c.id === open)!.title}`}>
            <div className="ai-opts-h">
              <strong>{CARDS.find((c) => c.id === open)!.title}</strong>
              <button className="btn icon ghost" onClick={() => setOpen(null)} aria-label="Fechar opções">
                <Icon name="close" />
              </button>
            </div>
            {options[open]}
            {open !== 'zoom' && open !== 'voice' && open !== 'texts' && open !== 'transcribe' && open !== 'frame' && (
              <button className="btn primary ai-go" onClick={run(open, defaults[open])} disabled={busy !== null}>
                {busy === open ? 'A trabalhar…' : 'Correr'}
              </button>
            )}
          </section>
        )}
      </div>
    </aside>
  );
}
