const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";

function getKey() {
  const b64 = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!b64) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY não configurado no .env");
  }
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY deve ser uma chave base64 de 32 bytes");
  }
  return key;
}

function encrypt(texto) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(texto, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decrypt(payloadBase64) {
  const payload = Buffer.from(payloadBase64, "base64");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

module.exports = { encrypt, decrypt };
