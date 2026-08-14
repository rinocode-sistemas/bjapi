const { Router } = require("express");
const { HttpError } = require("../lib/httpError");
const { asyncHandler } = require("../lib/asyncHandler");
const { buscarExterno } = require("../lib/externalApi");

const router = Router();

// Pública — consulta de CNPJ (BrasilAPI, dado público da Receita Federal),
// usada no checkout pra autopreencher razão social/endereço quando o
// cliente informa CNPJ em vez de CPF.
router.get(
  "/:cnpj",
  asyncHandler(async (req, res) => {
    const cnpj = req.params.cnpj.replace(/\D/g, "");
    if (cnpj.length !== 14) throw new HttpError(400, "CNPJ inválido.");

    const { status, data } = await buscarExterno(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
    if (status === 404) throw new HttpError(404, "CNPJ não encontrado.");
    if (status < 200 || status >= 300 || !data) {
      throw new HttpError(502, "Não foi possível consultar o CNPJ.");
    }

    res.json({
      cnpj: data.cnpj ?? cnpj,
      razaoSocial: data.razao_social ?? null,
      nomeFantasia: data.nome_fantasia || null,
      cep: data.cep != null ? String(data.cep) : null,
      logradouro: data.logradouro || null,
      numero: data.numero || null,
      bairro: data.bairro || null,
      cidade: data.municipio || null,
      estado: data.uf || null,
    });
  }),
);

module.exports = router;
