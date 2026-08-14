require("dotenv").config();

const prisma = require("../src/lib/prisma");
const { hashPassword } = require("../src/lib/hash");

async function main() {
  const username = process.env.SEED_SUPER_USER || "super";
  const senha = process.env.SEED_SUPER_PASSWORD || "super123";

  const existente = await prisma.usuario.findUnique({ where: { username } });
  if (existente) {
    console.log(`Usuário SUPER "${username}" já existe, nada a fazer.`);
    return;
  }

  await prisma.usuario.create({
    data: {
      role: "SUPER",
      username,
      passwordHash: await hashPassword(senha),
      email: "super@bfstore.local",
    },
  });

  console.log(`Usuário SUPER criado: ${username} / ${senha}`);
  console.log("Troque essa senha assim que possível.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
