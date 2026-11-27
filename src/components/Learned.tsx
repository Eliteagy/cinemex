// "O que a app aprendeu": the word fixes and big-word choices the app keeps from the Gui's own
// corrections (electron/learn.cjs). Each one can be forgotten.
import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import type { Learned } from '../types';

export function LearnedPanel() {
  const [data, setData] = useState<Learned | null>(null);
  const load = () => void window.ec.learned().then(setData);
  useEffect(load, []);
  if (!data) return null;
  const total = data.words.length + data.keywords.length;
  return (
    <details className="cm-edit learned" onToggle={(e) => (e.currentTarget.open ? load() : undefined)}>
      <summary>O que a app aprendeu ({total})</summary>
      {!total && <p className="panel-sub">Quando corriges uma palavra numa legenda ou escolhes a palavra em destaque, a app aprende e faz igual da próxima vez.</p>}
      {data.words.length > 0 && <p className="panel-sub">Palavras corrigidas</p>}
      <ul>
        {data.words.map((w, i) => (
          <li key={`w${i}`}>
            <s>{w.from}</s> → <b>{w.to}</b> {w.n > 1 && <span className="panel-sub">×{w.n}</span>}
            <button className="btn icon sm" aria-label={`Esquecer ${w.from}`} onClick={() => void window.ec.forget('words', i).then(setData)}>
              <Icon name="trash" />
            </button>
          </li>
        ))}
      </ul>
      {data.keywords.length > 0 && <p className="panel-sub">Palavras em destaque escolhidas</p>}
      <ul>
        {data.keywords.map((k, i) => (
          <li key={`k${i}`}>
            «{k.block}» → <b>{k.word}</b>
            <button className="btn icon sm" aria-label={`Esquecer ${k.word}`} onClick={() => void window.ec.forget('keywords', i).then(setData)}>
              <Icon name="trash" />
            </button>
          </li>
        ))}
      </ul>
      {total > 0 && (
        <button className="btn sm danger" onClick={() => confirm('Esquecer tudo o que a app aprendeu?') && void window.ec.forgetAll().then(setData)}>
          Esquecer tudo
        </button>
      )}
    </details>
  );
}
