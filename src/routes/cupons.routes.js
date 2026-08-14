const { Router } = require("express");
const { z } = require("zod");
const { Prisma } = require("@prisma/client");
const prisma = require("../lib/prisma");
const { HttpError } = require("../lib/httpError");
const { asyncHandler } = require("../lib/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");

const router = Router();

function formatarMoeda(valor) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(valor);
}

// Pública — valida um cupom digitado no checkout e devolve o desconto já
// calculado em cima do subtotal informado. Não consome uso (usosRealizados)
// aqui — isso só deve acontecer quando o pedido for realmente finalizado,
// o que ainda não existe no checkout (fluxo mockado por enquanto).
router.get(
  "/publico/:slug/:codigo",
  asyncHandler(async (req, res) => {
    const empresa = await prisma.empresa.findUnique({
      where: { slug: req.params.slug },
      select: { id: true, ativo: true },
    });
    if (!empresa || !empresa.ativo) throw new HttpError(404, "Loja não encontrada.");

    const codigo = req.params.codigo.trim().toUpperCase();
    const subtotal = Number(req.query.subtotal);
    if (!Number.isFinite(subtotal) || subtotal < 0) throw new HttpError(400, "Subtotal inválido.");

    const cupom = await prisma.cupom.findFirst({ where: { empresaId: empresa.id, codigo } });
    if (!cupom || !cupom.ativo) throw new HttpError(404, "Cupom inválido ou inativo.");
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

    let descontoValor = 0;
    if (cupom.tipo === "VALOR") descontoValor = Math.min(Number(cupom.valor), subtotal);
    else if (cupom.tipo === "PERCENTUAL") descontoValor = (subtotal * Number(cupom.valor)) / 100;

    res.json({
      codigo: cupom.codigo,
      tipo: cupom.tipo,
      descricao: cupom.descricao,
      descontoValor: descontoValor.toFixed(2),
      freteGratis: cupom.tipo === "FRETE_GRATIS",
    });
  }),
);

router.use(authenticate, requireRole("ADM"));

const TIPOS = ["VALOR", "PERCENTUAL", "FRETE_GRATIS"];

const cupomSchema = z
  .object({
    codigo: z
      .string()
      .trim()
      .min(6, "O código deve ter pelo menos 6 caracteres.")
      .max(40)
      .transform((v) => v.toUpperCase())
      .refine((v) => /^[A-Z0-9]+$/.test(v), "O código deve conter apenas letras e números, sem espaços ou símbolos."),
    descricao: z.string().trim().max(200).nullable().optional(),
    tipo: z.enum(TIPOS),
    valor: z.number().positive().nullable().optional(),
    valorCompraMinima: z.number().nonnegative().nullable().optional(),
    dataVencimento: z.coerce.date().nullable().optional(),
    ativo: z.boolean().optional(),
    limiteUsos: z.number().int().positive().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.tipo === "FRETE_GRATIS") {
      if (data.valor != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["valor"],
          message: "Cupom de frete grátis não deve ter valor.",
        });
      }
    } else if (data.valor == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["valor"],
        message: "Informe o valor do desconto.",
      });
    } else if (data.tipo === "PERCENTUAL" && data.valor > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["valor"],
        message: "O percentual não pode ser maior que 100.",
      });
    }
  });

function toPublicCupom(cupom) {
  return {
    id: cupom.id,
    codigo: cupom.codigo,
    descricao: cupom.descricao,
    tipo: cupom.tipo,
    valor: cupom.valor?.toString() ?? null,
    valorCompraMinima: cupom.valorCompraMinima?.toString() ?? null,
    dataVencimento: cupom.dataVencimento?.toISOString() ?? null,
    ativo: cupom.ativo,
    limiteUsos: cupom.limiteUsos,
    usosRealizados: cupom.usosRealizados,
    createdAt: cupom.createdAt.toISOString(),
    updatedAt: cupom.updatedAt.toISOString(),
  };
}

async function withMensagemDeConflito(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new HttpError(409, "Já existe um cupom com esse nome/código.");
    }
    throw err;
  }
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const cupons = await prisma.cupom.findMany({
      where: { empresaId: req.auth.empresaId },
      orderBy: { createdAt: "desc" },
    });
    res.json(cupons.map(toPublicCupom));
  }),
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = cupomSchema.parse(req.body);
    const cupom = await withMensagemDeConflito(() =>
      prisma.cupom.create({ data: { ...data, empresaId: req.auth.empresaId } }),
    );
    res.status(201).json(toPublicCupom(cupom));
  }),
);

router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const data = cupomSchema.parse(req.body);
    const atual = await prisma.cupom.findFirst({
      where: { id: req.params.id, empresaId: req.auth.empresaId },
    });
    if (!atual) throw new HttpError(404, "Cupom não encontrado.");

    const cupom = await withMensagemDeConflito(() =>
      prisma.cupom.update({ where: { id: atual.id }, data }),
    );
    res.json(toPublicCupom(cupom));
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const atual = await prisma.cupom.findFirst({
      where: { id: req.params.id, empresaId: req.auth.empresaId },
    });
    if (!atual) throw new HttpError(404, "Cupom não encontrado.");

    await prisma.cupom.delete({ where: { id: atual.id } });
    res.status(204).end();
  }),
);

module.exports = router;
