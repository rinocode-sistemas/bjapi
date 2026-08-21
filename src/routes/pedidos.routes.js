const { Router } = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { HttpError } = require("../lib/httpError");
const { asyncHandler } = require("../lib/asyncHandler");
const { carregarTabelaAtivaDaEmpresa, resolverPrecoProduto } = require("../lib/precoResolver");
const { authenticate, requireRole } = require("../middleware/auth");
const { enviarPedidoParaErp } = require("../lib/enviarPedidoErp");
const { sincronizarEmpresaEmBackground } = require("../lib/backgroundSync");

const router = Router();

function apenasDigitos(valor) {
  return String(valor ?? "").replace(/\D/g, "");
}

function formatarMoeda(valor) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(valor);
}

// Top N por valor (desc), dobrando o resto em "Outros" — usado nos
// agregados do dashboard pra nunca estourar a quantidade de barras/fatias
// de um gráfico categórico.
function agruparTopN(mapa, n) {
  const entradas = Array.from(mapa.entries()).sort((a, b) => b[1] - a[1]);
  const top = entradas.slice(0, n);
  const resto = entradas.slice(n);
  const resultado = top.map(([nome, valor]) => ({ nome, valor: Number(valor.toFixed(2)) }));
  if (resto.length > 0) {
    const somaResto = resto.reduce((soma, [, v]) => soma + v, 0);
    resultado.push({ nome: "Outros", valor: Number(somaResto.toFixed(2)) });
  }
  return resultado;
}

const pedidoSchema = z.object({
  tipoOperacao: z.enum(["entrega", "retirada"]),
  cliente: z.object({
    cpfCnpj: z.string().trim().min(11, "Informe um CPF ou CNPJ válido."),
    nome: z.string().trim().min(1, "Informe o nome."),
    razaoSocial: z.string().trim().nullable().optional(),
    inscricaoEstadual: z.string().trim().nullable().optional(),
    telefone: z.string().trim().min(8, "Informe um telefone válido."),
  }),
  endereco: z
    .object({
      cep: z.string().trim().min(1),
      rua: z.string().trim().min(1),
      numero: z.string().trim().min(1),
      referencia: z.string().trim().nullable().optional(),
      bairroId: z.string().trim().nullable().optional(),
      bairroNome: z.string().trim().nullable().optional(),
      cidade: z.string().trim().min(1),
      estado: z.string().trim().length(2),
    })
    .nullable(),
  formaPagamento: z.object({
    codigo: z.string().trim().min(1),
    parcelas: z.number().int().positive(),
  }),
  cupomCodigo: z.string().trim().nullable().optional(),
  itens: z
    .array(
      z.object({
        codigo: z.number().int(),
        quantidade: z.number().positive(),
        // Ids (idErp) dos ProdutoModoDeServir escolhidos — revalidados contra
        // o banco abaixo, nunca confiamos na descrição/valor vindos do client.
        opcionais: z.array(z.number().int()).optional().default([]),
      }),
    )
    .min(1, "O carrinho está vazio."),
});

function toPublicPedido(pedido) {
  return {
    id: pedido.id,
    numero: pedido.numero,
    status: pedido.status,
    subtotal: pedido.subtotal.toString(),
    descontoCupomValor: pedido.descontoCupomValor.toString(),
    descontoPagamentoValor: pedido.descontoPagamentoValor.toString(),
    freteValor: pedido.freteValor.toString(),
    total: pedido.total.toString(),
    tipoOperacao: pedido.tipoOperacao,
    pagamentos: (pedido.pagamentos ?? []).map((p) => ({
      formaPagamentoCodigo: p.formaPagamentoCodigo,
      formaPagamentoNome: p.formaPagamentoNome,
      parcelas: p.parcelas,
      valor: p.valor.toString(),
    })),
    createdAt: pedido.createdAt.toISOString(),
  };
}

