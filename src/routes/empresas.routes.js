const { Router } = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { hashPassword } = require("../lib/hash");
const { HttpError } = require("../lib/httpError");
const { asyncHandler } = require("../lib/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");
const { SENHA_MSG, isSenhaForte } = require("../lib/passwordRules");
const { calcularOnboarding } = require("../lib/onboarding");
const { extrairNomeFantasiaDoErp, extrairEnderecoDoErp } = require("../lib/erpEmpresaDados");

const router = Router();

// Pública — resolve o slug da URL (ex.: /:slug/admin) para a tela de login da loja,
// sem exigir autenticação.
router.get(
  "/by-slug/:slug",
  asyncHandler(async (req, res) => {
    const empresa = await prisma.empresa.findUnique({
      where: { slug: req.params.slug },
      include: { _count: { select: { vendedores: true, bairros: true } } },
    });
    if (!empresa) throw new HttpError(404, "Loja não encontrada.");
    if (!empresa.ativo) throw new HttpError(403, "Loja inativa. Entre em contato com o suporte.");
    const { nomeFantasia, cidade, estado, endereco } = extrairDadosPublicosDoErp(empresa.erpDados);
    res.json({
      id: empresa.id,
      slug: empresa.slug,
      nome: nomeFantasia ?? empresa.nome,
      // Acessar a loja direto pela URL não passa pelo filtro do diretório
      // (/ativas) — sem isso, uma loja que ainda não terminou os 3 passos do
      // onboarding tentaria renderizar a vitrine sem vendedor/bairro/etc.
      // configurados. O front usa isso pra mostrar "Loja em construção".
      onboardingCompleto: calcularOnboarding(empresa, {
        totalVendedores: empresa._count.vendedores,
        totalBairros: empresa._count.bairros,
      }).completo,
      corPrimaria: empresa.corPrimaria,
      logoThumbUrl: comCacheBuster(empresa.logoThumbUrl, empresa),
      // Logo em resolução original — usada só na imagem de compartilhamento
      // (og:image), pra não ficar borrada como a miniatura de 128x128 fica.
      logoUrl: comCacheBuster(empresa.logoUrl, empresa),
      cidade,
      estado,
      endereco,
      lojaFechada: empresa.lojaFechada,
      horarios: empresa.horarios,
      permiteEntrega: empresa.permiteEntrega,
      permiteRetirada: empresa.permiteRetirada,
      maximoParcelas: empresa.maximoParcelas,
      freteGratisTodaLoja: empresa.bairrosFreteGratis,
      descontoFormaPagamento: empresa.descontoFormaPagamento,
      descontoPercentual: empresa.descontoPercentual?.toString() ?? null,
      pedidoMinimo: empresa.pedidoMinimo?.toString() ?? null,
      valorPadraoFrete: empresa.valorPadraoFrete?.toString() ?? null,
      contatoWhatsapp: empresa.contatoWhatsapp,
      contatoEmail: empresa.contatoEmail,
      contatoTelefone: empresa.contatoTelefone,
    });
  }),
);

// Key do S3 é fixa por empresa (mesma URL após cada re-upload) — sem isso o
// navegador continuaria mostrando a logo antiga em cache após trocar.
function comCacheBuster(url, empresa) {
  return url ? `${url}?v=${empresa.updatedAt.getTime()}` : null;
}

// Extrai só os campos seguros do JSON bruto do ERP — nunca repassar erpDados
// inteiro em rota pública (ele carrega o TokenAcesso do beijaflor).
function extrairDadosPublicosDoErp(erpDados) {
  const nomeFantasia = extrairNomeFantasiaDoErp(erpDados);
  const { rua, numero, bairro, cidade, estado } = extrairEnderecoDoErp(erpDados);
  const enderecoPartes = [
    [rua, numero].filter(Boolean).join(", "),
    bairro,
    [cidade, estado].filter(Boolean).join(" — "),
  ].filter(Boolean);
  const endereco = enderecoPartes.length ? enderecoPartes.join(" — ") : null;

  return { nomeFantasia, cidade, estado, endereco };
}

