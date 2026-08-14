// O ERP devolve uma URL "de verdade" mesmo quando o produto não tem foto —
// aponta pra um ícone genérico (SemImagem.jpg) que fica pixelado/serrilhado
// quando exibido em destaque. Tratamos essa URL como "sem imagem" pra que o
// front use o próprio placeholder (mais agradável) em vez dela.
function ehImagemPlaceholder(url) {
  if (!url) return true;
  return /sem[-_]?imagem/i.test(url);
}

function imagemValida(url) {
  return ehImagemPlaceholder(url) ? null : url;
}

module.exports = { ehImagemPlaceholder, imagemValida };