// Pública — cria o pedido no nosso banco (fonte da verdade pro dashboard e
// pro histórico do cliente). Nunca confia em preço/subtotal/total mandados
// pelo client — tudo é recalculado aqui em cima dos dados reais da loja,
// igual à lógica já usada no checkout e no admin (resolverPrecoProduto,
// validação de cupom, frete por bairro).
router.post(
  "/publico/:slug",
  asyncHandler(async (req, res) => {
    const empresa = await prisma.empresa.findUnique({ where: { slug: req.params.slug } });
    if (!empresa || !empresa.ativo) throw new HttpError(404, "Loja não encontrada.");

    const data = pedidoSchema.parse(req.body);

    if (data.tipoOperacao === "entrega" && !empresa.permiteEntrega) {
      throw new HttpError(400, "Esta loja não realiza entregas no momento.");
    }
    if (data.tipoOperacao === "retirada" && !empresa.permiteRetirada) {
      throw new HttpError(400, "Esta loja não permite retirada no momento.");
    }
    if (data.tipoOperacao === "entrega" && !data.endereco) {
      throw new HttpError(400, "Informe o endereço de entrega.");
    }

    // Produtos — só os que ainda existem, estão ativos e visíveis no site.
    const codigos = data.itens.map((i) => i.codigo);
    const tabelaAtiva = await carregarTabelaAtivaDaEmpresa(prisma, empresa);
    const produtos = await prisma.produto.findMany({
      where: { empresaId: empresa.id, codigo: { in: codigos }, ativo: true, usaNoSite: true },
    });
    const produtosPorCodigo = new Map(produtos.map((p) => [p.codigo, p]));

    // Opcionais (ProdutoModoDeServir) pedidos em qualquer item — revalidados
    // de uma vez só contra o banco; descrição/valor vêm sempre daqui, nunca
    // do que o client mandou.
    const idsOpcionaisPedidos = [...new Set(data.itens.flatMap((i) => i.opcionais))];
    const opcionaisValidos =
      idsOpcionaisPedidos.length > 0
        ? await prisma.produtoModoDeServir.findMany({
            where: {
              empresaId: empresa.id,
              produtoCodigo: { in: codigos },
              idErp: { in: idsOpcionaisPedidos },
            },
          })
        : [];
    const opcionaisPorProduto = new Map();
    for (const opcional of opcionaisValidos) {
      const lista = opcionaisPorProduto.get(opcional.produtoCodigo) ?? [];
      lista.push(opcional);
      opcionaisPorProduto.set(opcional.produtoCodigo, lista);
    }

    const itensResolvidos = data.itens.map((item) => {
      const produto = produtosPorCodigo.get(item.codigo);
      if (!produto) {
        throw new HttpError(400, `Um dos produtos do carrinho não está mais disponível (código ${item.codigo}).`);
      }
      const { precoFinal } = resolverPrecoProduto(produto, tabelaAtiva);
      // Opcionais escolhidos pra este produto — ids que não batem com nenhum
      // ProdutoModoDeServir real (removido nesse meio-tempo, etc.) são
      // simplesmente ignorados, sem travar o pedido.
      const opcionaisDoItem = (opcionaisPorProduto.get(produto.codigo) ?? []).filter((o) =>
        item.opcionais.includes(o.idErp),
      );
      const valorOpcionais = opcionaisDoItem.reduce((soma, o) => soma + Number(o.valorAdicional), 0);
      const precoUnitario = Number(precoFinal) + valorOpcionais;
      const precoTotal = precoUnitario * item.quantidade;
      return {
        produtoCodigo: produto.codigo,
        descricao: produto.descricao,
        grupoNome: produto.grupoNome,
        precoUnitario,
        quantidade: item.quantidade,
        precoTotal,
        opcionais: opcionaisDoItem.map((o) => ({
          descricao: o.descricao,
          valorAdicional: o.valorAdicional.toString(),
        })),
      };
    });

    const subtotal = itensResolvidos.reduce((soma, i) => soma + i.precoTotal, 0);

    if (empresa.pedidoMinimo != null && subtotal < Number(empresa.pedidoMinimo)) {
      throw new HttpError(
        400,
        `Pedido mínimo de ${formatarMoeda(Number(empresa.pedidoMinimo))} não atingido.`,
      );
    }

    // Frete — só em entrega; bairro cadastrado prevalece, senão cai no valor
    // padrão da loja (mesma regra do checkout).
    let bairro = null;
    let freteValor = 0;
    if (data.tipoOperacao === "entrega") {
      if (data.endereco.bairroId) {
        bairro = await prisma.bairro.findFirst({
          where: { id: data.endereco.bairroId, empresaId: empresa.id },
        });
        if (!bairro) throw new HttpError(400, "Bairro inválido.");
        freteValor = Number(bairro.valor);
      } else if (empresa.valorPadraoFrete != null) {
        freteValor = Number(empresa.valorPadraoFrete);
      }
    }

    // Cupom
    let cupom = null;
    let descontoCupomValor = 0;
    let cupomFreteGratis = false;
    if (data.cupomCodigo) {
      const codigoCupom = data.cupomCodigo.trim().toUpperCase();
      cupom = await prisma.cupom.findFirst({ where: { empresaId: empresa.id, codigo: codigoCupom } });
      if (!cupom || !cupom.ativo) throw new HttpError(400, "Cupom inválido ou inativo.");
      if (cupom.dataVencimento && cupom.dataVencimento < new Date()) {
        throw new HttpError(400, "Esse cupom expirou.");
      }
      if (cupom.limiteUsos != null && cupom.usosRealizados >= cupom.limiteUsos) {
        throw new HttpError(400, "Esse cupom já atingiu o limite de usos.");
      }
      if (cupom.valorCompraMinima != null && subtotal < Number(cupom.valorCompraMinima)) {
        throw new HttpError(
          400,
          `Esse cupom exige compra mínima de ${formatarMoeda(Number(cupom.valorCompraMinima))}.`,
        );
      }
      if (cupom.tipo === "VALOR") descontoCupomValor = Math.min(Number(cupom.valor), subtotal);
      else if (cupom.tipo === "PERCENTUAL") descontoCupomValor = (subtotal * Number(cupom.valor)) / 100;
      else if (cupom.tipo === "FRETE_GRATIS") {
        if (data.tipoOperacao === "retirada") {
          throw new HttpError(400, "Esse cupom é de frete grátis — não se aplica à retirada.");
        }
        cupomFreteGratis = true;
      }
    }

    // Forma de pagamento — precisa estar habilitada no site; parcelas dentro do limite dela.
    const formaPagamento = await prisma.formaPagamento.findFirst({
      where: { empresaId: empresa.id, codigo: data.formaPagamento.codigo, usaNoSite: true },
    });
    if (!formaPagamento) throw new HttpError(400, "Forma de pagamento inválida.");
    if (data.formaPagamento.parcelas > formaPagamento.maximoParcelas) {
      throw new HttpError(400, "Número de parcelas inválido para essa forma de pagamento.");
    }

    // Desconto por forma de pagamento (Pix/Dinheiro/Ambos) configurado no admin.
    let descontoPagamentoValor = 0;
    if (empresa.descontoFormaPagamento && empresa.descontoPercentual) {
      const aplica =
        empresa.descontoFormaPagamento === "AMBOS" ||
        empresa.descontoFormaPagamento === formaPagamento.codigo;
      if (aplica) descontoPagamentoValor = (subtotal * Number(empresa.descontoPercentual)) / 100;
    }

    const freteGratisEfetivo =
      data.tipoOperacao === "entrega" && (empresa.bairrosFreteGratis || cupomFreteGratis);
    const freteFinal = freteGratisEfetivo ? 0 : freteValor;
    const total = Math.max(0, subtotal - descontoCupomValor - descontoPagamentoValor) + freteFinal;

    const pedido = await prisma.$transaction(async (tx) => {
      const empresaAtualizada = await tx.empresa.update({
        where: { id: empresa.id },
        data: { ultimoPedidoNumero: { increment: 1 } },
      });

      const criado = await tx.pedido.create({
        data: {
          empresaId: empresa.id,
          numero: empresaAtualizada.ultimoPedidoNumero,
          clienteCpfCnpj: apenasDigitos(data.cliente.cpfCnpj),
          clienteNome: data.cliente.nome,
          clienteRazaoSocial: data.cliente.razaoSocial || null,
          clienteInscricaoEstadual: data.cliente.inscricaoEstadual || null,
          clienteTelefone: apenasDigitos(data.cliente.telefone),
          tipoOperacao: data.tipoOperacao === "entrega" ? "ENTREGA" : "RETIRADA",
          enderecoCep: data.endereco?.cep ?? null,
          enderecoRua: data.endereco?.rua ?? null,
          enderecoNumero: data.endereco?.numero ?? null,
          enderecoReferencia: data.endereco?.referencia || null,
          enderecoBairro: bairro?.nome ?? data.endereco?.bairroNome ?? null,
          enderecoCidade: data.endereco?.cidade ?? null,
          enderecoEstado: data.endereco?.estado ?? null,
          bairroId: bairro?.id ?? null,
          cupomId: cupom?.id ?? null,
          cupomCodigo: cupom?.codigo ?? null,
          status: empresa.autoAceitarPedidos ? "ACEITO" : "EM_PROCESSAMENTO",
          subtotal,
          descontoCupomValor,
          descontoPagamentoValor,
          freteValor: freteFinal,
          total,
          itens: { create: itensResolvidos },
          // Hoje é sempre um único pagamento (o checkout não permite dividir
          // entre formas) — em tabela separada já pensando em split futuro.
          pagamentos: {
            create: {
              formaPagamentoCodigo: formaPagamento.codigo,
              formaPagamentoNome: formaPagamento.nome,
              parcelas: data.formaPagamento.parcelas,
              valor: total,
            },
          },
        },
        include: { pagamentos: true },
      });

      if (cupom) {
        await tx.cupom.update({ where: { id: cupom.id }, data: { usosRealizados: { increment: 1 } } });
      }

      return criado;
    });

    // Auto-aceitar já deixou o pedido ACEITO — confirma no ERP agora, antes
    // de responder ao cliente. Nunca lança (ver enviarPedidoErp.js): se o
    // beijaflor falhar, o pedido continua aceito do nosso lado mesmo assim,
    // só fica marcado com erro pro admin ver/reenviar depois.
    if (pedido.status === "ACEITO") {
      await enviarPedidoParaErp(prisma, empresa.id, pedido.id);
      // Silencioso e sem await de propósito — não pode atrasar a resposta
      // pro cliente. Puxa produto/estoque atualizado do ERP em background
      // (ver backgroundSync.js), com debounce próprio por empresa.
      sincronizarEmpresaEmBackground(empresa.id, "pedido");
    }

    res.status(201).json(toPublicPedido(pedido));
  }),
);

