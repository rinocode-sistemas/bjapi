const { Router } = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { HttpError } = require("../lib/httpError");
const { asyncHandler } = require("../lib/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");
const { carregarTabelaAtivaDaEmpresa, resolverPrecoProduto } = require("../lib/precoResolver");
const { imagemValida } = require("../lib/imagemProduto");
const { sanitizarHtml, paraTextoPuro } = require("../lib/sanitizarHtml");
const { carregarNotasProdutos, notaDoProduto } = require("../lib/avaliacaoProduto");

const router = Router();

// Nomes de grupos que o admin marcou como indisponíveis (switch "Disponível"
// da tela Grupos de produtos) — usado para excluir esses produtos de toda
// exposição pública, no mesmo espírito do Produto.usaNoSite.
async function carregarGruposIndisponiveis(empresaId) {
  const grupos = await prisma.grupoProduto.findMany({
    where: { empresaId, disponivel: false },
    select: { nome: true },
  });
  return grupos.map((g) => g.nome);
}

// Pública — grupos (categorias) distintos entre os produtos visíveis no site
// dessa loja. Usado para montar a navegação de categorias do storefront sem
// precisar listar produtos inteiros no client.
router.get(
  "/publico/:slug/grupos",
  asyncHandler(async (req, res) => {
    const empresa = await prisma.empresa.findUnique({
      where: { slug: req.params.slug },
      select: { id: true, ativo: true },
    });
    if (!empresa || !empresa.ativo) throw new HttpError(404, "Loja não encontrada.");

    const gruposIndisponiveis = await carregarGruposIndisponiveis(empresa.id);

    const grupos = await prisma.produto.findMany({
      where: {
        empresaId: empresa.id,
        ativo: true,
        usaNoSite: true,
        grupoNome: { not: null, notIn: gruposIndisponiveis },
      },
      distinct: ["grupoNome"],
      select: { grupoNome: true },
      orderBy: { grupoNome: "asc" },
    });

    res.json(grupos.map((g) => g.grupoNome).filter(Boolean));
  }),
);

const OFERTAS_LIMITE = 12;

// Pública — produtos em destaque (`Destaque: true` vindo do ERP) ou com
// preço promocional cadastrado, para o carrossel "Ofertas imperdíveis" do
// storefront. Destaque tem prioridade no selo mostrado ("Só hoje"); os
// demais entram como desconto ("Descontos imperdíveis") — não existe regra
// de frete grátis por produto, então esse selo nunca aparece aqui.
router.get(
  "/publico/:slug/ofertas",
  asyncHandler(async (req, res) => {
    const empresa = await prisma.empresa.findUnique({ where: { slug: req.params.slug } });
    if (!empresa || !empresa.ativo) throw new HttpError(404, "Loja não encontrada.");

    const tabelaAtiva = await carregarTabelaAtivaDaEmpresa(prisma, empresa);
    const gruposIndisponiveis = await carregarGruposIndisponiveis(empresa.id);

    const produtos = await prisma.produto.findMany({
      where: {
        empresaId: empresa.id,
        ativo: true,
        usaNoSite: true,
        // Produto sem grupo (grupoNome null) nunca é afetado pelo filtro de
        // grupo indisponível — "notIn" sozinho excluiria nulls também, já
        // que NULL NOT IN (...) nunca é verdadeiro em SQL.
        ...(gruposIndisponiveis.length > 0
          ? { OR: [{ grupoNome: null }, { grupoNome: { notIn: gruposIndisponiveis } }] }
          : {}),
        AND: { OR: [{ destaque: true }, { precoPromocional: { gt: 0 } }] },
      },
      orderBy: [{ destaque: "desc" }, { descricao: "asc" }],
      take: OFERTAS_LIMITE,
    });

    res.json(
      produtos.map((produto) => {
        const { precoFinal } = resolverPrecoProduto(produto, tabelaAtiva);
        return {
          codigo: produto.codigo,
          descricao: produto.descricao,
          imagem: imagemValida(produto.imagem1) ?? imagemValida(produto.imagem2) ?? imagemValida(produto.imagem3),
          precoNormal: produto.precoNormal.toString(),
          precoFinal: precoFinal.toString(),
          temDesconto: Number(precoFinal) < Number(produto.precoNormal),
          destaque: produto.destaque,
        };
      }),
    );
  }),
);

