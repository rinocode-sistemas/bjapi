const { decrypt } = require("./crypto");
const {
  retornaUsuario,
  retornaVendedores,
  retornaFormasPagamento,
  retornaTodosProdutos,
  retornaTodosClientes,
  retornaTabelasDePrecoComItens,
  BeijaflorApiError,
} = require("./beijaflorClient");
const { HttpError } = require("./httpError");
const { upsertEmLote } = require("./upsertLote");
const { extrairEnderecoDoErp, extrairControlaEstoqueDoErp } = require("./erpEmpresaDados");

// Puxa vendedores/formas de pagamento/produtos/clientes/tabelas de preço do
// beijaflor ERP e grava no banco — lógica compartilhada entre o botão
// "Sincronizar" do admin (integracao.routes.js) e os gatilhos automáticos
// (cron de segurança e pedido novo, ver backgroundSync.js). Lança
// HttpError/BeijaflorApiError; quem chama em background decide se ignora.
async function sincronizarEmpresaComErp(prisma, empresa, { resetar = false } = {}) {
  if (!empresa.erpLoginCifrado || !empresa.erpSenhaCifrada) {
    throw new HttpError(400, "Salve o login e a senha do beijaflor ERP antes de sincronizar.");
  }

  const login = decrypt(empresa.erpLoginCifrado);
  const senha = decrypt(empresa.erpSenhaCifrada);

  let usuarioErp;
  try {
    usuarioErp = await retornaUsuario(login, senha);
  } catch (err) {
    if (err instanceof BeijaflorApiError) throw new HttpError(400, err.message);
    throw err;
  }

  // "EmpresaCodigo" não é mais preenchido no cadastro (superadmin) — vem
  // do próprio ERP nessa 1ª sincronização e passa a ser gravado na
  // empresa. Só valida contra ele quando já existe um valor gravado (ou
  // seja, a partir da 2ª sincronização em diante), pra pegar credenciais
  // trocadas por engano sem travar o fluxo normal de primeiro login.
  const empresaCodigoJaGravado = Boolean(empresa.empresaCodigo);
  if (
    String(usuarioErp.Id) !== String(empresa.codigoId) ||
    (empresaCodigoJaGravado && String(usuarioErp.EmpresaCodigo) !== String(empresa.empresaCodigo))
  ) {
    throw new HttpError(
      400,
      "Essas credenciais pertencem a outra empresa — não é a mesma cadastrada para esta loja.",
    );
  }

  // Atualiza cidade/estado/endereço/bairro a partir do cadastro da empresa
  // no ERP a cada sincronização — cep e cpfCnpj NÃO entram aqui de
  // propósito: são curados manualmente (superadmin) e servem de fonte pro
  // envio de pedido ao ERP, independente do que o ERP tem cadastrado.
  const enderecoErp = extrairEnderecoDoErp(usuarioErp);
  const controlaEstoqueErp = extrairControlaEstoqueDoErp(usuarioErp);
  await prisma.empresa.update({
    where: { id: empresa.id },
    data: {
      erpTokenAcesso: usuarioErp.TokenAcesso,
      erpDados: usuarioErp,
      controlaEstoque: controlaEstoqueErp,
      empresaCodigo: String(usuarioErp.EmpresaCodigo),
      endereco: enderecoErp.rua,
      enderecoNumero: enderecoErp.numero,
      bairro: enderecoErp.bairro,
      cidade: enderecoErp.cidade,
      estado: enderecoErp.estado,
    },
  });

  let vendedoresErp;
  let formasPagamentoErp;
  let produtosErp;
  let clientesErp;
  let tabelasDePrecoErp;
  try {
    // "configuracaoinicial" vai true enquanto a empresa nunca completou uma
    // sincronização com sucesso (ultimaSincronizacao ainda nula — onboarding
    // em andamento), garantindo carga total dos registros em todas as
    // rotas. Depois da primeira sincronização bem-sucedida (ou quando o
    // admin pede reset manual via `resetar`), todas voltam a false — só
    // consumindo registros novos/alterados a partir daí.
    const parametros = {
      token: usuarioErp.TokenAcesso,
      identificacao: empresa.identificacaoApi,
      empresaCodigo: empresa.empresaCodigo,
      configuracaoInicial: resetar || !empresa.ultimaSincronizacao,
    };
    [vendedoresErp, formasPagamentoErp, produtosErp, clientesErp, tabelasDePrecoErp] = await Promise.all([
      retornaVendedores(parametros),
      retornaFormasPagamento(parametros),
      retornaTodosProdutos(parametros),
      retornaTodosClientes(parametros),
      retornaTabelasDePrecoComItens(parametros),
    ]);
  } catch (err) {
    if (err instanceof BeijaflorApiError) throw new HttpError(400, err.message);
    throw err;
  }

  // Upsert em lote (INSERT ... ON CONFLICT DO UPDATE multi-linha) em vez
  // de um upsert por linha — com o Postgres remoto, cada upsert individual
  // pagava uma ida-e-volta de rede; em lojas com milhares de produtos/itens
  // de tabela de preço isso dominava o tempo da sincronização. Ver
  // lib/upsertLote.js para o motivo de cada detalhe.
  await prisma.$transaction(async (tx) => {
    await upsertEmLote(
      tx,
      "Vendedor",
      ["empresaId", "codigo", "nome"],
      ["empresaId", "codigo"],
      vendedoresErp.map((v) => ({ empresaId: empresa.id, codigo: v.Codigo, nome: v.Nome })),
    );

    await upsertEmLote(
      tx,
      "FormaPagamento",
      ["empresaId", "codigo", "nome", "maximoParcelas"],
      ["empresaId", "codigo"],
      formasPagamentoErp.map((f) => ({
        empresaId: empresa.id,
        codigo: f.Codigo,
        nome: f.Descricao,
        maximoParcelas: f.MaximoParcelas,
      })),
    );

    await upsertEmLote(
      tx,
      "Produto",
      [
        "empresaId",
        "codigo",
        "descricao",
        "codigoBarras",
        "codigoOriginal",
        "codigoFabricante",
        "unidade",
        "grupoNome",
        "informacoes",
        "precoUnitario",
        "precoNormal",
        "precoPromocional",
        "custoUnitario",
        "porcDescontoMaximo",
        "saldo",
        "peso",
        "tara",
        "validadeDias",
        "ativo",
        "destaque",
        "imagem1",
        "imagem2",
        "imagem3",
      ],
      ["empresaId", "codigo"],
      produtosErp.map((produto) => ({
        empresaId: empresa.id,
        codigo: produto.Codigo,
        descricao: produto.Descricao,
        codigoBarras: produto.CodigoDeBarras ?? null,
        codigoOriginal: produto.CodigoOriginal ?? null,
        codigoFabricante: produto.CodigoFabricante ?? null,
        unidade: produto.Unidade,
        grupoNome: produto.GrupoNome ?? null,
        informacoes: produto.Informacoes ?? null,
        precoUnitario: produto.PrecoUnitario,
        precoNormal: produto.PrecoNormal,
        precoPromocional: produto.PrecoPromocional,
        custoUnitario: produto.CustoUnitario,
        porcDescontoMaximo: produto.PorcDescontoMaximo,
        saldo: produto.Saldo,
        peso: produto.Peso,
        tara: produto.Tara,
        validadeDias: produto.ValidadeDias ?? null,
        ativo: produto.Ativo,
        destaque: produto.Destaque ?? false,
        imagem1: produto.UrlImagens?.[0] ?? null,
        imagem2: produto.UrlImagens?.[1] ?? null,
        imagem3: produto.UrlImagens?.[2] ?? null,
      })),
    );

    // "ProdutoModoDeServir" — opções/adicionais do produto (ver comentário no
    // schema). Mesma chave natural do restante da sincronização
    // (grupoDeEmpresaId + empresaCodigo + idErp), não depende do Produto já
    // ter sido upsertado antes (produtoCodigo é só referência por código).
    const modosDeServir = produtosErp.flatMap((produto) =>
      (produto.ProdutoModoDeServir ?? []).map((modo) => ({
        empresaId: empresa.id,
        idErp: modo.Id,
        grupoDeEmpresaId: modo.GrupoDeEmpresaId,
        empresaCodigo: modo.EmpresaCodigo,
        produtoCodigo: modo.ProdutoCodigo,
        descricao: modo.Descricao,
        valorAdicional: modo.ValorAdicional,
      })),
    );
    await upsertEmLote(
      tx,
      "ProdutoModoDeServir",
      [
        "empresaId",
        "idErp",
        "grupoDeEmpresaId",
        "empresaCodigo",
        "produtoCodigo",
        "descricao",
        "valorAdicional",
      ],
      ["grupoDeEmpresaId", "empresaCodigo", "idErp"],
      modosDeServir,
    );

    await upsertEmLote(
      tx,
      "Cliente",
      [
        "empresaId",
        "codigo",
        "nome",
        "razaoSocial",
        "cnpjCpf",
        "endereco",
        "enderecoNumero",
        "enderecoComplemento",
        "bairro",
        "cidade",
        "uf",
        "telefone",
        "ativo",
        "tabelaDePrecoCodigo",
      ],
      ["empresaId", "codigo"],
      clientesErp.map((cliente) => ({
        empresaId: empresa.id,
        codigo: cliente.Codigo,
        nome: cliente.Nome,
        razaoSocial: cliente.RazaoSocial ?? null,
        cnpjCpf: cliente.CNPJ_CPF ?? null,
        endereco: cliente.Endereco ?? null,
        enderecoNumero: cliente.EnderecoNumero ?? null,
        enderecoComplemento: cliente.EnderecoComplemento ?? null,
        bairro: cliente.Bairro ?? null,
        cidade: cliente.Cidade ?? null,
        uf: cliente.UF ?? null,
        telefone: cliente.Telefone ?? null,
        ativo: cliente.Ativo,
        tabelaDePrecoCodigo: cliente.TabelaDePrecoCodigo ?? null,
      })),
    );

    // Cabeçalhos precisam ser gravados (e lidos de volta) antes dos itens:
    // o item se conecta ao cabeçalho por tabelaDePrecosId (FK real), que só
    // existe depois deste upsert — diferente das outras entidades, aqui
    // não dá pra só mandar a chave natural pro item.
    await upsertEmLote(
      tx,
      "TabelaDePrecos",
      [
        "empresaId",
        "grupoDeEmpresaId",
        "empresaCodigo",
        "codigo",
        "tipoDeParticipanteCodigo",
        "descricao",
        "descricaoTipoDeParticipante",
        "dataValidade",
        "dataValidadeConsulta",
      ],
      ["grupoDeEmpresaId", "empresaCodigo", "codigo"],
      tabelasDePrecoErp.map((tabela) => ({
        empresaId: empresa.id,
        grupoDeEmpresaId: tabela.GrupoDeEmpresaId,
        empresaCodigo: tabela.EmpresaCodigo,
        codigo: tabela.Codigo,
        tipoDeParticipanteCodigo: tabela.TipoDeParticipanteCodigo,
        descricao: tabela.Descricao,
        descricaoTipoDeParticipante: tabela.DescricaoTipoDeParticipante ?? null,
        dataValidade: tabela.DataValidade ? new Date(tabela.DataValidade) : null,
        dataValidadeConsulta: tabela.DataValidadeConsulta ? new Date(tabela.DataValidadeConsulta) : null,
      })),
    );

    const cabecalhos = await tx.tabelaDePrecos.findMany({
      where: { empresaId: empresa.id },
      select: { id: true, grupoDeEmpresaId: true, empresaCodigo: true, codigo: true },
    });
    const idDoCabecalho = new Map(
      cabecalhos.map((c) => [`${c.grupoDeEmpresaId}:${c.empresaCodigo}:${c.codigo}`, c.id]),
    );

    const itens = tabelasDePrecoErp.flatMap((tabela) => tabela.TabelaDePrecosItens ?? []);
    await upsertEmLote(
      tx,
      "TabelaDePrecosItem",
      [
        "tabelaDePrecosId",
        "grupoDeEmpresaId",
        "empresaCodigo",
        "tabelaDePrecosCodigo",
        "idErp",
        "produtoCodigo",
        "valor",
      ],
      ["grupoDeEmpresaId", "empresaCodigo", "idErp"],
      itens.map((item) => {
        const tabelaDePrecosId = idDoCabecalho.get(
          `${item.GrupoDeEmpresaId}:${item.EmpresaCodigo}:${item.TabelaDePrecosCodigo}`,
        );
        if (!tabelaDePrecosId) {
          throw new HttpError(
            502,
            `O ERP retornou um item de tabela de preço (id ${item.Id}) sem o cabeçalho correspondente.`,
          );
        }
        return {
          tabelaDePrecosId,
          grupoDeEmpresaId: item.GrupoDeEmpresaId,
          empresaCodigo: item.EmpresaCodigo,
          tabelaDePrecosCodigo: item.TabelaDePrecosCodigo,
          idErp: item.Id,
          produtoCodigo: item.ProdutoCodigo,
          valor: item.Valor,
        };
      }),
    );
  }, { timeout: 120000, maxWait: 10000 });

  // Recalcula o parcelamento máximo a partir das formas de pagamento
  // ativas no site (já upsertadas acima) — evita consultar FormaPagamento
  // toda vez que a loja for exibida no storefront.
  const formasAtivas = await prisma.formaPagamento.findMany({
    where: { empresaId: empresa.id, usaNoSite: true },
    select: { maximoParcelas: true },
  });
  const maximoParcelas =
    formasAtivas.reduce((max, f) => Math.max(max, f.maximoParcelas), 0) || null;

  const empresaFinal = await prisma.empresa.update({
    where: { id: empresa.id },
    data: { ultimaSincronizacao: new Date(), maximoParcelas },
  });

  return {
    ultimaSincronizacao: empresaFinal.ultimaSincronizacao,
    vendedoresSincronizados: vendedoresErp.length,
    formasPagamentoSincronizadas: formasPagamentoErp.length,
    produtosSincronizados: produtosErp.length,
    clientesSincronizados: clientesErp.length,
    tabelasDePrecoSincronizadas: tabelasDePrecoErp.length,
  };
}

module.exports = { sincronizarEmpresaComErp };
