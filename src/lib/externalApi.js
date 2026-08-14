// Helper compartilhado para consultar APIs públicas de terceiros (IBGE,
// ViaCEP, BrasilAPI) — sempre com timeout, nunca deixa a promise pendurada.
// Algumas dessas APIs (ex.: BrasilAPI, atrás de CDN) bloqueiam requisições
// sem User-Agent com 403 — o fetch nativo do Node não manda um por padrão.
async function buscarExterno(url, timeoutMs = 10000) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "bjapi/1.0", Accept: "application/json" },
    });
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
  } catch {
    return { status: 0, data: null };
  }
}

module.exports = { buscarExterno };