const PRODUTOS_PAGINA_PADRAO = 20;
const PRODUTOS_PAGINA_MAXIMA = 40;

// Pública — lista paginada (scroll infinito) de todos os produtos visíveis
// no site dessa loja, na mesma lógica de preço do admin
// (resolverPrecoProduto). Paginação por cursor (código do produto) em vez
// de offset/página, para não degradar conforme a loja cresce.
router.get(
  "/publico/:slug/produtos",
  asyncHandler(async (req, res) => {
    const empresa = await prisma.empresa.findUnique({ where: { slug: req.params.slug } });
    if (!empresa || !empresa.ativo) throw new HttpError(404, "Loja não encontrada.");

    const tabelaAtiva = await carregarTabelaAtivaDaEmpresa(prisma, empresa);
    const gruposIndisponiveis = await carregarGruposIndisponiveis(empresa.id);

    const limiteQuery = Number(req.query.limit);
    const limite =
      Number.isInteger(limiteQuery) && limiteQuery > 0 && limiteQuery <= PRODUTOS_PAGINA_MAXIMA
        ? limiteQuery
        : PRODUTOS_PAGINA_PADRAO;

    const cursorCodigo = req.query.cursor != null ? Number(req.query.cursor) : null;
    const temCursor = cursorCodigo != null && Number.isInteger(cursorCodigo);

    const grupo = typeof req.query.grupo === "string" && req.query.grupo.trim() ? req.query.grupo.trim() : null;
    const busca = typeof req.query.busca === "string" && req.query.busca.trim() ? req.query.busca.trim() : null;

    // Lista fechada de códigos (ex.: favoritos salvos no dispositivo) — sem
    // paginação por cursor, o cliente já sabe exatamente quais produtos quer.
    const codigos =
      typeof req.query.codigos === "string" && req.query.codigos.trim()
        ? req.query.codigos
            .split(",")
            .map((c) => Number(c.trim()))
            .filter((c) => Number.isInteger(c))
        : null;

    const produtos = await prisma.produto.findMany({
      where: {
        empresaId: empresa.id,
        ativo: true,
        usaNoSite: true,
        // Comparação sem diferenciar maiúsculas/minúsculas: o grupo mostrado
        // no client vem normalizado (capitalizarInicial), mas o valor salvo
        // é exatamente como veio do ERP.
        ...(grupo ? { grupoNome: { equals: grupo, mode: "insensitive" } } : {}),
        ...(busca ? { descricao: { contains: busca, mode: "insensitive" } } : {}),
        ...(codigos ? { codigo: { in: codigos } } : {}),
        // Mesma ressalva do endpoint de ofertas: grupoNome null nunca deve
        // ser excluído pelo notIn.
        ...(gruposIndisponiveis.length > 0
          ? { OR: [{ grupoNome: null }, { grupoNome: { notIn: gruposIndisponiveis } }] }
          : {}),
      },
      orderBy: { codigo: "asc" },
      ...(codigos ? {} : { take: limite + 1 }),
      ...(!codigos && temCursor
        ? { cursor: { empresaId_codigo: { empresaId: empresa.id, codigo: cursorCodigo } }, skip: 1 }
        : {}),
    });

    const temMais = !codigos && produtos.length > limite;
    const pagina = temMais ? produtos.slice(0, limite) : produtos;
    const mapaNotas = await carregarNotasProdutos(
      prisma,
      empresa.id,
      pagina.map((p) => p.codigo),
    );

    res.json({
      itens: pagina.map((produto) => {
        const { precoFinal } = resolverPrecoProduto(produto, tabelaAtiva);
        return {
          codigo: produto.codigo,
          descricao: produto.descricao,
          resumo:
            typeof produto.informacoes === "string" && produto.informacoes.trim()
              ? paraTextoPuro(produto.informacoes).slice(0, 140) || null
              : null,
          imagem:
            imagemValida(produto.imagem1) ?? imagemValida(produto.imagem2) ?? imagemValida(produto.imagem3),
          precoNormal: produto.precoNormal.toString(),
          precoFinal: precoFinal.toString(),
          temDesconto: Number(precoFinal) < Number(produto.precoNormal),
          rating: notaDoProduto(mapaNotas, produto.codigo),
          // Só considera esgotado quando a empresa efetivamente controla
          // estoque pelo ERP (Empresa.controlaEstoque) — senão saldo
          // zero/negativo não impede a venda.
          esgotado: empresa.controlaEstoque === true && Number(produto.saldo) <= 0,
        };
      }),
      proximoCursor: temMais ? pagina[pagina.length - 1].codigo : null,
    });
  }),
);