const avaliacaoSchema = z.object({
  nota: z.number().int().min(1).max(5),
  comentario: z.string().trim().max(190).nullable().optional(),
});

// Pública — o cliente avalia o próprio pedido depois de recebido. Sem
// conta/login no site, então quem sabe o id (cuid, não sequencial) do
// próprio pedido pode avaliar — id + slug juntos evitam avaliar um pedido de
// outra loja mesmo que o id vaze.
router.patch(
  "/publico/:slug/:id/avaliacao",
  asyncHandler(async (req, res) => {
    const empresa = await prisma.empresa.findUnique({ where: { slug: req.params.slug } });
    if (!empresa) throw new HttpError(404, "Loja não encontrada.");

    const data = avaliacaoSchema.parse(req.body);

    const pedido = await prisma.pedido.findFirst({
      where: { id: req.params.id, empresaId: empresa.id },
      include: { itens: true },
    });
    if (!pedido) throw new HttpError(404, "Pedido não encontrado.");

    // Avaliar o pedido avalia, com a mesma nota, todo produto que ele
    // contém — evita o cliente ter que avaliar item por item. Upsert (não
    // create) porque reavaliar o mesmo pedido deve atualizar a nota desses
    // produtos, não empilhar uma linha nova por edição.
    const codigosUnicos = [...new Set(pedido.itens.map((i) => i.produtoCodigo))];

    await prisma.$transaction([
      prisma.pedido.update({
        where: { id: pedido.id },
        data: { nota: data.nota, comentario: data.comentario || null },
      }),
      ...codigosUnicos.map((produtoCodigo) =>
        prisma.produtoAvaliacao.upsert({
          where: { pedidoId_produtoCodigo: { pedidoId: pedido.id, produtoCodigo } },
          create: { empresaId: empresa.id, pedidoId: pedido.id, produtoCodigo, nota: data.nota },
          update: { nota: data.nota },
        }),
      ),
    ]);

    res.status(204).end();
  }),
);

