// "Testes" panel on the Média page. Its first job is to check the sync between the two
// computers: when it shows up on the other side, the change made it through GitHub.
export function TestPanel() {
  return (
    <aside className="panel" aria-label="Testes">
      <div className="panel-head">
        <div>
          <div className="panel-title">Testes</div>
          <div className="panel-sub">Painel de teste de sincronização</div>
        </div>
      </div>
      <div className="panel-body">
        <div className="card">
          <h4>Ahlec → Gui</h4>
          <p>Se estás a ver este painel, a alteração feita no Mac do Ahlec chegou ao teu computador pelo GitHub.</p>
          <p style={{ marginBottom: 0 }}>Criado a 9 de novembro de 2026.</p>
        </div>
      </div>
    </aside>
  );
}
