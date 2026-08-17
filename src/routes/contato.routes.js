const { Router } = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { HttpError } = require("../lib/httpError");
const { asyncHandler } = require("../lib/asyncHandler");
const { enviarEmail } = require("../lib/mailer");
const { templateContato } = require("../lib/emailTemplates");

const router = Router();

const contatoSchema = z.object({
  nome: z.string().trim().min(1, "Informe seu nome."),
  email: z.string().trim().email("Informe um e-mail válido."),
  assunto: z.string().trim().min(1, "Informe o assunto."),
  mensagem: z.string().trim().min(1, "Informe a mensagem.").max(2000),
});

// Pública — formulário "Fale conosco" da página /contato da loja. Envia por
// e-mail pro contatoEmail cadastrado no admin (Configurações), com replyTo
// pro e-mail de quem mandou — a loja responde direto pelo próprio cliente
// de e-mail, sem precisar copiar o endereço.
router.post(
  "/publico/:slug",
  asyncHandler(async (req, res) => {
    const empresa = await prisma.empresa.findUnique({ where: { slug: req.params.slug } });
    if (!empresa || !empresa.ativo) throw new HttpError(404, "Loja não encontrada.");
    if (!empresa.contatoEmail) {
      throw new HttpError(400, "Esta loja ainda não configurou um e-mail de contato.");
    }

    const data = contatoSchema.parse(req.body);

    try {
      await enviarEmail({
        to: empresa.contatoEmail,
        replyTo: data.email,
        subject: `[Fale conosco] ${data.assunto}`,
        html: templateContato({ ...data, nomeLoja: empresa.nome }),
      });
    } catch (err) {
      console.error("Falha ao enviar e-mail de contato:", err);
      throw new HttpError(
        502,
        "Não foi possível enviar sua mensagem agora. Tente novamente em instantes.",
      );
    }

    res.status(204).end();
  }),
);

module.exports = router;