// Pública — só o status atual, pra tela "Meus pedidos" ficar sincronizando
// (poll) enquanto o pedido está em processamento, sem expor os dados
// completos de novo a cada consulta.
router.get(
  "/publico/:slug/:id/status",
  asyncHandler(async (req, res) => {
    const empresa = await prisma.empresa.findUnique({ where: { slug: req.params.slug } });
    if (!empresa) throw new HttpError(404, "Loja não encontrada.");

    const pedido = await prisma.pedido.findFirst({
      where: { id: req.params.id, empresaId: empresa.id },
      select: { status: true },
    });
    if (!pedido) throw new HttpError(404, "Pedido não encontrado.");

    res.json({ status: pedido.status });
  }),
);

// A partir daqui, tudo exige login de admin da loja.
router.use(authenticate, requireRole("ADM"));

function toAdminPedido(pedido) {
  return {
    id: pedido.id,
    numero: pedido.numero,
    status: pedido.status,
    statusEnvioErp: pedido.statusEnvioErp,
    erpPedidoId: pedido.erpPedidoId,
    erpErro: pedido.erpErro,
    tipoOperacao: pedido.tipoOperacao,
    cliente: {
      nome: pedido.clienteNome,
      cpfCnpj: pedido.clienteCpfCnpj,
      razaoSocial: pedido.clienteRazaoSocial,
      inscricaoEstadual: pedido.clienteInscricaoEstadual,
      telefone: pedido.clienteTelefone,
    },
    endereco:
      pedido.tipoOperacao === "ENTREGA"
        ? {
            cep: pedido.enderecoCep,
            rua: pedido.enderecoRua,
            numero: pedido.enderecoNumero,
            referencia: pedido.enderecoReferencia,
            bairro: pedido.enderecoBairro,
            cidade: pedido.enderecoCidade,
            estado: pedido.enderecoEstado,
          }
        : null,
    cupomCodigo: pedido.cupomCodigo,
    nota: pedido.nota,
    comentario: pedido.comentario,
    subtotal: pedido.subtotal.toString(),
    descontoCupomValor: pedido.descontoCupomValor.toString(),
    descontoPagamentoValor: pedido.descontoPagamentoValor.toString(),
    freteValor: pedido.freteValor.toString(),
    total: pedido.total.toString(),
    itens: pedido.itens.map((i) => ({
      produtoCodigo: i.produtoCodigo,
      descricao: i.descricao,
      grupoNome: i.grupoNome,
      precoUnitario: i.precoUnitario.toString(),
      quantidade: i.quantidade.toString(),
      precoTotal: i.precoTotal.toString(),
      opcionais: i.opcionais ?? [],
    })),
    pagamentos: pedido.pagamentos.map((p) => ({
      formaPagamentoCodigo: p.formaPagamentoCodigo,
      formaPagamentoNome: p.formaPagamentoNome,
      parcelas: p.parcelas,
      valor: p.valor.toString(),
    })),
    createdAt: pedido.createdAt.toISOString(),
  };
}

