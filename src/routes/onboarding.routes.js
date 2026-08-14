const { Router } = require("express");
const prisma = require("../lib/prisma");
const { HttpError } = require("../lib/httpError");
const { asyncHandler } = require("../lib/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");
const { calcularOnboarding } = require("../lib/onboarding");

const router = Router();

router.use(authenticate, requireRole("ADM"));

router.get(
  "/status",
  asyncHandler(async (req, res) => {
    const empresa = await prisma.empresa.findUnique({ where: { id: req.auth.empresaId } });
    if (!empresa) throw new HttpError(404, "Empresa não encontrada.");

    const totalVendedores = await prisma.vendedor.count({ where: { empresaId: empresa.id } });
    const totalBairros = await prisma.bairro.count({ where: { empresaId: empresa.id } });

    res.json(calcularOnboarding(empresa, { totalVendedores, totalBairros }));
  }),
);

module.exports = router;
