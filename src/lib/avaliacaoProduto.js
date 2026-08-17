// Nota mostrada pra produto que ainda não recebeu nenhuma avaliação real —
// só um valor de exibição, nunca gravado no banco (ver ProdutoAvaliacao no
// schema).
const NOTA_PADRAO = 4.8;

// Média real das avaliações (ProdutoAvaliacao) dos códigos informados, numa
// única query — evita N+1 ao montar uma página de produtos.
async function carregarNotasProdutos(prisma, empresaId, codigos) {
  if (codigos.length === 0) return new Map();
  const grupos = await prisma.produtoAvaliacao.groupBy({
    by: ["produtoCodigo"],
    where: { empresaId, produtoCodigo: { in: codigos } },
    _avg: { nota: true },
  });
  return new Map(grupos.map((g) => [g.produtoCodigo, Math.round(g._avg.nota * 10) / 10]));
}

function notaDoProduto(mapaNotas, codigo) {
  return mapaNotas.get(codigo) ?? NOTA_PADRAO;
}

module.exports = { carregarNotasProdutos, notaDoProduto, NOTA_PADRAO };
