// Ligação panel: the other computer (who is online, their version, what they have open), sharing a
// project live, updates from GitHub, and the setup (link code, relay address, shared folder).
import { useEffect, useState } from 'react';
import { applyUpdate, checkUpdate, joinInvite, leaveSession, peerColor, shareProject, useCollab } from '../collab';
import { Icon } from './Icon';

const STATE_TEXT = { off: 'Desligado', connecting: 'A ligar…', online: 'Ligado', error: 'Erro na ligação' } as const;

const ago = (iso: string | undefined) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'agora mesmo';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} dias`;
};

/** Top-bar button: a dot in the link's state, and the other person's name when they are online. */
export function LigacaoButton() {
  const status = useCollab((s) => s.status);
  const peers = useCollab((s) => s.peers);
  const open = useCollab((s) => s.open);
  const invite = useCollab((s) => s.invite);
  const behind = useCollab((s) => (s.update && s.update.git ? s.update.behind : 0));
  const others = Object.values(peers);
  const first = others[0]?.hello?.name;
  const label = status.state !== 'online' ? 'Ligação' : others.length === 0 ? 'Sozinho' : others.length === 1 ? (first ?? '1 pessoa') : `${others.length} pessoas`;
  return (
    <button
      className={`btn ghost link-btn${open ? ' on' : ''}`}
      aria-pressed={open}
      onClick={() => useCollab.getState().setOpen(!open)}
      title={`Ligação com o outro computador: ${STATE_TEXT[status.state]}`}
    >
      <span className={`link-dot ${status.state}${others.length ? ' peer' : ''}`} aria-hidden="true" />
      {label}
      {(invite || behind > 0) && <span className="link-badge" aria-label={invite ? 'Convite para entrar' : 'Versão nova'} />}
    </button>
  );
}

export function LigacaoPanel() {
  const st = useCollab();
  const [code, setCode] = useState('');
  const [shownCode, setShownCode] = useState<string | null>(null);
  const [relay, setRelay] = useState('');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const v = st.view;

  useEffect(() => {
    if (!v) return;
    setRelay(v.config.relayUrl);
    setName(v.config.name);
  }, [v?.config.relayUrl, v?.config.name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (st.open) {
      void st.refresh();
      void checkUpdate();
    }
  }, [st.open]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try {
      await fn();
      await useCollab.getState().refresh();
      if (ok) setMsg(ok);
    } catch (err) {
      setMsg(String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  };

  const online = st.status.state === 'online';
  const peers = Object.values(st.peers);
  const u = st.update;

  return (
    <aside className={`link-panel${st.open ? ' open' : ''}`} aria-label="Ligação" aria-hidden={!st.open}>
      <div className="cl-head">
        <span className="cl-mark" aria-hidden="true">
          <Icon name="send" />
        </span>
        <div className="cl-title">
          <b>Ligação</b>
          <span className={`cl-status ${online ? '' : st.status.state === 'error' ? 'err' : 'run'}`}>
            <span className="dot" />
            <span className="txt">{st.status.error ?? STATE_TEXT[st.status.state]}</span>
          </span>
        </div>
        <button className="btn ghost icon" onClick={() => st.setOpen(false)} title="Fechar" aria-label="Fechar">
          <Icon name="close" />
        </button>
      </div>

      <div className="panel-body">
        {/* Who is here */}
        <div className="card">
          <h4>Computadores</h4>
          <div className="peer-row">
            <span className="peer-dot" style={{ background: 'var(--accent)' }} />
            <div className="peer-txt">
              <b>{v?.config.name || v?.defaultName || 'Este computador'} (tu)</b>
              <span>
                {v?.os} · versão {u && u.git ? u.local?.hash : '—'}
              </span>
            </div>
          </div>
          {peers.length === 0 && <p className="peer-empty">{online ? 'Ninguém mais está ligado agora.' : 'Liga-te para veres o outro computador.'}</p>}
          {peers.map((p) => (
            <div className="peer-row" key={p.id}>
              <span className="peer-dot" style={{ background: peerColor(p.id) }} />
              <div className="peer-txt">
                <b>{p.hello?.name ?? 'A identificar…'}</b>
                <span>
                  {p.hello?.os} · versão {p.hello?.version ?? '—'}
                  {p.hello?.version && u && u.git && u.local && p.hello.version !== u.local.hash ? ' (diferente da tua)' : ''}
                  {p.hello?.session ? ` · a editar "${p.hello.session.name}"` : ''}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Live project */}
        <div className="card">
          <h4>Editar em direto</h4>
          {st.session ? (
            <>
              <p>
                A partilhar <b>"{st.session.name}"</b>. Cada alteração passa logo para o outro computador, e a cabeça de leitura dele aparece na timeline na cor dele.
              </p>
              <button className="btn block" onClick={leaveSession}>
                Parar de partilhar
              </button>
            </>
          ) : st.invite ? (
            <>
              <p>
                <b>{st.peers[st.invite.from]?.hello?.name ?? 'O outro computador'}</b> está a partilhar <b>"{st.invite.name}"</b>. Entrar abre esse projeto aqui (guarda o teu antes, se tiver alterações).
              </p>
              <button className="btn primary block" onClick={joinInvite}>
                Entrar no projeto
              </button>
            </>
          ) : st.joining ? (
            <p>A receber o projeto…</p>
          ) : (
            <>
              <p>Partilha o projeto aberto: quem estiver ligado recebe um convite para entrar e editam os dois ao mesmo tempo.</p>
              <button className="btn primary block" disabled={!online} onClick={shareProject}>
                Partilhar este projeto
              </button>
            </>
          )}
        </div>

        {/* Updates */}
        <div className="card">
          <h4>Versão do Cinemex</h4>
          {!u ? (
            <p>A verificar…</p>
          ) : !u.git ? (
            <p>Esta pasta não é uma cópia do GitHub: atualiza com o git.</p>
          ) : (
            <>
              <p>
                Tens <b>{u.local?.hash}</b> ({u.local?.subject}, {ago(u.local?.date)}).
                {u.behind > 0 ? (
                  <>
                    {' '}
                    No GitHub há <b>{u.behind}</b> {u.behind === 1 ? 'alteração nova' : 'alterações novas'}: a última é de <b>{u.remote?.author}</b>, {ago(u.remote?.date)} ("{u.remote?.subject}").
                  </>
                ) : (
                  ' Estás na versão mais recente.'
                )}
                {u.fetchError ? ` Não consegui ver o GitHub: ${u.fetchError}` : ''}
              </p>
              {u.behind > 0 && (
                <button className="btn primary block" disabled={Boolean(st.updating)} onClick={() => void applyUpdate()}>
                  {st.updating ?? 'Atualizar e reabrir'}
                </button>
              )}
            </>
          )}
        </div>

        {/* Setup */}
        <div className="card">
          <h4>Configuração</h4>
          <div className="field">
            <label htmlFor="lk-name">O teu nome</label>
            <input id="lk-name" className="input" value={name} placeholder={v?.defaultName} onChange={(e) => setName(e.target.value)} onBlur={() => name !== (v?.config.name ?? '') && void run(() => window.ec.collabSet({ name }))} />
          </div>
          <div className="field">
            <label htmlFor="lk-relay">Servidor de ligação</label>
            <input id="lk-relay" className="input" value={relay} placeholder="https://cinemex-relay….workers.dev" onChange={(e) => setRelay(e.target.value)} onBlur={() => relay !== (v?.config.relayUrl ?? '') && void run(() => window.ec.collabSet({ relayUrl: relay }))} />
          </div>
          <div className="field">
            <label>Código de ligação {v?.hasCode ? '(guardado)' : '(em falta)'}</label>
            <p className="hint">O mesmo código nos dois computadores. É como uma chave: manda-o ao outro computador por mensagem privada e a mais ninguém.</p>
            {shownCode && <code className="code-box">{shownCode}</code>}
            <div className="row">
              <button className="btn sm" onClick={() => void run(async () => setShownCode(await window.ec.collabNewCode()), 'Código novo criado: copia-o e manda-o ao outro computador.')}>
                Criar código
              </button>
              {v?.hasCode && (
                <button
                  className="btn sm"
                  onClick={() =>
                    void run(async () => {
                      const c = await window.ec.collabGetCode();
                      if (c) await navigator.clipboard.writeText(c);
                    }, 'Código copiado.')
                  }
                >
                  Copiar código
                </button>
              )}
            </div>
            <div className="row">
              <input className="input" value={code} placeholder="Colar o código (cmx1-…)" onChange={(e) => setCode(e.target.value)} aria-label="Colar código de ligação" />
              <button className="btn sm" disabled={!code.trim()} onClick={() => void run(async () => (await window.ec.collabSetCode(code.trim()), setCode('')), 'Código guardado.')}>
                Guardar
              </button>
            </div>
          </div>
          <div className="field">
            <label>Pasta partilhada (Google Drive)</label>
            <p className="hint">{v?.sharedRoot ?? 'O Google Drive para computador não está instalado neste computador.'}</p>
            <div className="row">
              <button className="btn sm" onClick={() => void run(() => window.ec.collabMakeFolder())} disabled={!v?.sharedRoot}>
                Abrir pasta
              </button>
              <button className="btn sm" onClick={() => void run(() => window.ec.collabPickFolder())}>
                Escolher outra
              </button>
              {v?.config.sharedRoot && (
                <button className="btn sm ghost" onClick={() => void run(() => window.ec.collabSet({ sharedRoot: null }))}>
                  Usar a do Drive
                </button>
              )}
            </div>
          </div>
          {online || st.status.state === 'connecting' ? (
            <button className="btn block" onClick={() => void run(() => window.ec.collabDisconnect())}>
              Desligar
            </button>
          ) : (
            <button className="btn primary block" disabled={!v?.hasCode || !v?.config.relayUrl} onClick={() => void run(() => window.ec.collabConnect())}>
              Ligar
            </button>
          )}
          {(msg || st.error) && (
            <p className="hint" role="status">
              {msg ?? st.error}
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}