// Pública — detalhe de um produto para a página `/product/:codigo` do
// storefront. Carrega as 3 imagens (filtradas de placeholder) e sanitiza a
// descrição vinda do ERP antes de expor — pode conter HTML básico.
router.get(
  "/publico/:slug/produtos/:codigo",
  asyncHandler(async (req, res) => {
    const codigo = Number(req.params.codigo);
    if (!Number.isInteger(codigo)) throw new HttpError(400, "Código de produto inválido.");

    const empresa = await prisma.empresa.findUnique({ where: { slug: req.params.slug } });
    if (!empresa || !empresa.ativo) throw new HttpError(404, "Loja não encontrada.");

    const produto = await prisma.produto.findUnique({
      where: { empresaId_codigo: { empresaId: empresa.id, codigo } },
    });
    if (!produto || !produto.ativo || !produto.usaNoSite) {
      throw new HttpError(404, "Produto não encontrado.");
    }

    if (produto.grupoNome) {
      const grupo = await prisma.grupoProduto.findUnique({
        where: { empresaId_nome: { empresaId: empresa.id, nome: produto.grupoNome } },
        select: { disponivel: true },
      });
      if (grupo && !grupo.disponivel) throw new HttpError(404, "Produto não encontrado.");
    }

    const tabelaAtiva = await carregarTabelaAtivaDaEmpresa(prisma, empresa);
    const { precoFinal } = resolverPrecoProduto(produto, tabelaAtiva);
    const informacoesHtml =
      typeof produto.informacoes === "string" && produto.informacoes.trim()
        ? sanitizarHtml(produto.informacoes)
        : null;

    res.json({
      codigo: produto.codigo,
      descricao: produto.descricao,
      grupoNome: produto.grupoNome,
      informacoesHtml,
      imagens: [produto.imagem1, produto.imagem2, produto.imagem3].map(imagemValida).filter(Boolean),
      precoNormal: produto.precoNormal.toString(),
      precoFinal: precoFinal.toString(),
      temDesconto: Number(precoFinal) < Number(produto.precoNormal),
      destaque: produto.destaque,
      esgotado: empresa.controlaEstoque === true && Number(produto.saldo) <= 0,
    });
  }),
);

const RELACIONADOS_LIMITE_PADRAO = 4;
const RELACIONADOS_LIMITE_MAXIMO = 12;
const RELACIONADOS_POOL = 50;

// Pública — produtos aleatórios do mesmo grupo (categoria), para a seção
// "Você também pode gostar" da página de detalhe. Amostra um lote (até
// RELACIONADOS_POOL) e embaralha em memória — evita ORDER BY random() do
// Postgres, que faz sequential scan mesmo em conjuntos pequenos.
router.get(
  "/publico/:slug/relacionados",
  asyncHandler(async (req, res) => {
    const empresa = await prisma.empresa.findUnique({ where: { slug: req.params.slug } });
    if (!empresa || !empresa.ativo) throw new HttpError(404, "Loja não encontrada.");

    const grupo = typeof req.query.grupo === "string" && req.query.grupo.trim() ? req.query.grupo.trim() : null;
    if (!grupo) {
      res.json([]);
      return;
    }

    // Mesma comparação insensitive usada logo abaixo pra filtrar os produtos
    // do grupo — "grupo" vem do client, que pode ter normalizado o texto.
    const grupoRow = await prisma.grupoProduto.findFirst({
      where: { empresaId: empresa.id, nome: { equals: grupo, mode: "insensitive" } },
      select: { disponivel: true },
    });
    if (grupoRow && !grupoRow.disponivel) {
      res.json([]);
      return;
    }

    const excluirCodigo = Number(req.query.excluir);
    const limiteQuery = Number(req.query.limit);
    const limite =
      Number.isInteger(limiteQuery) && limiteQuery > 0 && limiteQuery <= RELACIONADOS_LIMITE_MAXIMO
        ? limiteQuery
        : RELACIONADOS_LIMITE_PADRAO;

    const tabelaAtiva = await carregarTabelaAtivaDaEmpresa(prisma, empresa);

    const candidatos = await prisma.produto.findMany({
      where: {
        empresaId: empresa.id,
        ativo: true,
        usaNoSite: true,
        grupoNome: { equals: grupo, mode: "insensitive" },
        ...(Number.isInteger(excluirCodigo) ? { codigo: { not: excluirCodigo } } : {}),
      },
      take: RELACIONADOS_POOL,
    });

    for (let i = candidatos.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidatos[i], candidatos[j]] = [candidatos[j], candidatos[i]];
    }

    res.json(
      candidatos.slice(0, limite).map((produto) => {
        const { precoFinal } = resolverPrecoProduto(produto, tabelaAtiva);
        return {
          codigo: produto.codigo,
          descricao: produto.descricao,
          resumo:
            typeof produto.informacoes === "string" && produto.informacoes.trim()
              ? paraTextoPuro(produto.informacoes).slice(0, 140) || null
              : null,
          imagem:
            imagemValida(produto.imagem1) ?? imagemValida(produto.imagem2) ?? imagemValida(produto.imagem3),
          precoNormal: produto.precoNormal.toString(),
          precoFinal: precoFinal.toString(),
          temDesconto: Number(precoFinal) < Number(produto.precoNormal),
        };
      }),
    );
  }),
);

