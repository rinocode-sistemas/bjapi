const { ZodError } = require("zod");
const { Prisma } = require("@prisma/client");
const { HttpError } = require("../lib/httpError");

const FRIENDLY_FIELDS = {
  codigoId: "Id",
  slug: "slug",
  username: "usuário",
  email: "e-mail",
};

function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ message: err.message });
  }

  if (err instanceof ZodError) {
    return res.status(400).json({
      message: "Dados inválidos.",
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      const field = Array.isArray(err.meta?.target) ? err.meta.target.join(", ") : "campo";
      return res.status(409).json({ message: `Já existe um registro com este ${field}.` });
    }
    if (err.code === "P2025") {
      return res.status(404).json({ message: "Registro não encontrado." });
    }
  }

  console.error(err);
  return res.status(500).json({ message: "Erro interno no servidor." });
}

module.exports = { errorHandler };
