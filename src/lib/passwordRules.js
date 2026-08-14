const SENHA_MSG = "A senha deve ter no mínimo 6 caracteres, com letras e números.";

function isSenhaForte(v) {
  return v.length >= 6 && /[A-Za-z]/.test(v) && /\d/.test(v);
}

module.exports = { SENHA_MSG, isSenhaForte };