// Admin — liga/desliga o aceite automático de pedidos novos (tela Pedidos).
router.get(
  "/config",
  asyncHandler(async (req, res) => {
    const empresa = await prisma.empresa.findUnique({
      where: { id: req.auth.empresaId },
      select: { autoAceitarPedidos: true },
    });
    res.json({ autoAceitarPedidos: empresa.autoAceitarPedidos });
  }),
);

router.patch(
  "/config",
  asyncHandler(async (req, res) => {
    const { autoAceitarPedidos } = z.object({ autoAceitarPedidos: z.boolean() }).parse(req.body);
    const empresa = await prisma.empresa.update({
      where: { id: req.auth.empresaId },
      data: { autoAceitarPedidos },
      select: { autoAceitarPedidos: true },
    });
    res.json({ autoAceitarPedidos: empresa.autoAceitarPedidos });
  }),
);

// Admin — fila de pedidos aguardando aceite/recusa. Sem paginação: com
// autoAceitarPedidos ligado (padrão) essa lista tende a ficar vazia, e
// mesmo desligado é o tipo de lista que a loja precisa ver por inteiro, não
// aos pedaços.
router.get(
  "/aguardando",
  asyncHandler(async (req, res) => {
    const pedidos = await prisma.pedido.findMany({
      where: { empresaId: req.auth.empresaId, status: "EM_PROCESSAMENTO" },
      include: { itens: true, pagamentos: true },
      orderBy: { numero: "desc" },
    });
    res.json(pedidos.map(toAdminPedido));
  }),
);

