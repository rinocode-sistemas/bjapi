const { Router } = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { encrypt } = require("../lib/crypto");
const { gerarIdentificacaoApi } = require("../lib/randomToken");
const { HttpError } = require("../lib/httpError");
const { asyncHandler } = require("../lib/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");
const { sincronizarEmpresaComErp } = require("../lib/sincronizarErp");

const router = Router();

router.use(authenticate, requireRole("ADM"));

async function getEmpresaDoUsuario(req) {
  const empresa = await prisma.empresa.findUnique({ where: { id: req.auth.empresaId } });
  if (!empresa) throw new HttpError(404, "Empresa não encontrada.");
  return empresa;
}

router.get(
  "/status",
  asyncHandler(async (req, res) => {
    const empresa = await getEmpresaDoUsuario(req);
    res.json({
      temCredenciais: Boolean(empresa.erpLoginCifrado && empresa.erpSenhaCifrada),
      identificacaoApi: empresa.identificacaoApi,
      ultimaSincronizacao: empresa.ultimaSincronizacao,
      empresaErp: empresa.erpDados ?? null,
    });
  }),
);

const credenciaisSchema = z.object({
  login: z.string().trim().min(1, "Informe o login do beijaflor ERP."),
  senha: z.string().min(1, "Informe a senha do beijaflor ERP."),
});

router.put(
  "/credenciais",
  asyncHandler(async (req, res) => {
    const { login, senha } = credenciaisSchema.parse(req.body);
    const empresa = await getEmpresaDoUsuario(req);

    const empresaAtualizada = await prisma.empresa.update({
      where: { id: empresa.id },
      data: {
        erpLoginCifrado: encrypt(login),
        erpSenhaCifrada: encrypt(senha),
        identificacaoApi: empresa.identificacaoApi ?? gerarIdentificacaoApi(),
      },
    });

    res.json({
      temCredenciais: true,
      identificacaoApi: empresaAtualizada.identificacaoApi,
    });
  }),
);

const sincronizarSchema = z.object({
  resetar: z.boolean().optional().default(false),
});

router.post(
  "/sincronizar",
  asyncHandler(async (req, res) => {
    const { resetar } = sincronizarSchema.parse(req.body ?? {});
    const empresa = await getEmpresaDoUsuario(req);
    const resultado = await sincronizarEmpresaComErp(prisma, empresa, { resetar });
    res.json(resultado);
  }),
);

module.exports = router;
