// "Testes" panel on the Editar page. It only exists to check the sync between the two computers:
// when it shows up on the other side, the change made on one computer reached the other.
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
          <p>Se estás a ver este painel na página Editar, a alteração pedida no Mac do Ahlec chegou ao teu computador pelo GitHub.</p>
          <p style={{ marginBottom: 0 }}>Criado a 10 de novembro de 2026.</p>
        </div>
      </div>
    </aside>
  );
}
