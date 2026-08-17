const crypto = require("crypto");
const { Prisma } = require("@prisma/client");

const TAMANHO_LOTE_PADRAO = 500;

// Upsert de N linhas por lote via um único INSERT ... ON CONFLICT DO UPDATE
// multi-linha, em vez de um upsert por linha. A sincronização com o ERP
// grava potencialmente milhares de produtos/itens de tabela de preço — um
// upsert por linha significa uma ida-e-volta de rede por linha (o Postgres
// é remoto, não local), o que domina o tempo total. Um INSERT com centenas
// de linhas paga essa latência uma vez só por lote.
//
// `id`/`updatedAt` nunca vêm de fora: id é gerado aqui (o @default(cuid())
// do schema roda só dentro do client do Prisma, não existe como DEFAULT no
// Postgres) e updatedAt sempre now() — combinando com o comportamento do
// prisma.upsert() normal. Colunas com DEFAULT próprio no banco (ex.:
// usaNoSite, ativo) e que não devem ser tocadas pela sincronização
// simplesmente não entram em `colunas`.
//
// tx: client/transação Prisma (precisa expor $executeRaw).
// tabela: nome exato do model (sem @@map no schema = nome da tabela).
// colunas: colunas a inserir/atualizar, na ordem — sem "id"/"createdAt"/"updatedAt".
// conflito: colunas da constraint única usada no ON CONFLICT.
// linhas: array de objetos com as mesmas chaves de `colunas`.
async function upsertEmLote(tx, tabela, colunas, conflito, linhas, tamanhoLote = TAMANHO_LOTE_PADRAO) {
  if (linhas.length === 0) return;

  const paraAtualizar = colunas.filter((c) => !conflito.includes(c));
  const colunasComExtras = ["id", ...colunas, "updatedAt"];
  const colunasSql = Prisma.raw(colunasComExtras.map((c) => `"${c}"`).join(", "));
  const conflitoSql = Prisma.raw(conflito.map((c) => `"${c}"`).join(", "));
  const setSql = Prisma.raw(
    [...paraAtualizar.map((c) => `"${c}" = EXCLUDED."${c}"`), `"updatedAt" = now()`].join(", "),
  );
  const tabelaSql = Prisma.raw(`"${tabela}"`);

  for (let i = 0; i < linhas.length; i += tamanhoLote) {
    const pedaco = linhas.slice(i, i + tamanhoLote);
    const valoresSql = Prisma.join(
      pedaco.map(
        (linha) =>
          Prisma.sql`(${Prisma.join([crypto.randomUUID(), ...colunas.map((c) => linha[c] ?? null), new Date()])})`,
      ),
    );

    await tx.$executeRaw`
      INSERT INTO ${tabelaSql} (${colunasSql})
      VALUES ${valoresSql}
      ON CONFLICT (${conflitoSql})
      DO UPDATE SET ${setSql}
    `;
  }
}

module.exports = { upsertEmLote };
