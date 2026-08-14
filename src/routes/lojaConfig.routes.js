const { Router } = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { HttpError } = require("../lib/httpError");
const { asyncHandler } = require("../lib/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");

const router = Router();

router.use(authenticate, requireRole("ADM"));

const horarioSchema = z.object({
  aberto: z.boolean().optional(),
  de: z.string().optional(),
  ate: z.string().optional(),
});

const horariosSchema = z
  .object({
    diasUteis: horarioSchema.optional(),
    sabado: horarioSchema.optional(),
    domingo: horarioSchema.optional(),
  })
  .nullable()
  .optional();

const LOGO_DATA_URL_REGEX = /^data:(image\/(?:png|jpe?g|webp|svg\+xml));base64,([a-zA-Z0-9+/=]+)$/;
const LOGO_THUMB_DATA_URL_REGEX = /^data:image\/png;base64,([a-zA-Z0-9+/=]+)$/;
const LOGO_TAMANHO_MAXIMO = 2 * 1024 * 1024;

const lojaConfigSchema = z.object({
  vendedorPadraoCodigo: z.number().int().nullable().optional(),
  tabelaDePrecoPadraoCodigo: z.number().int().nullable().optional(),
  horarios: horariosSchema,
  contatoEmail: z.string().trim().email().nullable().optional(),
  contatoTelefone: z.string().trim().nullable().optional(),
  contatoWhatsapp: z.string().trim().nullable().optional(),
  bairrosFreteGratis: z.boolean().optional(),
  freteGratisAcimaDe: z.number().nonnegative().nullable().optional(),
  valorPadraoFrete: z.number().nonnegative().nullable().optional(),
  lojaFechada: z.boolean().optional(),
  pedidoMinimo: z.number().nonnegative().nullable().optional(),
  permiteEntrega: z.boolean().optional(),
  permiteRetirada: z.boolean().optional(),
  descontoFormaPagamento: z.enum(["PIX", "DIN", "AMBOS"]).nullable().optional(),
  descontoPercentual: z.number().min(0).max(100).nullable().optional(),
  quantidadeMinima: z.number().positive().nullable().optional(),
  corPrimaria: z
    .string()
    .trim()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Informe uma cor válida (ex: #0B3EA8).")
    .nullable()
    .optional(),
  logo: z
    .string()
    .regex(LOGO_DATA_URL_REGEX, "Envie uma imagem PNG, JPG, WEBP ou SVG.")
    .nullable()
    .optional(),
  logoThumb: z.string().regex(LOGO_THUMB_DATA_URL_REGEX).nullable().optional(),
});

function toPublicConfig(empresa) {
  return {
    vendedorPadraoCodigo: empresa.vendedorPadraoCodigo,
    tabelaDePrecoPadraoCodigo: empresa.tabelaDePrecoPadraoCodigo,
    horarios: empresa.horarios,
    contatoEmail: empresa.contatoEmail,
    contatoTelefone: empresa.contatoTelefone,
    contatoWhatsapp: empresa.contatoWhatsapp,
    bairrosFreteGratis: empresa.bairrosFreteGratis,
    freteGratisAcimaDe: empresa.freteGratisAcimaDe?.toString() ?? null,
    valorPadraoFrete: empresa.valorPadraoFrete?.toString() ?? null,
    lojaFechada: empresa.lojaFechada,
    pedidoMinimo: empresa.pedidoMinimo?.toString() ?? null,
    permiteEntrega: empresa.permiteEntrega,
    permiteRetirada: empresa.permiteRetirada,
    descontoFormaPagamento: empresa.descontoFormaPagamento,
    descontoPercentual: empresa.descontoPercentual?.toString() ?? null,
    quantidadeMinima: empresa.quantidadeMinima?.toString() ?? null,
    corPrimaria: empresa.corPrimaria,
    temLogo: empresa.logo != null,
  };
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const empresa = await prisma.empresa.findUnique({ where: { id: req.auth.empresaId } });
    if (!empresa) throw new HttpError(404, "Empresa não encontrada.");
    res.json(toPublicConfig(empresa));
  }),
);

router.put(
  "/",
  asyncHandler(async (req, res) => {
    const { logo, logoThumb, ...data } = lojaConfigSchema.parse(req.body);

    if (logo === null) {
      data.logo = null;
      data.logoMimeType = null;
    } else if (logo !== undefined) {
      const [, mimeType, base64] = LOGO_DATA_URL_REGEX.exec(logo);
      const buffer = Buffer.from(base64, "base64");
      if (buffer.length > LOGO_TAMANHO_MAXIMO) {
        throw new HttpError(400, "A logo deve ter no máximo 2MB.");
      }
      data.logo = buffer;
      data.logoMimeType = mimeType;
    }

    if (logoThumb === null) {
      data.logoThumb = null;
    } else if (logoThumb !== undefined) {
      const [, base64] = LOGO_THUMB_DATA_URL_REGEX.exec(logoThumb);
      data.logoThumb = Buffer.from(base64, "base64");
    }

    if (data.vendedorPadraoCodigo != null) {
      const existe = await prisma.vendedor.findUnique({
        where: {
          empresaId_codigo: { empresaId: req.auth.empresaId, codigo: data.vendedorPadraoCodigo },
        },
      });
      if (!existe) {
        throw new HttpError(
          400,
          "Vendedor padrão inválido — sincronize os vendedores antes de escolher um.",
        );
      }
    }

    if (data.tabelaDePrecoPadraoCodigo != null) {
      const existe = await prisma.tabelaDePrecos.findFirst({
        where: { empresaId: req.auth.empresaId, codigo: data.tabelaDePrecoPadraoCodigo },
      });
      if (!existe) {
        throw new HttpError(
          400,
          "Tabela de preço inválida — sincronize as tabelas de preço antes de escolher uma.",
        );
      }
    }

    const empresa = await prisma.empresa.update({
      where: { id: req.auth.empresaId },
      data,
    });

    res.json(toPublicConfig(empresa));
  }),
);

module.exports = router;
