const { Router } = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { asyncHandler } = require("../lib/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");

const router = Router();

router.use(authenticate, requireRole("ADM"));

// Lista os grupos (categorias) distintos entre os produtos sincronizados
// dessa empresa, com a disponibilidade configurada pelo admin. Um grupo que
// ainda não tem linha em GrupoProduto (nunca foi visitado nessa tela) é
// materializado aqui mesmo, sempre disponível por padrão — mesma lógica do
// DEFAULT true no banco pra Produto.usaNoSite.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const empresaId = req.auth.empresaId;

    const contagens = await prisma.produto.groupBy({
      by: ["grupoNome"],
      where: { empresaId, grupoNome: { not: null } },
      _count: { _all: true },
    });

    if (contagens.length === 0) {
      res.json([]);
      return;
    }

    const existentes = await prisma.grupoProduto.findMany({
      where: { empresaId },
      select: { nome: true, disponivel: true },
    });
    const disponibilidadePorNome = new Map(existentes.map((g) => [g.nome, g.disponivel]));

    const faltantes = contagens
      .map((c) => c.grupoNome)
      .filter((nome) => !disponibilidadePorNome.has(nome));
    if (faltantes.length > 0) {
      await prisma.grupoProduto.createMany({
        data: faltantes.map((nome) => ({ empresaId, nome })),
        skipDuplicates: true,
      });
      for (const nome of faltantes) disponibilidadePorNome.set(nome, true);
    }

    const grupos = contagens
      .map((c) => ({
        nome: c.grupoNome,
        quantidadeProdutos: c._count._all,
        disponivel: disponibilidadePorNome.get(c.grupoNome) ?? true,
      }))
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

    res.json(grupos);
  }),
);

router.patch(
  "/",
  asyncHandler(async (req, res) => {
    // Sem trim no nome: precisa bater exatamente com o `grupoNome` gravado no
    // Produto (a listagem em GET / usa o valor bruto do ERP, sem normalizar
    // espaços) — se o ERP manda o nome com espaço sobrando e a gente
    // trimasse aqui, o upsert criava/alterava uma linha de GrupoProduto com
    // nome diferente da que a listagem usa, e o toggle não tinha efeito
    // nenhum nos produtos de verdade (nem refletia na UI).
    const { nome, disponivel } = z
      .object({ nome: z.string().min(1), disponivel: z.boolean() })
      .parse(req.body);

    const empresaId = req.auth.empresaId;
    const grupo = await prisma.grupoProduto.upsert({
      where: { empresaId_nome: { empresaId, nome } },
      update: { disponivel },
      create: { empresaId, nome, disponivel },
    });

    const quantidadeProdutos = await prisma.produto.count({ where: { empresaId, grupoNome: nome } });
    res.json({ nome: grupo.nome, disponivel: grupo.disponivel, quantidadeProdutos });
  }),
);

module.exports = router;