const PEDIDOS_PAGINA_PADRAO = 20;
const PEDIDOS_PAGINA_MAXIMA = 40;

// Admin — histórico completo (aba "Todos os Pedidos"), paginado por cursor
// (número do pedido, sequencial por loja) em vez de offset/página, pra não
// degradar conforme o histórico cresce — mesma lógica de
// /produtos/publico/:slug/produtos.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const limiteQuery = Number(req.query.limit);
    const limite =
      Number.isInteger(limiteQuery) && limiteQuery > 0 && limiteQuery <= PEDIDOS_PAGINA_MAXIMA
        ? limiteQuery
        : PEDIDOS_PAGINA_PADRAO;

    const cursorNumero = req.query.cursor != null ? Number(req.query.cursor) : null;
    const temCursor = cursorNumero != null && Number.isInteger(cursorNumero);

    const pedidos = await prisma.pedido.findMany({
      where: { empresaId: req.auth.empresaId },
      include: { itens: true, pagamentos: true },
      orderBy: { numero: "desc" },
      take: limite + 1,
      ...(temCursor
        ? {
            cursor: { empresaId_numero: { empresaId: req.auth.empresaId, numero: cursorNumero } },
            skip: 1,
          }
        : {}),
    });

    const temMais = pedidos.length > limite;
    const pagina = temMais ? pedidos.slice(0, limite) : pedidos;

    res.json({
      itens: pagina.map(toAdminPedido),
      proximoCursor: temMais ? pagina[pagina.length - 1].numero : null,
    });
  }),
);

// Admin — média e total de avaliações (cartão de resumo da tela Avaliações).
router.get(
  "/avaliacoes/resumo",
  asyncHandler(async (req, res) => {
    const resultado = await prisma.pedido.aggregate({
      where: { empresaId: req.auth.empresaId, nota: { not: null } },
      _avg: { nota: true },
      _count: { nota: true },
    });
    res.json({
      media: resultado._avg.nota != null ? Math.round(resultado._avg.nota * 10) / 10 : 0,
      total: resultado._count.nota,
    });
  }),
);

// Admin — lista de avaliações, paginada por cursor (mesma lógica de "/").
router.get(
  "/avaliacoes",
  asyncHandler(async (req, res) => {
    const limiteQuery = Number(req.query.limit);
    const limite =
      Number.isInteger(limiteQuery) && limiteQuery > 0 && limiteQuery <= PEDIDOS_PAGINA_MAXIMA
        ? limiteQuery
        : PEDIDOS_PAGINA_PADRAO;

    const cursorNumero = req.query.cursor != null ? Number(req.query.cursor) : null;
    const temCursor = cursorNumero != null && Number.isInteger(cursorNumero);

    const pedidos = await prisma.pedido.findMany({
      where: { empresaId: req.auth.empresaId, nota: { not: null } },
      select: { id: true, numero: true, clienteNome: true, nota: true, comentario: true, createdAt: true },
      orderBy: { numero: "desc" },
      take: limite + 1,
      ...(temCursor
        ? {
            cursor: { empresaId_numero: { empresaId: req.auth.empresaId, numero: cursorNumero } },
            skip: 1,
          }
        : {}),
    });

    const temMais = pedidos.length > limite;
    const pagina = temMais ? pedidos.slice(0, limite) : pedidos;

    res.json({
      itens: pagina.map((p) => ({
        id: p.id,
        numero: p.numero,
        clienteNome: p.clienteNome,
        nota: p.nota,
        comentario: p.comentario,
        createdAt: p.createdAt.toISOString(),
      })),
      proximoCursor: temMais ? pagina[pagina.length - 1].numero : null,
    });
  }),
);

