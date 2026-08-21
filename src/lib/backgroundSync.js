const prisma = require("./prisma");
const { sincronizarEmpresaComErp } = require("./sincronizarErp");

// Intervalo mínimo entre duas sincronizações da mesma empresa disparadas em
// background (pedido novo ou cron) — evita martelar o ERP numa rajada de
// pedidos; uma sincronização manual (botão do admin) não passa por aqui e
// nunca é bloqueada por isso.
const INTERVALO_MINIMO_MS = 5 * 60 * 1000;

// Só em memória (single instance, ver conversa do plano) — não precisa
// sobreviver a restart: na pior hipótese perde o debounce e sincroniza um
// pouco antes do necessário.
const ultimaTentativaPorEmpresa = new Map();
const emAndamento = new Set();

// Nunca lança — é sempre chamada "no escuro" (sem await, fire-and-forget)
// tanto pelo pedido novo quanto pelo cron; qualquer erro só é logado.
async function sincronizarEmpresaEmBackground(empresaId, motivo) {
  if (emAndamento.has(empresaId)) return;

  const ultimaTentativa = ultimaTentativaPorEmpresa.get(empresaId);
  if (ultimaTentativa && Date.now() - ultimaTentativa < INTERVALO_MINIMO_MS) return;

  emAndamento.add(empresaId);
  ultimaTentativaPorEmpresa.set(empresaId, Date.now());

  try {
    const empresa = await prisma.empresa.findUnique({ where: { id: empresaId } });
    if (!empresa || !empresa.erpLoginCifrado || !empresa.erpSenhaCifrada) return;

    const resultado = await sincronizarEmpresaComErp(prisma, empresa);
    console.log(
      `[sync:${motivo}] ${empresa.slug}: ${resultado.produtosSincronizados} produto(s), ${resultado.clientesSincronizados} cliente(s).`,
    );
  } catch (err) {
    console.error(`[sync:${motivo}] empresa ${empresaId} falhou:`, err.message || err);
  } finally {
    emAndamento.delete(empresaId);
  }
}

module.exports = { sincronizarEmpresaEmBackground };
