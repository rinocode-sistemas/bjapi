const { Router } = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { HttpError } = require("../lib/httpError");
const { asyncHandler } = require("../lib/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");

const router = Router();

function toPublicBairro(bairro) {
  return {
    id: bairro.id,
    estado: bairro.estado,
    nome: bairro.nome,
    cidade: bairro.cidade,
    valor: bairro.valor.toString(),
  };
}

// Pública — bairros atendidos pela loja (nome, cidade, estado, valor da
// entrega), para o cliente escolher no endereço de entrega do checkout.
router.get(
  "/publico/:slug",
  asyncHandler(async (req, res) => {
    const empresa = await prisma.empresa.findUnique({
      where: { slug: req.params.slug },
      select: { id: true, ativo: true },
    });
    if (!empresa || !empresa.ativo) throw new HttpError(404, "Loja não encontrada.");

    const bairros = await prisma.bairro.findMany({
      where: { empresaId: empresa.id },
      orderBy: [{ cidade: "asc" }, { nome: "asc" }],
    });
    res.json(bairros.map(toPublicBairro));
  }),
);

router.use(authenticate, requireRole("ADM"));

function normalizarCidade(cidade) {
  return cidade
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
}

const bairroSchema = z.object({
  estado: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Selecione um estado válido."),
  nome: z.string().trim().min(1),
  cidade: z.string().trim().min(1).transform(normalizarCidade),
  valor: z.coerce.number().nonnegative(),
});

const bairroUpdateSchema = bairroSchema.partial();

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const bairros = await prisma.bairro.findMany({
      where: { empresaId: req.auth.empresaId },
      orderBy: { nome: "asc" },
    });
    res.json(bairros.map(toPublicBairro));
  }),
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = bairroSchema.parse(req.body);
    const bairro = await prisma.bairro.create({
      data: { ...data, empresaId: req.auth.empresaId },
    });
    res.status(201).json(toPublicBairro(bairro));
  }),
);

router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const data = bairroUpdateSchema.parse(req.body);
    const atual = await prisma.bairro.findFirst({
      where: { id: req.params.id, empresaId: req.auth.empresaId },
    });
    if (!atual) throw new HttpError(404, "Bairro não encontrado.");

    const bairro = await prisma.bairro.update({ where: { id: atual.id }, data });
    res.json(toPublicBairro(bairro));
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const atual = await prisma.bairro.findFirst({
      where: { id: req.params.id, empresaId: req.auth.empresaId },
    });
    if (!atual) throw new HttpError(404, "Bairro não encontrado.");

    await prisma.bairro.delete({ where: { id: atual.id } });
    res.status(204).end();
  }),
);

module.exports = router;
