// Extração dos dados da própria empresa a partir do JSON bruto devolvido
// pelo beijaflor ERP (erpDados/retornaUsuario) — compartilhado entre a rota
// pública de empresas e a sincronização, que usa isso pra manter
// cidade/estado/endereco/enderecoNumero/bairro em dia a cada sync.

function extrairNomeFantasiaDoErp(erpDados) {
  if (!erpDados || typeof erpDados !== "object") return null;
  if (typeof erpDados.Descricao === "string" && erpDados.Descricao.trim()) {
    return erpDados.Descricao.trim();
  }
  if (erpDados.GrupodeEmpresa && typeof erpDados.GrupodeEmpresa === "object") {
    const descricaoGrupo = erpDados.GrupodeEmpresa.Descricao;
    if (typeof descricaoGrupo === "string" && descricaoGrupo.trim()) return descricaoGrupo.trim();
  }
  return null;
}

function extrairControlaEstoqueDoErp(erpDados) {
  if (!erpDados || typeof erpDados !== "object") return null;
  return typeof erpDados.EmpresaControlaEstoque === "boolean" ? erpDados.EmpresaControlaEstoque : null;
}

function extrairEnderecoDoErp(erpDados) {
  if (!erpDados || typeof erpDados !== "object") {
    return { rua: null, numero: null, bairro: null, cidade: null, estado: null };
  }
  const rua =
    typeof erpDados.EmpresaEndereco === "string" ? erpDados.EmpresaEndereco.trim() || null : null;
  const numero =
    typeof erpDados.EmpresaEnderecoNumero === "string"
      ? erpDados.EmpresaEnderecoNumero.trim() || null
      : null;
  const bairro =
    typeof erpDados.EmpresaBairro === "string" ? erpDados.EmpresaBairro.trim() || null : null;
  const cidade = typeof erpDados.EmpresaCidade === "string" ? erpDados.EmpresaCidade : null;
  const estado = typeof erpDados.EmpresaUF === "string" ? erpDados.EmpresaUF : null;
  return { rua, numero, bairro, cidade, estado };
}

module.exports = { extrairNomeFantasiaDoErp, extrairEnderecoDoErp, extrairControlaEstoqueDoErp };
