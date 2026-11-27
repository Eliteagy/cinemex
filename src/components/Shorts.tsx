// "Shorts e IA" panel (Média page): the VideoCraft features. A long video -> the AI finds the best
// moments -> pick them -> one exported short per moment. Also chapters, caption translation and
// caption checks. Same actions as the MCP tools (src/aiActions.ts).
import { useEffect, useMemo, useState } from 'react';
import { useEditor } from '../store';
import { addWatermark, dubCaptions, aiChapters, checkCaptionTrack, findHotclips, fixCaptionTrack, hotclipState, makeShorts, translateCaptions } from '../aiActions';
import { fmtShort } from '../lib/project';
import type { Hotclip } from '../types';

const STYLES = [
  ['felipe', 'Felipe'],
  ['marta', 'Marta'],
  ['elite', 'Elite'],
  ['clean', 'Limpo'],
] as const;

export function ShortsPanel() {
  const media = useEditor((s) => s.project.media);
  const videos = useMemo(() => media.filter((m) => m.kind === 'video' && m.hasAudio).sort((a, b) => b.duration - a.duration), [media]);
  const [mediaId, setMediaId] = useState<string>('');
  const [count, setCount] = useState(8);
  const [min, setMin] = useState(20);
  const [max, setMax] = useState(60);
  const [context, setContext] = useState('');
  const [clips, setClips] = useState<Hotclip[]>(hotclipState.clips);
  const [pick, setPick] = useState<Set<number>>(new Set(hotclipState.clips.map((_, i) => i)));
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [style, setStyle] = useState('felipe');
  const [reframe, setReframe] = useState<'cover' | 'fit' | 'face'>('face');
  const [cards, setCards] = useState(true);
  const [model, setModel] = useState('vitor');
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    void window.ec.listCaptionModels().then(setModels);
  }, []);
  const behind = Boolean(model);
  const [gpu, setGpu] = useState(true);
  const [progress, setProgress] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const [lang, setLang] = useState('inglês');
  const [bilingual, setBilingual] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]);
  const [voice, setVoice] = useState('');
  const [replace, setReplace] = useState(false);
  const [wm, setWm] = useState('');
  const [corner, setCorner] = useState<'tl' | 'tr' | 'bl' | 'br'>('br');
  const src = mediaId || videos[0]?.id || '';

  useEffect(() => window.ec.onAiProgress((p) => setProgress(p.of > 1 ? `Parte ${p.step} de ${p.of}` : null)), []);
  useEffect(() => window.ec.onShortsProgress((p) => setProgress(`Short ${p.index + 1} de ${p.of} · ${p.status ? `${p.status} · ` : ''}${Math.round(p.progress * 100)} %`)), []);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setErr(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const find = () =>
    run('find', async () => {
      const r = await findHotclips({ mediaId: src, count, min, max, context });
      setClips(r);
      setPick(new Set(r.map((_, i) => i)));
      setDone([]);
    });
  const make = () =>
    run('make', async () => {
      const chosen = clips.filter((_, i) => pick.has(i));
      const out = await makeShorts(chosen, { mediaId: src, style, reframe, model: model || undefined, cards, gpu });
      if (out) setDone(out.map((o) => o.file));
    });

  if (!videos.length)
    return (
      <aside className="panel shorts" aria-label="Shorts e IA">
        <div className="panel-body">
          <p className="panel-sub">Importa um vídeo com som (uma palestra, um podcast, um vlog). A IA encontra os melhores momentos e faz um short de cada um.</p>
        </div>
      </aside>
    );

  return (
    <aside className="panel shorts" aria-label="Shorts e IA">
      <div className="ph">Melhores momentos → shorts</div>
      <div className="panel-body sh-body">
        <label className="field">
          <span className="row-label">Vídeo</span>
          <select className="select" value={src} onChange={(e) => setMediaId(e.target.value)}>
            {videos.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {fmtShort(m.duration)}
                {m.transcript ? '' : ' (por transcrever)'}
              </option>
            ))}
          </select>
        </label>
        <div className="sh-nums">
          <label>
            Quantos
            <input className="input" type="number" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value) || 8)} />
          </label>
          <label>
            Mín. (s)
            <input className="input" type="number" min={5} max={170} value={min} onChange={(e) => setMin(Number(e.target.value) || 20)} />
          </label>
          <label>
            Máx. (s)
            <input className="input" type="number" min={10} max={180} value={max} onChange={(e) => setMax(Number(e.target.value) || 60)} />
          </label>
        </div>
        <textarea className="input sh-ctx" rows={2} placeholder="Contexto (opcional): quem fala, tema, para quem é" value={context} onChange={(e) => setContext(e.target.value)} />
        <div className="row">
          <button className="btn primary" disabled={Boolean(busy)} onClick={find}>
            {busy === 'find' ? 'A procurar…' : 'Encontrar momentos'}
          </button>
          {busy && (
            <button className="btn" onClick={() => void (busy === 'make' ? window.ec.cancelExport() : window.ec.cancelAi())}>
              Cancelar
            </button>
          )}
        </div>
        {progress && <p className="panel-sub">{progress}</p>}
        {err && <p className="sh-err">{err}</p>}

        {clips.length > 0 && (
          <>
            <ol className="sh-list">
              {clips.map((c, i) => (
                <li key={`${c.start}-${i}`} className={pick.has(i) ? 'on' : ''}>
                  <label>
                    <input
                      type="checkbox"
                      checked={pick.has(i)}
                      onChange={() =>
                        setPick((p) => {
                          const n = new Set(p);
                          if (n.has(i)) n.delete(i);
                          else n.add(i);
                          return n;
                        })
                      }
                    />
                    <span className="sh-score">{c.score}</span>
                    <span className="sh-title">{c.title || c.hook}</span>
                    <span className="sh-time">
                      {fmtShort(c.start)} · {Math.round(c.duration)} s
                    </span>
                  </label>
                  <p className="sh-hook">“{c.hook}”</p>
                  <p className="sh-text">{c.text}</p>
                  <p className="sh-why">{c.why}</p>
                  <p className="sh-tags">{c.hashtags.join(' ')}</p>
                </li>
              ))}
            </ol>
            <div className="sh-opts">
              <label>
                Legendas
                <select className="select" value={style} disabled={behind} title={behind ? "Com legendas atrás o estilo é fixo (palavra grande atrás, pequenas à frente)" : undefined} onChange={(e) => setStyle(e.target.value)}>
                  {STYLES.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <div className="seg sm" role="radiogroup" aria-label="Enquadramento">
                <button className={reframe === 'face' ? 'on' : ''} onClick={() => setReframe('face')} title="O corte 9:16 segue a cara de quem está a falar (a primeira vez instala o detetor de caras)">
                  Seguir cara
                </button>
                <button className={reframe === 'cover' ? 'on' : ''} onClick={() => setReframe('cover')} title="Corta ao centro para 9:16">
                  Cortar
                </button>
                <button className={reframe === 'fit' ? 'on' : ''} onClick={() => setReframe('fit')} title="Vídeo inteiro com barras (duas pessoas lado a lado)">
                  Com barras
                </button>
              </div>
              <label title="Modelo de legendas: palavras grandes atrás da pessoa (recorta a pessoa). Sem modelo = o estilo de cima.">
                Modelo
                <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value="">Sem modelo (estilo normal)</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="sh-check">
                <input type="checkbox" checked={cards} onChange={(e) => setCards(e.target.checked)} /> Cartões de gancho e final
              </label>
              <label className="sh-check">
                <input type="checkbox" checked={gpu} onChange={(e) => setGpu(e.target.checked)} /> Exportar com a NVIDIA
              </label>
            </div>
            <button className="btn primary" disabled={Boolean(busy) || !pick.size} onClick={make}>
              {busy === 'make' ? 'A criar…' : `Criar ${pick.size} shorts`}
            </button>
            {done.length > 0 && (
              <div className="sh-done">
                <p>{done.length} shorts prontos, cada um com o projeto Cinemex e o texto para publicar.</p>
                <button className="btn sm" onClick={() => void window.ec.reveal(done[0]!)}>
                  Abrir pasta
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="ph">Capítulos e legendas</div>
      <div className="panel-body sh-body">
        <div className="row">
          <button
            className="btn"
            disabled={Boolean(busy)}
            onClick={() =>
              run('chap', async () => {
                const r = await aiChapters({ mediaId: src });
                setNote(`${r.chapters.length} capítulos marcados na timeline.\n\nTítulos: ${r.titles.join(' / ')}\n\nPara a descrição do YouTube:\n${r.youtube}`);
              })
            }
          >
            {busy === 'chap' ? 'A dividir…' : 'Capítulos com IA'}
          </button>
          <button
            className="btn"
            disabled={Boolean(busy)}
            onClick={() =>
              run('check', async () => {
                const issues = checkCaptionTrack();
                if (!issues.length) return setNote('As legendas estão bem.');
                const fixable = issues.filter((i) => i.fix).length;
                const r = fixable ? fixCaptionTrack() : null;
                setNote(`${issues.length} problemas encontrados.${r ? ` Corrigi ${r.changed} e tirei ${r.removed}.` : ''}${r?.left.length ? ` Falta ver à mão: ${r.left.map((x) => x.msg).slice(0, 4).join('; ')}.` : ''}`);
              })
            }
          >
            Verificar legendas
          </button>
        </div>
        <div className="sh-tr">
          <input className="input" value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Língua" placeholder="Língua (ex.: inglês)" />
          <label className="sh-check">
            <input type="checkbox" checked={bilingual} onChange={(e) => setBilingual(e.target.checked)} /> As duas línguas
          </label>
          <button
            className="btn"
            disabled={Boolean(busy) || !lang.trim()}
            onClick={() =>
              run('tr', async () => {
                const r = await translateCaptions(lang, { mode: bilingual ? 'bilingual' : 'replace' });
                setNote(`${r.captions} legendas traduzidas${r.missing ? `, ${r.missing} ficaram por traduzir` : ''}.`);
              })
            }
          >
            {busy === 'tr' ? 'A traduzir…' : 'Traduzir legendas'}
          </button>
        </div>
        <div className="sh-tr">
          <select className="select" value={voice} onFocus={() => !voices.length && void window.ec.dubVoices().then(setVoices).catch((e: Error) => setErr(e.message))} onChange={(e) => setVoice(e.target.value)} aria-label="Voz">
            <option value="">Voz (por defeito)</option>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          <label className="sh-check">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Tirar o som original
          </label>
          <button
            className="btn"
            disabled={Boolean(busy)}
            onClick={() =>
              run('dub', async () => {
                const r = await dubCaptions({ voiceId: voice || undefined, mode: replace ? 'replace' : 'mix' });
                setNote(`Dobragem na pista "Dobragem": ${r.lines} frases${r.sped ? `, ${r.sped} aceleradas para caber` : ''}${r.overflow ? `, ${r.overflow} passam do tempo` : ''}.`);
              })
            }
          >
            {busy === 'dub' ? 'A gravar vozes…' : 'Dobrar com voz'}
          </button>
        </div>
        <div className="sh-tr">
          <input className="input" value={wm} onChange={(e) => setWm(e.target.value)} placeholder="Marca de água (texto)" aria-label="Marca de água" />
          <select className="select" value={corner} onChange={(e) => setCorner(e.target.value as typeof corner)} aria-label="Canto">
            <option value="br">Canto inf. direito</option>
            <option value="bl">Canto inf. esquerdo</option>
            <option value="tr">Canto sup. direito</option>
            <option value="tl">Canto sup. esquerdo</option>
          </select>
          <button className="btn" disabled={Boolean(busy) || !wm.trim()} onClick={() => run('wm', async () => void (await addWatermark({ text: wm, corner })))}>
            Pôr texto
          </button>
          <button
            className="btn"
            disabled={Boolean(busy)}
            title="Logo em PNG"
            onClick={() =>
              run('wm', async () => {
                const r = await window.ec.importDialog();
                const img = r.media.find((m) => m.kind === 'image');
                if (img) await addWatermark({ image: img.path, corner });
              })
            }
          >
            Pôr logo
          </button>
        </div>
        {note && <pre className="sh-note">{note}</pre>}
      </div>
    </aside>
  );
}
