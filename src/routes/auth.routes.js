const crypto = require("crypto");
const { Router } = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { comparePassword, hashPassword } = require("../lib/hash");
const { signToken } = require("../lib/jwt");
const { HttpError } = require("../lib/httpError");
const { asyncHandler } = require("../lib/asyncHandler");
const { authenticate } = require("../middleware/auth");
const { enviarEmail } = require("../lib/mailer");
const { templateRedefinirSenha } = require("../lib/emailTemplates");
const { SENHA_MSG, isSenhaForte } = require("../lib/passwordRules");

const router = Router();

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hora

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const loginSchema = z.object({
  escopo: z.enum(["superadmin", "admin"]),
  slug: z.string().trim().min(1).optional(),
  usuario: z.string().trim().min(1),
  senha: z.string().min(1),
});

const rolesByEscopo = {
  superadmin: ["SUPER"],
  admin: ["ADM", "USUARIO"],
};

function toPublicUsuario(usuario) {
  return {
    id: usuario.id,
    username: usuario.username,
    role: usuario.role,
    empresaId: usuario.empresaId,
    email: usuario.email,
  };
}

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { escopo, slug, usuario, senha } = loginSchema.parse(req.body);

    const encontrado = await prisma.usuario.findUnique({ where: { username: usuario } });

    if (!encontrado || !encontrado.ativo) {
      throw new HttpError(401, "Usuário ou senha inválidos.");
    }

    if (!rolesByEscopo[escopo].includes(encontrado.role)) {
      throw new HttpError(401, "Usuário ou senha inválidos.");
    }

    const senhaOk = await comparePassword(senha, encontrado.passwordHash);
    if (!senhaOk) {
      throw new HttpError(401, "Usuário ou senha inválidos.");
    }

    let empresa = null;
    if (encontrado.empresaId) {
      empresa = await prisma.empresa.findUnique({ where: { id: encontrado.empresaId } });
      if (!empresa || !empresa.ativo) {
        throw new HttpError(401, "Empresa inativa. Contate o suporte.");
      }
    }

    // No painel de loja (escopo "admin"), o usuário só pode entrar pela URL
    // da própria empresa (/:slug/admin) — evita logar num painel de outra loja.
    if (escopo === "admin" && empresa?.slug !== slug) {
      throw new HttpError(401, "Usuário ou senha inválidos.");
    }

    const token = signToken({
      sub: encontrado.id,
      role: encontrado.role,
      empresaId: encontrado.empresaId,
    });

    res.json({
      token,
      usuario: toPublicUsuario(encontrado),
      empresa: empresa ? { id: empresa.id, slug: empresa.slug, nome: empresa.nome } : null,
    });
  }),
);

const esqueciSenhaSchema = z.object({
  email: z.string().trim().email(),
});

router.post(
  "/esqueci-senha",
  asyncHandler(async (req, res) => {
    const { email } = esqueciSenhaSchema.parse(req.body);

    // Decisão do produto: priorizar clareza para o usuário em vez de
    // proteção contra enumeração de contas (que exigiria uma resposta
    // genérica igual para e-mail existente ou não).
    const usuario = await prisma.usuario.findUnique({ where: { email } });
    if (!usuario || !usuario.ativo) {
      throw new HttpError(404, "Não encontramos nenhuma conta cadastrada com esse e-mail.");
    }

    const tokenBruto = crypto.randomBytes(32).toString("hex");
    const expiraEm = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    await prisma.usuario.update({
      where: { id: usuario.id },
      data: { resetSenhaTokenHash: hashToken(tokenBruto), resetSenhaExpiraEm: expiraEm },
    });

    const frontUrl = (process.env.FRONT_URL || "http://localhost:5183").replace(/\/$/, "");
    const link = `${frontUrl}/redefinir-senha?token=${tokenBruto}`;

    try {
      await enviarEmail({
        to: usuario.email,
        subject: "Redefinir sua senha — BFStore",
        html: templateRedefinirSenha({ link }),
      });
    } catch (err) {
      console.error("Falha ao enviar e-mail de recuperação de senha:", err);
      throw new HttpError(502, "Não foi possível enviar o e-mail agora. Tente novamente em instantes.");
    }

    res.json({
      message: "Enviamos as instruções de redefinição de senha para o seu e-mail.",
    });
  }),
);

const redefinirSenhaSchema = z.object({
  token: z.string().trim().min(1),
  novaSenha: z.string().refine(isSenhaForte, { message: SENHA_MSG }),
});

router.post(
  "/redefinir-senha",
  asyncHandler(async (req, res) => {
    const { token, novaSenha } = redefinirSenhaSchema.parse(req.body);

    const usuario = await prisma.usuario.findUnique({
      where: { resetSenhaTokenHash: hashToken(token) },
    });

    if (
      !usuario ||
      !usuario.ativo ||
      !usuario.resetSenhaExpiraEm ||
      usuario.resetSenhaExpiraEm.getTime() < Date.now()
    ) {
      throw new HttpError(400, "Link inválido ou expirado. Solicite uma nova recuperação de senha.");
    }

    let empresa = null;
    if (usuario.empresaId) {
      empresa = await prisma.empresa.findUnique({ where: { id: usuario.empresaId } });
      if (!empresa || !empresa.ativo) {
        throw new HttpError(401, "Empresa inativa. Contate o suporte.");
      }
    }

    const atualizado = await prisma.usuario.update({
      where: { id: usuario.id },
      data: {
        passwordHash: await hashPassword(novaSenha),
        resetSenhaTokenHash: null,
        resetSenhaExpiraEm: null,
      },
    });

    const authToken = signToken({
      sub: atualizado.id,
      role: atualizado.role,
      empresaId: atualizado.empresaId,
    });

    res.json({
      token: authToken,
      usuario: toPublicUsuario(atualizado),
      empresa: empresa ? { id: empresa.id, slug: empresa.slug, nome: empresa.nome } : null,
    });
  }),
);

router.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const usuario = await prisma.usuario.findUnique({ where: { id: req.auth.sub } });
    if (!usuario || !usuario.ativo) {
      throw new HttpError(401, "Sessão inválida.");
    }
    res.json({ usuario: toPublicUsuario(usuario) });
  }),
);

const perfilSchema = z.object({
  email: z.string().trim().email(),
  novaSenha: z
    .string()
    .optional()
    .refine((v) => !v || isSenhaForte(v), { message: SENHA_MSG }),
});

// Auto-atendimento — qualquer usuário autenticado (SUPER, ADM ou USUARIO)
// pode atualizar o próprio e-mail de recuperação e/ou senha. Diferente de
// /api/usuarios/:id (SUPER/ADM apenas), que gerencia OUTROS usuários.
router.put(
  "/perfil",
  authenticate,
  asyncHandler(async (req, res) => {
    const { email, novaSenha } = perfilSchema.parse(req.body);

    const atual = await prisma.usuario.findUnique({ where: { id: req.auth.sub } });
    if (!atual || !atual.ativo) {
      throw new HttpError(401, "Sessão inválida.");
    }

    const usuario = await prisma.usuario.update({
      where: { id: atual.id },
      data: {
        email,
        ...(novaSenha && { passwordHash: await hashPassword(novaSenha) }),
      },
    });

    res.json({ usuario: toPublicUsuario(usuario) });
  }),
);

module.exports = router;
