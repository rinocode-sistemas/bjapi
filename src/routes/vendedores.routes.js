const { Router } = require("express");
const prisma = require("../lib/prisma");
const { asyncHandler } = require("../lib/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");

const router = Router();

router.use(authenticate, requireRole("ADM"));

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const vendedores = await prisma.vendedor.findMany({
      where: { empresaId: req.auth.empresaId },
      orderBy: { nome: "asc" },
    });
    res.json(vendedores.map((v) => ({ codigo: v.codigo, nome: v.nome })));
  }),
);

module.exports = router;