// Admin — agregados pro dashboard (gráficos). Os pedidos da janela são
// buscados uma vez só e reaproveitados pra várias visões (por dia, por
// bairro, por cidade); itens e pagamentos vivem em tabelas próprias, então
// são consultas à parte — 4 idas ao banco no total pro dashboard inteiro.
// Pedidos CANCELADO nunca entram nos agregados de venda.
router.get(
  "/dashboard",
  asyncHandler(async (req, res) => {
    const empresaId = req.auth.empresaId;
    const agora = new Date();

    const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1);
    const ha30Dias = new Date(agora);
    ha30Dias.setDate(ha30Dias.getDate() - 29);
    ha30Dias.setHours(0, 0, 0, 0);
    const inicioJanela = inicioMes < ha30Dias ? inicioMes : ha30Dias;

    const [pedidosJanela, itensJanela, pagamentosJanela, avaliacoesPorNota] = await Promise.all([
      prisma.pedido.findMany({
        where: { empresaId, status: { not: "CANCELADO" }, createdAt: { gte: inicioJanela } },
        select: {
          createdAt: true,
          total: true,
          tipoOperacao: true,
          enderecoBairro: true,
          enderecoCidade: true,
        },
      }),
      prisma.pedidoItem.findMany({
        where: { pedido: { empresaId, status: { not: "CANCELADO" }, createdAt: { gte: ha30Dias } } },
        select: { grupoNome: true, precoTotal: true },
      }),
      prisma.pedidoPagamento.findMany({
        where: { pedido: { empresaId, status: { not: "CANCELADO" }, createdAt: { gte: ha30Dias } } },
        select: { formaPagamentoNome: true, valor: true },
      }),
      prisma.pedido.groupBy({
        by: ["nota"],
        where: { empresaId, nota: { not: null } },
        _count: { nota: true },
      }),
    ]);

    // Pedidos por dia — últimos 30 dias, com todo dia presente (mesmo com 0).
    const diasPorData = new Map();
    for (let i = 0; i < 30; i++) {
      const d = new Date(ha30Dias);
      d.setDate(d.getDate() + i);
      const chave = d.toISOString().slice(0, 10);
      diasPorData.set(chave, { data: chave, pedidos: 0, faturamento: 0 });
    }
    for (const p of pedidosJanela) {
      if (p.createdAt < ha30Dias) continue;
      const bucket = diasPorData.get(p.createdAt.toISOString().slice(0, 10));
      if (!bucket) continue;
      bucket.pedidos += 1;
      bucket.faturamento += Number(p.total);
    }
    const pedidosPorDia = Array.from(diasPorData.values()).map((b) => ({
      data: b.data,
      pedidos: b.pedidos,
      faturamento: b.faturamento.toFixed(2),
    }));

    // Faturamento por dia — mês corrente, só até hoje.
    const ultimoDiaMes = new Date(agora.getFullYear(), agora.getMonth() + 1, 0).getDate();
    const diaDeHoje = agora.getDate();
    const diasDoMes = new Map();
    for (let dia = 1; dia <= diaDeHoje; dia++) diasDoMes.set(dia, 0);
    for (const p of pedidosJanela) {
      if (p.createdAt < inicioMes) continue;
      const dia = p.createdAt.getDate();
      if (!diasDoMes.has(dia)) continue;
      diasDoMes.set(dia, diasDoMes.get(dia) + Number(p.total));
    }
    const vendasPorDiaNoMes = Array.from(diasDoMes.entries()).map(([dia, valor]) => ({
      dia,
      valor: Number(valor.toFixed(2)),
    }));

    // Vendas por grupo de produtos — últimos 30 dias.
    const vendasPorGrupoMap = new Map();
    for (const item of itensJanela) {
      const grupo = item.grupoNome?.trim().toUpperCase() || "SEM GRUPO";
      vendasPorGrupoMap.set(grupo, (vendasPorGrupoMap.get(grupo) ?? 0) + Number(item.precoTotal));
    }

    // Formas de pagamento — últimos 30 dias.
    const formasPagamentoMap = new Map();
    for (const p of pagamentosJanela) {
      formasPagamentoMap.set(
        p.formaPagamentoNome,
        (formasPagamentoMap.get(p.formaPagamentoNome) ?? 0) + Number(p.valor),
      );
    }

    // Avaliações — todo o histórico (são poucas, não faz sentido limitar a 30 dias).
    const avaliacoes = [1, 2, 3, 4, 5].map((nota) => ({
      nota,
      quantidade: avaliacoesPorNota.find((a) => a.nota === nota)?._count.nota ?? 0,
    }));

    // Pedidos por bairro/cidade — últimos 30 dias, só entregas (retirada não
    // tem endereço). Maiúscula/minúscula normalizada no agrupamento (o
    // endereço vem de fontes diferentes — CEP, CNPJ, digitado — então
    // "Centro" e "CENTRO" são o mesmo bairro, não dois).
    const bairroMap = new Map();
    const cidadeMap = new Map();
    for (const p of pedidosJanela) {
      if (p.tipoOperacao !== "ENTREGA" || p.createdAt < ha30Dias) continue;
      const bairro = p.enderecoBairro?.trim().toUpperCase();
      if (bairro) bairroMap.set(bairro, (bairroMap.get(bairro) ?? 0) + 1);
      const cidade = p.enderecoCidade?.trim().toUpperCase();
      if (cidade) cidadeMap.set(cidade, (cidadeMap.get(cidade) ?? 0) + 1);
    }

    res.json({
      pedidosPorDia,
      vendasPorDiaNoMes,
      vendasPorGrupo: agruparTopN(vendasPorGrupoMap, 6),
      formasPagamento: agruparTopN(formasPagamentoMap, 6),
      avaliacoes,
      pedidosPorBairro: agruparTopN(bairroMap, 8),
      pedidosPorCidade: agruparTopN(cidadeMap, 8),
    });
  }),
);

