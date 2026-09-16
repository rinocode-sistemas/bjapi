const { Router } = require("express");
const { z } = require("zod");
const { Prisma } = require("@prisma/client");
const prisma = require("../lib/prisma");
const { HttpError } = require("../lib/httpError");
const { asyncHandler } = require("../lib/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");

// Sistema de opcionais por GRUPO de produtos (CategoriaOpcionalGrupo /
// ItemOpcionalGrupo) — novo e independente de ProdutoModoDeServir (que é
// por produto, vindo do ERP). 100% administrado aqui pelo lojista; nunca
// tocado pela sincronização com o ERP.
const router = Router();

router.use(authenticate, requireRole("ADM"));

const categoriaSchema = z
  .object({
    nome: z.string().trim().min(1, "Informe o nome da categoria.").max(80),
    minimo: z.number().int().min(0),
    maximo: z.number().int().min(0),
    ordem: z.number().int().optional(),
  })
  .refine((d) => d.maximo === 0 || d.minimo <= d.maximo, {
    message: "O mínimo não pode ser maior que o máximo.",
    path: ["minimo"],
  });

const itemSchema = z.object({
  nome: z.string().trim().min(1, "Informe o nome do item.").max(80),
  valorAdicional: z.number().min(0),
  ordem: z.number().int().optional(),
});

function toPublicCategoria(categoria) {
  return {
    id: categoria.id,
    nome: categoria.nome,
    minimo: categoria.minimo,
    maximo: categoria.maximo,
    ordem: categoria.ordem,
    itens: categoria.itens.map((item) => ({
      id: item.id,
      nome: item.nome,
      valorAdicional: item.valorAdicional.toString(),
      ativo: item.ativo,
      ordem: item.ordem,
    })),
  };
}

async function withMensagemDeConflito(fn, mensagem) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new HttpError(409, mensagem);
    }
    throw err;
  }
}

// Mesma lógica de lazy-create do GET / em gruposProdutos.routes.js — permite
// deep-link direto na tela de opcionais de um grupo que ainda não tem linha
// em GrupoProduto (nunca teve a disponibilidade alterada).
async function resolverGrupoProduto(empresaId, nome) {
  return prisma.grupoProduto.upsert({
    where: { empresaId_nome: { empresaId, nome } },
    update: {},
    create: { empresaId, nome },
  });
}

async function buscarCategoriaDaEmpresa(empresaId, categoriaId) {
  const categoria = await prisma.categoriaOpcionalGrupo.findFirst({
    where: { id: categoriaId, empresaId },
  });
  if (!categoria) throw new HttpError(404, "Categoria de opcionais não encontrada.");
  return categoria;
}

async function buscarItemDaEmpresa(empresaId, itemId) {
  const item = await prisma.itemOpcionalGrupo.findFirst({
    where: { id: itemId, empresaId },
  });
  if (!item) throw new HttpError(404, "Item de opcional não encontrado.");
  return item;
}

router.get(
  "/:nome/opcionais",
  asyncHandler(async (req, res) => {
    const empresaId = req.auth.empresaId;
    const nome = req.params.nome;

    const grupoProduto = await resolverGrupoProduto(empresaId, nome);
    const categorias = await prisma.categoriaOpcionalGrupo.findMany({
      where: { empresaId, grupoProdutoId: grupoProduto.id },
      orderBy: [{ ordem: "asc" }, { nome: "asc" }],
      include: { itens: { orderBy: [{ ordem: "asc" }, { nome: "asc" }] } },
    });

    res.json({ grupoNome: grupoProduto.nome, categorias: categorias.map(toPublicCategoria) });
  }),
);

router.post(
  "/:nome/opcionais/categorias",
  asyncHandler(async (req, res) => {
    const empresaId = req.auth.empresaId;
    const data = categoriaSchema.parse(req.body);

    const grupoProduto = await resolverGrupoProduto(empresaId, req.params.nome);
    const categoria = await withMensagemDeConflito(
      () =>
        prisma.categoriaOpcionalGrupo.create({
          data: { empresaId, grupoProdutoId: grupoProduto.id, ...data },
          include: { itens: true },
        }),
      "Já existe uma categoria com esse nome neste grupo.",
    );

    res.status(201).json(toPublicCategoria(categoria));
  }),
);

router.patch(
  "/categorias/:categoriaId",
  asyncHandler(async (req, res) => {
    const empresaId = req.auth.empresaId;
    const data = categoriaSchema.parse(req.body);
    const atual = await buscarCategoriaDaEmpresa(empresaId, req.params.categoriaId);

    const categoria = await withMensagemDeConflito(
      () =>
        prisma.categoriaOpcionalGrupo.update({
          where: { id: atual.id },
          data,
          include: { itens: { orderBy: [{ ordem: "asc" }, { nome: "asc" }] } },
        }),
      "Já existe uma categoria com esse nome neste grupo.",
    );

    res.json(toPublicCategoria(categoria));
  }),
);

router.delete(
  "/categorias/:categoriaId",
  asyncHandler(async (req, res) => {
    const empresaId = req.auth.empresaId;
    const atual = await buscarCategoriaDaEmpresa(empresaId, req.params.categoriaId);

    await prisma.categoriaOpcionalGrupo.delete({ where: { id: atual.id } });
    res.status(204).end();
  }),
);

router.post(
  "/categorias/:categoriaId/itens",
  asyncHandler(async (req, res) => {
    const empresaId = req.auth.empresaId;
    const data = itemSchema.parse(req.body);
    const categoria = await buscarCategoriaDaEmpresa(empresaId, req.params.categoriaId);

    const item = await withMensagemDeConflito(
      () =>
        prisma.itemOpcionalGrupo.create({
          data: { empresaId, categoriaOpcionalGrupoId: categoria.id, ...data },
        }),
      "Já existe um item com esse nome nesta categoria.",
    );

    res.status(201).json({
      id: item.id,
      nome: item.nome,
      valorAdicional: item.valorAdicional.toString(),
      ativo: item.ativo,
      ordem: item.ordem,
    });
  }),
);

router.patch(
  "/itens/:itemId",
  asyncHandler(async (req, res) => {
    const empresaId = req.auth.empresaId;
    const data = itemSchema.partial().extend({ ativo: z.boolean().optional() }).parse(req.body);
    const atual = await buscarItemDaEmpresa(empresaId, req.params.itemId);

    const item = await withMensagemDeConflito(
      () => prisma.itemOpcionalGrupo.update({ where: { id: atual.id }, data }),
      "Já existe um item com esse nome nesta categoria.",
    );

    res.json({
      id: item.id,
      nome: item.nome,
      valorAdicional: item.valorAdicional.toString(),
      ativo: item.ativo,
      ordem: item.ordem,
    });
  }),
);

router.delete(
  "/itens/:itemId",
  asyncHandler(async (req, res) => {
    const empresaId = req.auth.empresaId;
    const atual = await buscarItemDaEmpresa(empresaId, req.params.itemId);

    await prisma.itemOpcionalGrupo.delete({ where: { id: atual.id } });
    res.status(204).end();
  }),
);

module.exports = router;