// Pública — lojas ativas E com onboarding completo, para o diretório da
// página inicial (busca/filtro por estado e cidade). Uma loja só aparece
// aqui depois de passar pelos mesmos 3 passos exigidos no painel admin —
// não faz sentido listar uma loja que ainda não terminou a configuração
// básica. Nunca expõe erpDados bruto — só a URL da miniatura (hospedada no
// S3) e o necessário para calcular o status aberta/fechada/pausada no front.
router.get(
  "/ativas",
  asyncHandler(async (_req, res) => {
    const empresas = await prisma.empresa.findMany({
      where: { ativo: true },
      select: {
        slug: true,
        nome: true,
        erpDados: true,
        logoThumbUrl: true,
        updatedAt: true,
        lojaFechada: true,
        horarios: true,
        ultimaSincronizacao: true,
        vendedorPadraoCodigo: true,
        contatoEmail: true,
        bairrosFreteGratis: true,
        _count: { select: { vendedores: true, bairros: true } },
      },
      orderBy: { nome: "asc" },
    });

    const prontas = empresas.filter(
      (empresa) =>
        calcularOnboarding(empresa, {
          totalVendedores: empresa._count.vendedores,
          totalBairros: empresa._count.bairros,
        }).completo,
    );

    res.json(
      prontas.map((empresa) => {
        const { nomeFantasia, cidade, estado } = extrairDadosPublicosDoErp(empresa.erpDados);
        return {
          slug: empresa.slug,
          nome: nomeFantasia ?? empresa.nome,
          logoThumbUrl: comCacheBuster(empresa.logoThumbUrl, empresa),
          cidade,
          estado,
          lojaFechada: empresa.lojaFechada,
          horarios: empresa.horarios,
        };
      }),
    );
  }),
);

router.use(authenticate, requireRole("SUPER"));

const empresaBaseFields = {
  codigoId: z.string().trim().min(1),
  nome: z.string().trim().min(1),
  // Não é mais preenchido no cadastro — vem do próprio ERP na 1ª sincronização
  // (ver /integracao/sincronizar) e é gravado automaticamente na empresa.
  empresaCodigo: z.string().trim().optional(),
  slug: z.string().trim().min(1),
  parceiroNegocio: z.string().trim().min(1, "Informe o parceiro de negócio."),
  usuarioAdm: z.string().trim().min(1),
  emailRecuperacao: z.string().trim().email(),
  ativo: z.boolean().optional().default(true),
  cpfCnpj: z.string().trim().optional(),
  cep: z.string().trim().min(1, "Informe o CEP."),
  endereco: z.string().trim().min(1, "Informe o endereço."),
  enderecoNumero: z.string().trim().min(1, "Informe o número."),
  bairro: z.string().trim().min(1, "Informe o bairro."),
  cidade: z.string().trim().min(1, "Informe a cidade."),
  estado: z.string().trim().min(1, "Informe o estado."),
};

const empresaCreateSchema = z.object({
  ...empresaBaseFields,
  senha: z.string().min(1, "Informe a senha do usuário administrador da empresa.").refine(isSenhaForte, {
    message: SENHA_MSG,
  }),
});

const empresaUpdateSchema = z
  .object(empresaBaseFields)
  .partial()
  .extend({
    senha: z
      .string()
      .optional()
      .default("")
      .refine((v) => v === "" || isSenhaForte(v), { message: SENHA_MSG }),
  });

function toPublicEmpresa(empresa) {
  const adm = empresa.usuarios?.find((u) => u.role === "ADM");
  return {
    id: empresa.id,
    codigoId: empresa.codigoId,
    nome: empresa.nome,
    empresaCodigo: empresa.empresaCodigo,
    slug: empresa.slug,
    parceiroNegocio: empresa.parceiroNegocio,
    usuarioAdm: adm?.username ?? "",
    senha: "",
    emailRecuperacao: adm?.email ?? "",
    ativo: empresa.ativo,
    cpfCnpj: empresa.cpfCnpj ?? "",
    cep: empresa.cep ?? "",
    endereco: empresa.endereco ?? "",
    enderecoNumero: empresa.enderecoNumero ?? "",
    bairro: empresa.bairro ?? "",
    cidade: empresa.cidade ?? "",
    estado: empresa.estado ?? "",
  };
}