// De onde cada status manual pode partir — só a partir daí que o botão
// correspondente aparece no admin.
const STATUS_TRANSICOES_MANUAIS = {
  ACEITO: ["EM_PROCESSAMENTO"],
  CANCELADO: ["EM_PROCESSAMENTO", "ACEITO"],
};

// Admin — aceitar/recusar um pedido em "Em processamento". Aceitar também
// confirma o pedido no ERP (ver enviarPedidoErp.js) — nunca lança, então um
// erro no envio não impede o aceite; só fica registrado em
// statusEnvioErp/erpErro pro admin ver.
router.patch(
  "/:id/status",
  asyncHandler(async (req, res) => {
    const { status } = z.object({ status: z.enum(["ACEITO", "CANCELADO"]) }).parse(req.body);

    const pedido = await prisma.pedido.findFirst({
      where: { id: req.params.id, empresaId: req.auth.empresaId },
    });
    if (!pedido) throw new HttpError(404, "Pedido não encontrado.");

    if (!STATUS_TRANSICOES_MANUAIS[status].includes(pedido.status)) {
      throw new HttpError(400, `Não é possível mudar de "${pedido.status}" para "${status}".`);
    }

    let atualizado = await prisma.pedido.update({
      where: { id: pedido.id },
      data: { status },
      include: { itens: true, pagamentos: true },
    });

    if (status === "ACEITO") {
      await enviarPedidoParaErp(prisma, req.auth.empresaId, pedido.id);
      sincronizarEmpresaEmBackground(req.auth.empresaId, "pedido");
      atualizado = await prisma.pedido.findUnique({
        where: { id: pedido.id },
        include: { itens: true, pagamentos: true },
      });
    }

    res.json(toAdminPedido(atualizado));
  }),
);

module.exports = router;
