const prisma = require("./prisma");
const { sincronizarEmpresaEmBackground } = require("./backgroundSync");

// Rede de segurança pro sync em background: pedido novo (ver
// backgroundSync.js + pedidos.routes.js) cobre o caso comum, mas uma loja
// sem pedido recente também precisa pegar produto novo/preço alterado no
// ERP de tempos em tempos. Intervalo alto de propósito — o gatilho por
// pedido já cuida da urgência das lojas ativas.
const INTERVALO_CRON_MS = 30 * 60 * 1000;

// Só N sincronizações em paralelo por rodada, mesmo com dezenas/centenas de
// empresas — cada sync já faz várias chamadas ao ERP sozinha (retornaUsuario
// + 5 endpoints em paralelo), então rodar tudo de uma vez sobrecarregaria a
// bjapi e o ERP à toa. As empresas em excesso simplesmente esperam a
// próxima vaga dentro da mesma rodada.
const CONCORRENCIA = 5;

async function executarComLimite(itens, limite, tarefa) {
  let indice = 0;
  async function worker() {
    while (indice < itens.length) {
      const item = itens[indice++];
      await tarefa(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, worker));
}

async function rodarCicloDeSincronizacao() {
  const empresas = await prisma.empresa.findMany({
    where: { ativo: true, erpLoginCifrado: { not: null }, erpSenhaCifrada: { not: null } },
    select: { id: true },
  });
  await executarComLimite(empresas, CONCORRENCIA, (empresa) =>
    sincronizarEmpresaEmBackground(empresa.id, "cron"),
  );
}

// Chamar uma vez na subida do servidor (ver index.js). Sem retorno — o
// intervalo roda pra sempre junto do processo.
function iniciarSyncScheduler() {
  setInterval(() => {
    rodarCicloDeSincronizacao().catch((err) => console.error("[sync:cron] ciclo falhou:", err));
  }, INTERVALO_CRON_MS);
}

module.exports = { iniciarSyncScheduler };