router.use(authenticate, requireRole("ADM"));

async function getEmpresaDoUsuario(req) {
  const empresa = await prisma.empresa.findUnique({ where: { id: req.auth.empresaId } });
  if (!empresa) throw new HttpError(404, "Empresa não encontrada.");
  return empresa;
}

function toPublicProduto(produto, tabelaAtiva) {
  const { precoFinal, origemPreco, tabelaDescricao } = resolverPrecoProduto(produto, tabelaAtiva);
  return {
    codigo: produto.codigo,
    descricao: produto.descricao,
    codigoBarras: produto.codigoBarras,
    codigoOriginal: produto.codigoOriginal,
    codigoFabricante: produto.codigoFabricante,
    unidade: produto.unidade,
    grupoNome: produto.grupoNome,
    informacoes: produto.informacoes,
    precoUnitario: produto.precoUnitario.toString(),
    precoNormal: produto.precoNormal.toString(),
    precoPromocional: produto.precoPromocional.toString(),
    precoFinal: precoFinal.toString(),
    origemPreco,
    tabelaDescricao,
    custoUnitario: produto.custoUnitario.toString(),
    porcDescontoMaximo: produto.porcDescontoMaximo.toString(),
    saldo: produto.saldo.toString(),
    peso: produto.peso.toString(),
    tara: produto.tara.toString(),
    ativo: produto.ativo,
    usaNoSite: produto.usaNoSite,
    imagens: [produto.imagem1, produto.imagem2, produto.imagem3].map(imagemValida).filter(Boolean),
  };
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const empresa = await getEmpresaDoUsuario(req);
    const tabelaAtiva = await carregarTabelaAtivaDaEmpresa(prisma, empresa);

    const produtos = await prisma.produto.findMany({
      where: { empresaId: req.auth.empresaId },
      orderBy: { descricao: "asc" },
    });
    res.json(produtos.map((p) => toPublicProduto(p, tabelaAtiva)));
  }),
);

router.patch(
  "/:codigo",
  asyncHandler(async (req, res) => {
    const codigo = Number(req.params.codigo);
    if (!Number.isInteger(codigo)) throw new HttpError(400, "Código de produto inválido.");

    const { usaNoSite } = z.object({ usaNoSite: z.boolean() }).parse(req.body);
    const produto = await prisma.produto.findUnique({
      where: { empresaId_codigo: { empresaId: req.auth.empresaId, codigo } },
    });
    if (!produto) throw new HttpError(404, "Produto não encontrado.");

    const atualizado = await prisma.produto.update({
      where: { id: produto.id },
      data: { usaNoSite },
    });

    const empresa = await getEmpresaDoUsuario(req);
    const tabelaAtiva = await carregarTabelaAtivaDaEmpresa(prisma, empresa);
    res.json(toPublicProduto(atualizado, tabelaAtiva));
  }),
);

module.exports = router;
