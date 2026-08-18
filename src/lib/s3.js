const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

// Mesmo padrão do apirinogourmet (config-backup-agendado): bucket e região
// fixos no código, só as credenciais vêm do .env.
const BUCKET_NAME = "rinocode-bjstore-logos";
const REGION = "sa-east-1";

function buildS3Client() {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY não configuradas no .env.");
  }
  return new S3Client({
    region: REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

function urlDoObjeto(key) {
  return `https://${BUCKET_NAME}.s3.${REGION}.amazonaws.com/${key}`;
}

/** Sobrescreve sempre a mesma key por empresa — sem acúmulo de arquivos órfãos a cada logo nova. */
async function subirLogo(empresaId, buffer, contentType) {
  const client = buildS3Client();
  const key = `logos/${empresaId}/logo`;
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: "public, max-age=300",
    }),
  );
  return urlDoObjeto(key);
}

async function subirLogoThumb(empresaId, buffer) {
  const client = buildS3Client();
  const key = `logos/${empresaId}/thumb.png`;
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: "image/png",
      CacheControl: "public, max-age=300",
    }),
  );
  return urlDoObjeto(key);
}

// Best-effort — se falhar (ex.: objeto já não existe), não deve travar a
// remoção da logo no banco.
async function removerLogo(empresaId) {
  try {
    const client = buildS3Client();
    await client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: `logos/${empresaId}/logo` }));
  } catch (err) {
    console.error("Falha ao remover logo do S3:", err);
  }
}

async function removerLogoThumb(empresaId) {
  try {
    const client = buildS3Client();
    await client.send(
      new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: `logos/${empresaId}/thumb.png` }),
    );
  } catch (err) {
    console.error("Falha ao remover thumb da logo do S3:", err);
  }
}

module.exports = { subirLogo, subirLogoThumb, removerLogo, removerLogoThumb };
