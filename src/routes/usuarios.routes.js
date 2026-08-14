const { Router } = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { hashPassword } = require("../lib/hash");
const { HttpError } = require("../lib/httpError");
const { asyncHandler } = require("../lib/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");
const { SENHA_MSG, isSenhaForte } = require("../lib/passwordRules");

const router = Router();

router.use(authenticate, requireRole("SUPER", "ADM"));

const usuarioSchema = z.object({
  empresaId: z.string().trim().min(1).nullable().optional(),
  role: z.enum(["SUPER", "ADM", "USUARIO"]),
  username: z.string().trim().min(1),
  senha: z.string().min(1).refine(isSenhaForte, { message: SENHA_MSG }),
  email: z.string().trim().email(),
  ativo: z.boolean().optional().default(true),
});

const usuarioUpdateSchema = usuarioSchema.partial().omit({ senha: true }).extend({
  senha: z
    .string()
    .optional()
    .default("")
    .refine((v) => v === "" || isSenhaForte(v), { message: SENHA_MSG }),
});

function toPublicUsuario(usuario) {
  return {
    id: usuario.id,
    empresaId: usuario.empresaId,
    role: usuario.role,
    username: usuario.username,
    email: usuario.email,
    ativo: usuario.ativo,
  };
}

function scopeFilter(req) {
  // ADM só enxerga/gerencia usuários da própria empresa; SUPER vê todos.
  return req.auth.role === "ADM" ? { empresaId: req.auth.empresaId } : {};
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const usuarios = await prisma.usuario.findMany({
      where: scopeFilter(req),
      orderBy: { createdAt: "desc" },
    });
    res.json(usuarios.map(toPublicUsuario));
  }),
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = usuarioSchema.parse(req.body);

    if (req.auth.role === "ADM") {
      if (data.role !== "USUARIO") {
        throw new HttpError(403, "Administradores só podem criar usuários do tipo usuário.");
      }
      data.empresaId = req.auth.empresaId;
    }
    if (data.role === "SUPER") {
      data.empresaId = null;
    }

    const usuario = await prisma.usuario.create({
      data: {
        empresaId: data.empresaId ?? null,
        role: data.role,
        username: data.username,
        passwordHash: await hashPassword(data.senha),
        email: data.email,
        ativo: data.ativo,
      },
    });

    res.status(201).json(toPublicUsuario(usuario));
  }),
);

router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const data = usuarioUpdateSchema.parse(req.body);
    const atual = await prisma.usuario.findFirst({
      where: { id: req.params.id, ...scopeFilter(req) },
    });
    if (!atual) throw new HttpError(404, "Usuário não encontrado.");

    const usuario = await prisma.usuario.update({
      where: { id: atual.id },
      data: {
        ...(data.username !== undefined && { username: data.username }),
        ...(data.email !== undefined && { email: data.email }),
        ...(data.ativo !== undefined && { ativo: data.ativo }),
        ...(data.senha && { passwordHash: await hashPassword(data.senha) }),
      },
    });

    res.json(toPublicUsuario(usuario));
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const atual = await prisma.usuario.findFirst({
      where: { id: req.params.id, ...scopeFilter(req) },
    });
    if (!atual) throw new HttpError(404, "Usuário não encontrado.");

    await prisma.usuario.delete({ where: { id: atual.id } });
    res.status(204).end();
  }),
);

module.exports = router;
