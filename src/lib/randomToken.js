const crypto = require("crypto");

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function gerarIdentificacaoApi(tamanho = 10) {
  const bytes = crypto.randomBytes(tamanho);
  let out = "";
  for (let i = 0; i < tamanho; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

module.exports = { gerarIdentificacaoApi };
