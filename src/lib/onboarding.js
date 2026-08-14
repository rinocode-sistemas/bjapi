// Regra de conclusão do onboarding — compartilhada entre a checagem
// autenticada (painel admin) e o filtro do diretório público de lojas
// (só lojas com onboarding completo aparecem lá).
function calcularOnboarding(empresa, { totalVendedores, totalBairros }) {
  const passo1 = Boolean(empresa.ultimaSincronizacao) && totalVendedores > 0;
  const passo2 = Boolean(
    empresa.vendedorPadraoCodigo != null && empresa.horarios && empresa.contatoEmail,
  );
  const passo3 = empresa.bairrosFreteGratis || totalBairros > 0;

  return { passo1, passo2, passo3, completo: passo1 && passo2 && passo3 };
}

module.exports = { calcularOnboarding };
