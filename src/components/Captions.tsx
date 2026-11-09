// "Legendas" page: every caption in a list (edit text and timing, jump to it) on the left,
// the caption style on the right. SRT import/export for YouTube, Instagram and translators.
import { useMemo, useState } from 'react';
import { useEditor } from '../store';
import { STYLES, baseStyle, end, fmtTime, parseSrt, r3, styleOf, toSrt } from '../lib/project';
import type { CaptionStyle } from '../types';
import { MY_STYLE_ID } from '../lib/capstyle.js';
import { CaptionLook, StyleEditor, useSelectedCaption } from './CaptionStyleEditor';
import { AutoSubsPanel } from './AutoSubs';
import { keywordOf, pickKeyword } from '../lib/emphasis.js';
import type { Clip } from '../types';
import { CaptionBlocks } from './CaptionBlocks';
import { Icon } from './Icon';

export function CaptionList() {
  const tracks = useEditor((s) => s.project.tracks);
  const clips = useMemo(() => tracks.filter((t) => t.kind === 'text').flatMap((t) => t.clips).sort((a, b) => a.start - b.start), [tracks]);
  const selected = useEditor((s) => s.selected);
  const playhead = useEditor((s) => s.playhead);
  const project = useEditor((s) => s.project);
  const userStyles = useEditor((s) => s.userStyles);
  const fps = useEditor((s) => s.project.canvas.fps);
  const [q, setQ] = useState('');
  const s = () => useEditor.getState();
  const shown = q ? clips.filter((c) => c.text?.toLowerCase().includes(q.toLowerCase())) : clips;

  const importSrt = async () => {
    const f = await window.ec.openText('srt');
    if (!f) return;
    const list = parseSrt(f.content);
    if (!list.length) return s().setStatus('Este ficheiro não tem legendas SRT');
    // Replaces the current captions (Ctrl+Z brings them back).
    s().addCaptions(list, true);
    s().setStatus(`${list.length} legendas importadas (Ctrl+Z desfaz)`);
  };
  const exportSrt = async () => {
    const p = await window.ec.saveText(s().project.name, toSrt(s().project), 'srt');
    if (p) s().setStatus(`Legendas guardadas: ${p}`);
  };

  return (
    <aside className="panel" aria-label="Lista de legendas">
      <div className="ph">
        Legendas <span className="count">{clips.length}</span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => void importSrt()} title="Importar .srt">
          <Icon name="import" /> SRT
        </button>
        <button className="btn sm" disabled={!clips.length} onClick={() => void exportSrt()} title="Exportar .srt">
          <Icon name="export" /> SRT
        </button>
      </div>
      <div className="panel-body cap-tools">
        <input className="input" placeholder="Procurar nas legendas" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <AutoSubsPanel />
      <div className="cap-list">
        {!shown.length && <p className="panel-sub pad">{clips.length ? 'Nada encontrado.' : 'Ainda não há legendas. Abre Legendas automáticas (Whisper no teu PC) ou importa um SRT.'}</p>}
        {shown.map((c) => {
          const live = playhead >= c.start && playhead < end(c);
          return (
            <div key={c.id} className={`cap${selected === c.id ? ' sel' : ''}${live ? ' live' : ''}`} onClick={() => (s().select(c.id), s().seek(c.start + 0.001))}>
              <div className="cap-time">
                <input className="input tc" type="number" step={0.05} value={r3(c.start)} aria-label="Início" onClick={(e) => e.stopPropagation()} onChange={(e) => e.target.value !== '' && s().moveClip(c.id, Number(e.target.value))} />
                <span>{fmtTime(c.start, fps).slice(3)}</span>
                <input
                  className="input tc"
                  type="number"
                  step={0.05}
                  value={r3(end(c) - c.start)}
                  aria-label="Duração"
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => e.target.value !== '' && s().updateClip(c.id, { in: 0, out: Math.max(0.1, Number(e.target.value)) })}
                />
              </div>
              <textarea
                className="textarea"
                rows={2}
                value={c.text ?? ''}
                onClick={(e) => e.stopPropagation()}
                onFocus={() => (s().select(c.id), s().seek(c.start + 0.001))}
                onChange={(e) => s().updateClip(c.id, { text: e.target.value, words: undefined })}
              />
              <button className="btn icon sm" title="Apagar" onClick={(e) => (e.stopPropagation(), s().deleteClip(c.id))}>
                <Icon name="trash" />
              </button>
              {selected === c.id && Boolean(styleOf(c, project, userStyles).emphasis) && <KeywordPicker clip={c} />}
              {selected === c.id && (
                <button className="btn sm ghost join" title="Junta esta legenda com a seguinte (mais palavras de uma vez)" onClick={(e) => (e.stopPropagation(), s().mergeCaptionWithNext(c.id) ? s().setStatus('Legendas juntas (Ctrl+Z desfaz)') : s().setStatus('Não há legenda a seguir'))}>
                  Juntar com a seguinte
                </button>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/** Felipe/Marta captions: click a word to make it the keyword (automatic = the longest content word). */
function KeywordPicker({ clip }: { clip: Clip }) {
  const words = clip.words?.length ? clip.words.map((w) => w.w) : (clip.text ?? '').split(/\s+/).filter(Boolean);
  const kw = keywordOf(clip, words);
  const auto = !Number.isInteger(clip.keyword);
  const set = (k: number | undefined) => useEditor.getState().updateClip(clip.id, { keyword: k });
  return (
    <div className="kw-pick" onClick={(e) => e.stopPropagation()}>
      <span className="panel-sub">Palavra em destaque</span>
      <div className="kw-words">
        {words.map((w, i) => (
          <button key={i} className={`kw${i === kw ? ' on' : ''}`} aria-pressed={i === kw} onClick={() => set(i === kw && !auto ? undefined : i)}>
            {w}
          </button>
        ))}
        <button className={`kw ghost${kw < 0 ? ' on' : ''}`} aria-pressed={kw < 0} onClick={() => set(-1)}>
          Sem destaque
        </button>
        <button className={`kw ghost${auto ? ' on' : ''}`} aria-pressed={auto} title={`Automático: ${words[pickKeyword(words)] ?? 'nenhuma'}`} onClick={() => set(undefined)}>
          Automático
        </button>
      </div>
    </div>
  );
}

const BLANK: CaptionStyle = { label: 'Novo estilo', font: 'Inter Black', size: 0.05, color: '#FFFFFF', highlight: '#D4AF37', outline: 0.004, outlineColor: '#000000', box: false, uppercase: false, y: 0.72, anim: 'pop' };

export function CaptionStylePanel() {
  const project = useEditor((s) => s.project);
  const userStyles = useEditor((s) => s.userStyles);
  const sel = useSelectedCaption();
  const first = useEditor((s) => s.project.tracks.find((t) => t.kind === 'text')?.clips[0]?.style ?? 'elite');
  const [editing, setEditing] = useState<{ id: string | null; from: CaptionStyle; n: number } | null>(null);
  const s = () => useEditor.getState();
  const raw = sel?.style ?? first;
  const current = raw === 'custom' ? MY_STYLE_ID : raw;
  // Saved styles: the app's store plus styles embedded in this project (e.g. made on another PC).
  const saved = useMemo(() => Object.entries({ ...project.styles, ...userStyles }).filter(([k]) => !STYLES[k]), [project.styles, userStyles]);
  const blocks: [string, CaptionStyle][] = [...Object.entries(STYLES), ...saved];
  const currentSt = baseStyle({ id: '', start: 0, in: 0, out: 0, style: current }, project, userStyles);
  const isSaved = !STYLES[current];
  const pick = (key: string, only: boolean) => {
    if (only && sel) s().applyCaptionStyle(key, [sel.id]);
    else s().applyCaptionStyle(key, 'all');
  };
  const edit = (id: string | null, from: CaptionStyle) => setEditing({ id, from, n: Date.now() });
  const remove = async () => {
    if (!confirm(`Apagar o estilo «${currentSt.label}»? As legendas que o usam neste projeto continuam iguais.`)) return;
    await s().deleteUserStyle(current);
    s().setStatus(`Estilo «${currentSt.label}» apagado`);
  };
  return (
    <aside className="panel" aria-label="Estilo das legendas">
      <div className="ph">
        Estilo das legendas
        <span className="spacer" />
        <button className="btn sm" onClick={() => edit(null, BLANK)} title="Criar um estilo de legenda novo, em branco">
          <Icon name="plus" /> Novo estilo
        </button>
      </div>
      <div className="panel-body">
        {editing && (
          <StyleEditor
            key={editing.n}
            id={editing.id}
            from={editing.from}
            onClose={(id) => {
              setEditing(null);
              if (id) {
                s().applyCaptionStyle(id, sel && !editing.id ? [sel.id] : 'all');
                s().setStatus('Estilo guardado');
              }
            }}
          />
        )}
        {!editing && sel && <CaptionLook clip={sel} />}
        <div className="field" style={{ marginTop: 16 }}>
          <label className="row-label">
            <span>Estilos</span>
            <span className="panel-sub">Clique: todas · Shift: só a selecionada</span>
          </label>
          <CaptionBlocks styles={blocks} current={current} onPick={pick} />
        </div>
        {!editing && (
          <div className="style-actions">
            <span className="panel-sub">
              «{currentSt.label}» {isSaved ? '· estilo guardado' : '· estilo da app'}
            </span>
            <div className="row">
              {isSaved && (
                <button className="btn sm" onClick={() => edit(current, currentSt)}>
                  Editar
                </button>
              )}
              <button className="btn sm" onClick={() => edit(null, currentSt)} title="Novo estilo a partir deste">
                Duplicar
              </button>
              {isSaved && userStyles[current] && (
                <button className="btn sm danger" onClick={() => void remove()}>
                  <Icon name="trash" /> Apagar
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
