const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth.routes");
const empresasRoutes = require("./routes/empresas.routes");
const usuariosRoutes = require("./routes/usuarios.routes");
const integracaoRoutes = require("./routes/integracao.routes");
const vendedoresRoutes = require("./routes/vendedores.routes");
const formasPagamentoRoutes = require("./routes/formasPagamento.routes");
const lojaConfigRoutes = require("./routes/lojaConfig.routes");
const bairrosRoutes = require("./routes/bairros.routes");
const produtosRoutes = require("./routes/produtos.routes");
const gruposProdutosRoutes = require("./routes/gruposProdutos.routes");
const tabelasDePrecoRoutes = require("./routes/tabelasDePreco.routes");
const localidadesRoutes = require("./routes/localidades.routes");
const onboardingRoutes = require("./routes/onboarding.routes");
const cuponsRoutes = require("./routes/cupons.routes");
const cnpjRoutes = require("./routes/cnpj.routes");
const pedidosRoutes = require("./routes/pedidos.routes");
const contatoRoutes = require("./routes/contato.routes");
const { errorHandler } = require("./middleware/errorHandler");

const app = express();

app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",") ?? "*",
  }),
);
// Limite maior que o padrão (100kb) para caber a logo da loja, enviada como
// data URL base64 no corpo JSON.
app.use(express.json({ limit: "5mb" }));

app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "bjapi rodando" });
});

app.use("/api/auth", authRoutes);
app.use("/api/empresas", empresasRoutes);
app.use("/api/usuarios", usuariosRoutes);
app.use("/api/integracao", integracaoRoutes);
app.use("/api/vendedores", vendedoresRoutes);
app.use("/api/formas-pagamento", formasPagamentoRoutes);
app.use("/api/loja-config", lojaConfigRoutes);
app.use("/api/bairros", bairrosRoutes);
app.use("/api/produtos", produtosRoutes);
app.use("/api/grupos-produtos", gruposProdutosRoutes);
app.use("/api/tabelas-preco", tabelasDePrecoRoutes);
app.use("/api/localidades", localidadesRoutes);
app.use("/api/onboarding", onboardingRoutes);
app.use("/api/cupons", cuponsRoutes);
app.use("/api/cnpj", cnpjRoutes);
app.use("/api/pedidos", pedidosRoutes);
app.use("/api/contato", contatoRoutes);

app.use((_req, res) => {
  res.status(404).json({ message: "Rota não encontrada." });
});

app.use(errorHandler);

module.exports = app;
