// Resolve o preço de venda final de um produto, aplicando a regra:
// a tabela de preço padrão da empresa — quando cadastrada, ainda válida
// (DataValidade não vencida) e com item para o produto — prevalece sobre o
// preço normal e sobre o preço promocional, seja o valor da tabela maior ou
// menor. Sem tabela aplicável, cai para promoção (se houver) e por fim para
// o preço normal.
//
// Módulo puro/reutilizável: não depende de req/res, apenas de `prisma` e dos
// registros já carregados — pode ser usado tanto pelas rotas do admin quanto,
// futuramente, por um endpoint público da loja.

function tabelaEstaValida(tabela) {
  if (!tabela) return false;
  if (!tabela.dataValidade) return true;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  return new Date(tabela.dataValidade) >= hoje;
}

async function carregarTabelaAtivaDaEmpresa(prisma, empresa) {
  if (empresa.tabelaDePrecoPadraoCodigo == null) return null;

  const tabela = await prisma.tabelaDePrecos.findFirst({
    where: { empresaId: empresa.id, codigo: empresa.tabelaDePrecoPadraoCodigo },
    include: { itens: true },
  });
  if (!tabelaEstaValida(tabela)) return null;

  return {
    descricao: tabela.descricao,
    itensPorProduto: new Map(tabela.itens.map((item) => [item.produtoCodigo, item.valor])),
  };
}

function resolverPrecoProduto(produto, tabelaAtiva) {
  const valorTabela = tabelaAtiva?.itensPorProduto.get(produto.codigo);
  if (valorTabela != null) {
    return { precoFinal: valorTabela, origemPreco: "tabela", tabelaDescricao: tabelaAtiva.descricao };
  }

  if (Number(produto.precoPromocional) > 0) {
    return { precoFinal: produto.precoPromocional, origemPreco: "promocao", tabelaDescricao: null };
  }

  return { precoFinal: produto.precoNormal, origemPreco: "normal", tabelaDescricao: null };
}

module.exports = { carregarTabelaAtivaDaEmpresa, resolverPrecoProduto, tabelaEstaValida };
