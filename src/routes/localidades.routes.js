const { Router } = require("express");
const { HttpError } = require("../lib/httpError");
const { asyncHandler } = require("../lib/asyncHandler");
const { buscarExterno } = require("../lib/externalApi");

const router = Router();
const IBGE_URL = "https://servicodados.ibge.gov.br/api/v1/localidades";

// Pública — referência geográfica (IBGE) e busca de CEP (ViaCEP). Não expõe
// nenhum dado da loja, só dados públicos de terceiros — usada tanto no
// cadastro de bairros do admin quanto no endereço de entrega do checkout.

router.get(
  "/estados",
  asyncHandler(async (_req, res) => {
    const { status, data } = await buscarExterno(`${IBGE_URL}/estados?orderBy=nome`);
    if (status < 200 || status >= 300 || !Array.isArray(data)) {
      throw new HttpError(502, "Não foi possível consultar os estados.");
    }
    res.json(data.map((estado) => ({ sigla: estado.sigla, nome: estado.nome })));
  }),
);

router.get(
  "/estados/:uf/cidades",
  asyncHandler(async (req, res) => {
    const uf = req.params.uf.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(uf)) throw new HttpError(400, "Estado inválido.");

    const { status, data } = await buscarExterno(`${IBGE_URL}/estados/${uf}/municipios?orderBy=nome`);
    if (status < 200 || status >= 300 || !Array.isArray(data)) {
      throw new HttpError(502, "Não foi possível consultar as cidades.");
    }
    res.json(data.map((cidade) => ({ id: cidade.id, nome: cidade.nome })));
  }),
);

router.get(
  "/cep/:cep",
  asyncHandler(async (req, res) => {
    const cep = req.params.cep.replace(/\D/g, "");
    if (cep.length !== 8) throw new HttpError(400, "CEP inválido.");

    const { status, data } = await buscarExterno(`https://viacep.com.br/ws/${cep}/json/`);
    if (status < 200 || status >= 300 || !data || data.erro) {
      throw new HttpError(404, "CEP não encontrado.");
    }

    res.json({
      cep: data.cep ?? null,
      logradouro: data.logradouro || null,
      bairro: data.bairro || null,
      cidade: data.localidade || null,
      estado: data.uf || null,
    });
  }),
);

module.exports = router;
