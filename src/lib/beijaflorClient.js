const https = require("https");
const { URL } = require("url");

const BASE_URL = "https://api.beijaflorerp.com.br";

class BeijaflorApiError extends Error {}

// Node's fetch recusa corpo em requisições GET ("Request with GET/HEAD method
// cannot have body"), mas a API do beijaflor exige GET com corpo em
// RetornaVendedores — por isso usamos o módulo https puro aqui, que não tem
// essa restrição.
function requestJson(urlString, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode ?? 0, data: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function retornaUsuario(login, senha) {
  const { status, data } = await requestJson(`${BASE_URL}/api/mobilidade/retornausuario`, {
    method: "POST",
    body: { login, senha },
  });
  if (status < 200 || status >= 300) {
    throw new BeijaflorApiError(
      "Não foi possível autenticar no beijaflor ERP. Verifique login e senha.",
    );
  }
  if (!data || !data.TokenAcesso) {
    throw new BeijaflorApiError("Resposta inesperada do beijaflor ERP ao autenticar.");
  }
  return data;
}

async function retornaVendedores({ token, identificacao, empresaCodigo, configuracaoInicial }) {
  const url = `${BASE_URL}/api/mobilidade/RetornaVendedores?empresaCodigo=${encodeURIComponent(empresaCodigo)}`;
  const { status, data } = await requestJson(url, {
    method: "GET",
    headers: { token },
    body: {
      identificacao,
      configuracaoinicial: configuracaoInicial ? "true" : "false",
      empresacodigo: String(empresaCodigo),
    },
  });
  if (status < 200 || status >= 300) {
    throw new BeijaflorApiError("Não foi possível buscar os vendedores no beijaflor ERP.");
  }
  if (!Array.isArray(data)) {
    throw new BeijaflorApiError("Resposta inesperada do beijaflor ERP ao buscar vendedores.");
  }
  return data;
}

async function retornaFormasPagamento({ token, identificacao, empresaCodigo, configuracaoInicial }) {
  const url = `${BASE_URL}/api/mobilidade/RetornaFormasPagamento?empresaCodigo=${encodeURIComponent(empresaCodigo)}`;
  const { status, data } = await requestJson(url, {
    method: "GET",
    headers: { token },
    body: {
      identificacao,
      configuracaoinicial: configuracaoInicial ? "true" : "false",
      empresacodigo: String(empresaCodigo),
    },
  });
  if (status < 200 || status >= 300) {
    throw new BeijaflorApiError("Não foi possível buscar as formas de pagamento no beijaflor ERP.");
  }
  if (!Array.isArray(data)) {
    throw new BeijaflorApiError("Resposta inesperada do beijaflor ERP ao buscar formas de pagamento.");
  }
  return data;
}

async function retornaTodosProdutos({ token, identificacao, empresaCodigo, configuracaoInicial }) {
  const url = `${BASE_URL}/api/mobilidade/RetornaTodosProdutos?empresaCodigo=${encodeURIComponent(empresaCodigo)}`;
  const { status, data } = await requestJson(url, {
    method: "POST",
    headers: { token },
    body: {
      identificacao,
      configuracaoinicial: configuracaoInicial ? "true" : "false",
      empresacodigo: String(empresaCodigo),
    },
  });
  if (status < 200 || status >= 300) {
    throw new BeijaflorApiError("Não foi possível buscar os produtos no beijaflor ERP.");
  }
  if (!Array.isArray(data)) {
    throw new BeijaflorApiError("Resposta inesperada do beijaflor ERP ao buscar produtos.");
  }
  return data;
}

async function retornaTodosClientes({ token, identificacao, empresaCodigo, configuracaoInicial }) {
  const url = `${BASE_URL}/api/mobilidade/RetornaTodosClientes?empresaCodigo=${encodeURIComponent(empresaCodigo)}`;
  const { status, data } = await requestJson(url, {
    method: "POST",
    headers: { token },
    body: {
      identificacao,
      configuracaoinicial: configuracaoInicial ? "true" : "false",
      empresacodigo: String(empresaCodigo),
    },
  });
  if (status < 200 || status >= 300) {
    throw new BeijaflorApiError("Não foi possível buscar os clientes no beijaflor ERP.");
  }
  if (!Array.isArray(data)) {
    throw new BeijaflorApiError("Resposta inesperada do beijaflor ERP ao buscar clientes.");
  }
  return data;
}

async function retornaTabelasDePrecoComItens({
  token,
  identificacao,
  empresaCodigo,
  configuracaoInicial,
}) {
  const url = `${BASE_URL}/api/mobilidade/RetornaTabelasDePrecoComItens?empresaCodigo=${encodeURIComponent(empresaCodigo)}`;
  const { status, data } = await requestJson(url, {
    method: "POST",
    headers: { token },
    body: {
      identificacao,
      configuracaoinicial: configuracaoInicial ? "true" : "false",
      empresacodigo: String(empresaCodigo),
    },
  });
  if (status < 200 || status >= 300) {
    throw new BeijaflorApiError("Não foi possível buscar as tabelas de preço no beijaflor ERP.");
  }
  if (!Array.isArray(data)) {
    throw new BeijaflorApiError("Resposta inesperada do beijaflor ERP ao buscar tabelas de preço.");
  }
  return data;
}

// Confirma o pedido no ERP (venda "offline", registrada pelo app mobile).
// `PedidoExterno` precisa ser único por empresa no beijaflor — em duplicata
// ele responde 400 com "Pedido já consta no beija-flor com número: X"; sinalizamos
// isso via `err.duplicado` pro chamador decidir se tenta de novo com outro id.
async function gerarVendaMobilidadeOffline({ token, venda }) {
  const { status, data } = await requestJson(
    `${BASE_URL}/api/mobilidade/GerarVendaMobilidadeOffLine`,
    {
      method: "POST",
      headers: { token },
      body: venda,
    },
  );
  if (status < 200 || status >= 300) {
    const mensagem =
      (data && typeof data === "object" && typeof data.Message === "string" && data.Message) ||
      "Não foi possível enviar o pedido ao beijaflor ERP.";
    const err = new BeijaflorApiError(mensagem);
    err.duplicado = /já consta/i.test(mensagem);
    throw err;
  }
  if (data == null) {
    throw new BeijaflorApiError("Resposta inesperada do beijaflor ERP ao enviar o pedido.");
  }
  return data;
}

module.exports = {
  retornaUsuario,
  retornaVendedores,
  retornaFormasPagamento,
  retornaTodosProdutos,
  retornaTodosClientes,
  retornaTabelasDePrecoComItens,
  gerarVendaMobilidadeOffline,
  BeijaflorApiError,
};
