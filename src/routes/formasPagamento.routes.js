const { Router } = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { HttpError } = require("../lib/httpError");
const { asyncHandler } = require("../lib/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");

const router = Router();

function toPublicFormaPagamento(formaPagamento) {
  return {
    codigo: formaPagamento.codigo,
    nome: formaPagamento.nome,
    maximoParcelas: formaPagamento.maximoParcelas,
    usaNoSite: formaPagamento.usaNoSite,
  };
}

// Pública — formas de pagamento habilitadas no site, para o checkout montar
// o seletor de forma de pagamento/parcelas.
router.get(
  "/publico/:slug",
  asyncHandler(async (req, res) => {
    const empresa = await prisma.empresa.findUnique({
      where: { slug: req.params.slug },
      select: { id: true, ativo: true },
    });
    if (!empresa || !empresa.ativo) throw new HttpError(404, "Loja não encontrada.");

    const formasPagamento = await prisma.formaPagamento.findMany({
      where: { empresaId: empresa.id, usaNoSite: true },
      orderBy: { nome: "asc" },
    });
    res.json(formasPagamento.map(toPublicFormaPagamento));
  }),
);

router.use(authenticate, requireRole("ADM"));

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const formasPagamento = await prisma.formaPagamento.findMany({
      where: { empresaId: req.auth.empresaId },
      orderBy: { nome: "asc" },
    });
    res.json(formasPagamento.map(toPublicFormaPagamento));
  }),
);

router.patch(
  "/:codigo",
  asyncHandler(async (req, res) => {
    const { usaNoSite } = z.object({ usaNoSite: z.boolean() }).parse(req.body);
    const formaPagamento = await prisma.formaPagamento.findUnique({
      where: {
        empresaId_codigo: {
          empresaId: req.auth.empresaId,
          codigo: req.params.codigo,
        },
      },
    });
    if (!formaPagamento) throw new HttpError(404, "Forma de pagamento não encontrada.");

    const atualizada = await prisma.formaPagamento.update({
      where: { id: formaPagamento.id },
      data: { usaNoSite },
    });

    // Reflete imediatamente no "Em até Nx sem juros" do storefront, sem
    // esperar a próxima sincronização.
    const formasAtivas = await prisma.formaPagamento.findMany({
      where: { empresaId: req.auth.empresaId, usaNoSite: true },
      select: { maximoParcelas: true },
    });
    const maximoParcelas =
      formasAtivas.reduce((max, f) => Math.max(max, f.maximoParcelas), 0) || null;
    await prisma.empresa.update({
      where: { id: req.auth.empresaId },
      data: { maximoParcelas },
    });

    res.json(toPublicFormaPagamento(atualizada));
  }),
);

module.exports = router;