router.get(
  "/",
  asyncHandler(async (_req, res) => {
    const empresas = await prisma.empresa.findMany({
      include: { usuarios: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(empresas.map(toPublicEmpresa));
  }),
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const empresa = await prisma.empresa.findUnique({
      where: { id: req.params.id },
      include: { usuarios: true },
    });
    if (!empresa) throw new HttpError(404, "Empresa não encontrada.");
    res.json(toPublicEmpresa(empresa));
  }),
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const data = empresaCreateSchema.parse(req.body);

    const empresa = await prisma.$transaction(async (tx) => {
      const criada = await tx.empresa.create({
        data: {
          codigoId: data.codigoId,
          nome: data.nome,
          empresaCodigo: data.empresaCodigo,
          slug: data.slug,
          parceiroNegocio: data.parceiroNegocio,
          ativo: data.ativo,
          cpfCnpj: data.cpfCnpj || null,
          cep: data.cep || null,
          endereco: data.endereco || null,
          enderecoNumero: data.enderecoNumero || null,
          bairro: data.bairro || null,
          cidade: data.cidade || null,
          estado: data.estado || null,
        },
      });

      await tx.usuario.create({
        data: {
          empresaId: criada.id,
          role: "ADM",
          username: data.usuarioAdm,
          passwordHash: await hashPassword(data.senha),
          email: data.emailRecuperacao,
        },
      });

      return tx.empresa.findUniqueOrThrow({
        where: { id: criada.id },
        include: { usuarios: true },
      });
    });

    res.status(201).json(toPublicEmpresa(empresa));
  }),
);

router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const data = empresaUpdateSchema.parse(req.body);
    const { id } = req.params;

    const atual = await prisma.empresa.findUnique({
      where: { id },
      include: { usuarios: true },
    });
    if (!atual) throw new HttpError(404, "Empresa não encontrada.");

    const adm = atual.usuarios.find((u) => u.role === "ADM");

    const empresa = await prisma.$transaction(async (tx) => {
      await tx.empresa.update({
        where: { id },
        data: {
          ...(data.codigoId !== undefined && { codigoId: data.codigoId }),
          ...(data.nome !== undefined && { nome: data.nome }),
          ...(data.empresaCodigo !== undefined && { empresaCodigo: data.empresaCodigo }),
          ...(data.slug !== undefined && { slug: data.slug }),
          ...(data.parceiroNegocio !== undefined && { parceiroNegocio: data.parceiroNegocio }),
          ...(data.ativo !== undefined && { ativo: data.ativo }),
          ...(data.cpfCnpj !== undefined && { cpfCnpj: data.cpfCnpj || null }),
          ...(data.cep !== undefined && { cep: data.cep || null }),
          ...(data.endereco !== undefined && { endereco: data.endereco || null }),
          ...(data.enderecoNumero !== undefined && { enderecoNumero: data.enderecoNumero || null }),
          ...(data.bairro !== undefined && { bairro: data.bairro || null }),
          ...(data.cidade !== undefined && { cidade: data.cidade || null }),
          ...(data.estado !== undefined && { estado: data.estado || null }),
        },
      });

      if (adm) {
        await tx.usuario.update({
          where: { id: adm.id },
          data: {
            ...(data.usuarioAdm !== undefined && { username: data.usuarioAdm }),
            ...(data.emailRecuperacao !== undefined && { email: data.emailRecuperacao }),
            ...(data.senha && { passwordHash: await hashPassword(data.senha) }),
          },
        });
      }

      return tx.empresa.findUniqueOrThrow({ where: { id }, include: { usuarios: true } });
    });

    res.json(toPublicEmpresa(empresa));
  }),
);

router.patch(
  "/:id/ativo",
  asyncHandler(async (req, res) => {
    const { ativo } = z.object({ ativo: z.boolean() }).parse(req.body);
    const empresa = await prisma.empresa.update({
      where: { id: req.params.id },
      data: { ativo },
      include: { usuarios: true },
    });
    res.json(toPublicEmpresa(empresa));
  }),
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await prisma.empresa.delete({ where: { id: req.params.id } });
    res.status(204).end();
  }),
);

module.exports = router;
