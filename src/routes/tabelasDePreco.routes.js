const { Router } = require("express");
const prisma = require("../lib/prisma");
const { asyncHandler } = require("../lib/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");

const router = Router();

router.use(authenticate, requireRole("ADM"));

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const tabelas = await prisma.tabelaDePrecos.findMany({
      where: { empresaId: req.auth.empresaId },
      orderBy: { descricao: "asc" },
    });
    res.json(tabelas.map((t) => ({ codigo: t.codigo, descricao: t.descricao })));
  }),
);

module.exports = router;
