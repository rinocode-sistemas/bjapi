const { Router } = require("express");
const { z } = require("zod");
const prisma = require("../lib/prisma");
const { encrypt, decrypt } = require("../lib/crypto");
const { gerarIdentificacaoApi } = require("../lib/randomToken");
const {
  retornaUsuario,
  retornaVendedores,
  retornaFormasPagamento,
  retornaTodosProdutos,
  retornaTodosClientes,
  retornaTabelasDePrecoComItens,
  BeijaflorApiError,
} = require("../lib/beijaflorClient");
const { HttpError } = require("../lib/httpError");
const { asyncHandler } = require("../lib/asyncHandler");
const { authenticate, requireRole } = require("../middleware/auth");

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

    if (!empresa.erpLoginCifrado || !empresa.erpSenhaCifrada) {
      throw new HttpError(400, "Salve o login e a senha do beijaflor ERP antes de sincronizar.");
    }

    const login = decrypt(empresa.erpLoginCifrado);
    const senha = decrypt(empresa.erpSenhaCifrada);

    let usuarioErp;
    try {
      usuarioErp = await retornaUsuario(login, senha);
    } catch (err) {
      if (err instanceof BeijaflorApiError) throw new HttpError(400, err.message);
      throw err;
    }

    if (
      String(usuarioErp.Id) !== String(empresa.codigoId) ||
      String(usuarioErp.EmpresaCodigo) !== String(empresa.empresaCodigo)
    ) {
      throw new HttpError(
        400,
        "Essas credenciais pertencem a outra empresa — não é a mesma cadastrada para esta loja.",
      );
    }

    await prisma.empresa.update({
      where: { id: empresa.id },
      data: {
        erpTokenAcesso: usuarioErp.TokenAcesso,
        erpDados: usuarioErp,
      },
    });

    let vendedoresErp;
    let formasPagamentoErp;
    let produtosErp;
    let clientesErp;
    let tabelasDePrecoErp;
    try {
      // "configuracaoinicial" vai true enquanto a empresa nunca completou uma
      // sincronização com sucesso (ultimaSincronizacao ainda nula — onboarding
      // em andamento), garantindo carga total dos registros em todas as
      // rotas. Depois da primeira sincronização bem-sucedida (ou quando o
      // admin pede reset manual via `resetar`), todas voltam a false — só
      // consumindo registros novos/alterados a partir daí.
      const parametros = {
        token: usuarioErp.TokenAcesso,
        identificacao: empresa.identificacaoApi,
        empresaCodigo: empresa.empresaCodigo,
        configuracaoInicial: resetar || !empresa.ultimaSincronizacao,
      };
      [vendedoresErp, formasPagamentoErp, produtosErp, clientesErp, tabelasDePrecoErp] = await Promise.all([
        retornaVendedores(parametros),
        retornaFormasPagamento(parametros),
        retornaTodosProdutos(parametros),
        retornaTodosClientes(parametros),
        retornaTabelasDePrecoComItens(parametros),
      ]);
    } catch (err) {
      if (err instanceof BeijaflorApiError) throw new HttpError(400, err.message);
      throw err;
    }

    await prisma.$transaction([
      ...vendedoresErp.map((v) =>
        prisma.vendedor.upsert({
          where: { empresaId_codigo: { empresaId: empresa.id, codigo: v.Codigo } },
          create: { empresaId: empresa.id, codigo: v.Codigo, nome: v.Nome },
          update: { nome: v.Nome },
        }),
      ),
      ...formasPagamentoErp.map((formaPagamento) =>
        prisma.formaPagamento.upsert({
          where: {
            empresaId_codigo: { empresaId: empresa.id, codigo: formaPagamento.Codigo },
          },
          create: {
            empresaId: empresa.id,
            codigo: formaPagamento.Codigo,
            nome: formaPagamento.Descricao,
            maximoParcelas: formaPagamento.MaximoParcelas,
          },
          update: {
            nome: formaPagamento.Descricao,
            maximoParcelas: formaPagamento.MaximoParcelas,
          },
        }),
      ),
      ...produtosErp.map((produto) => {
        const dados = {
          descricao: produto.Descricao,
          codigoBarras: produto.CodigoDeBarras ?? null,
          codigoOriginal: produto.CodigoOriginal ?? null,
          codigoFabricante: produto.CodigoFabricante ?? null,
          unidade: produto.Unidade,
          grupoNome: produto.GrupoNome ?? null,
          informacoes: produto.Informacoes ?? null,
          precoUnitario: produto.PrecoUnitario,
          precoNormal: produto.PrecoNormal,
          precoPromocional: produto.PrecoPromocional,
          custoUnitario: produto.CustoUnitario,
          porcDescontoMaximo: produto.PorcDescontoMaximo,
          saldo: produto.Saldo,
          peso: produto.Peso,
          tara: produto.Tara,
          ativo: produto.Ativo,
          destaque: produto.Destaque ?? false,
          imagem1: produto.UrlImagens?.[0] ?? null,
          imagem2: produto.UrlImagens?.[1] ?? null,
          imagem3: produto.UrlImagens?.[2] ?? null,
        };
        return prisma.produto.upsert({
          where: { empresaId_codigo: { empresaId: empresa.id, codigo: produto.Codigo } },
          create: { empresaId: empresa.id, codigo: produto.Codigo, ...dados },
          update: dados,
        });
      }),
      ...clientesErp.map((cliente) => {
        const dados = {
          nome: cliente.Nome,
          razaoSocial: cliente.RazaoSocial ?? null,
          cnpjCpf: cliente.CNPJ_CPF ?? null,
          endereco: cliente.Endereco ?? null,
          enderecoNumero: cliente.EnderecoNumero ?? null,
          enderecoComplemento: cliente.EnderecoComplemento ?? null,
          bairro: cliente.Bairro ?? null,
          cidade: cliente.Cidade ?? null,
          uf: cliente.UF ?? null,
          telefone: cliente.Telefone ?? null,
          ativo: cliente.Ativo,
          tabelaDePrecoCodigo: cliente.TabelaDePrecoCodigo ?? null,
        };
        return prisma.cliente.upsert({
          where: { empresaId_codigo: { empresaId: empresa.id, codigo: cliente.Codigo } },
          create: { empresaId: empresa.id, codigo: cliente.Codigo, ...dados },
          update: dados,
        });
      }),
      // Cabeçalhos precisam ser gravados antes dos itens: os itens se
      // conectam ao cabeçalho pela chave natural do ERP (grupoDeEmpresaId +
      // empresaCodigo + codigo), que só existe depois deste upsert.
      ...tabelasDePrecoErp.map((tabela) => {
        const dados = {
          tipoDeParticipanteCodigo: tabela.TipoDeParticipanteCodigo,
          descricao: tabela.Descricao,
          descricaoTipoDeParticipante: tabela.DescricaoTipoDeParticipante ?? null,
          dataValidade: tabela.DataValidade ? new Date(tabela.DataValidade) : null,
          dataValidadeConsulta: tabela.DataValidadeConsulta ? new Date(tabela.DataValidadeConsulta) : null,
        };
        return prisma.tabelaDePrecos.upsert({
          where: {
            grupoDeEmpresaId_empresaCodigo_codigo: {
              grupoDeEmpresaId: tabela.GrupoDeEmpresaId,
              empresaCodigo: tabela.EmpresaCodigo,
              codigo: tabela.Codigo,
            },
          },
          create: {
            empresaId: empresa.id,
            grupoDeEmpresaId: tabela.GrupoDeEmpresaId,
            empresaCodigo: tabela.EmpresaCodigo,
            codigo: tabela.Codigo,
            ...dados,
          },
          update: dados,
        });
      }),
      ...tabelasDePrecoErp.flatMap((tabela) =>
        (tabela.TabelaDePrecosItens ?? []).map((item) => {
          const dados = {
            tabelaDePrecosCodigo: item.TabelaDePrecosCodigo,
            produtoCodigo: item.ProdutoCodigo,
            valor: item.Valor,
          };
          return prisma.tabelaDePrecosItem.upsert({
            where: {
              grupoDeEmpresaId_empresaCodigo_idErp: {
                grupoDeEmpresaId: item.GrupoDeEmpresaId,
                empresaCodigo: item.EmpresaCodigo,
                idErp: item.Id,
              },
            },
            create: {
              grupoDeEmpresaId: item.GrupoDeEmpresaId,
              empresaCodigo: item.EmpresaCodigo,
              idErp: item.Id,
              ...dados,
              tabelaDePrecos: {
                connect: {
                  grupoDeEmpresaId_empresaCodigo_codigo: {
                    grupoDeEmpresaId: item.GrupoDeEmpresaId,
                    empresaCodigo: item.EmpresaCodigo,
                    codigo: item.TabelaDePrecosCodigo,
                  },
                },
              },
            },
            update: dados,
          });
        }),
      ),
    ]);

    // Recalcula o parcelamento máximo a partir das formas de pagamento
    // ativas no site (já upsertadas acima) — evita consultar FormaPagamento
    // toda vez que a loja for exibida no storefront.
    const formasAtivas = await prisma.formaPagamento.findMany({
      where: { empresaId: empresa.id, usaNoSite: true },
      select: { maximoParcelas: true },
    });
    const maximoParcelas =
      formasAtivas.reduce((max, f) => Math.max(max, f.maximoParcelas), 0) || null;

    const empresaFinal = await prisma.empresa.update({
      where: { id: empresa.id },
      data: { ultimaSincronizacao: new Date(), maximoParcelas },
    });

    res.json({
      ultimaSincronizacao: empresaFinal.ultimaSincronizacao,
      vendedoresSincronizados: vendedoresErp.length,
      formasPagamentoSincronizadas: formasPagamentoErp.length,
      produtosSincronizados: produtosErp.length,
      clientesSincronizados: clientesErp.length,
      tabelasDePrecoSincronizadas: tabelasDePrecoErp.length,
    });
  }),
);

module.exports = router;
