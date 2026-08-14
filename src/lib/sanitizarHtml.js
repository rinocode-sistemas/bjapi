const sanitizeHtml = require("sanitize-html");

// Descrição de produto vinda do ERP — pode ser texto puro ou HTML rico (o
// editor do beijaflor gera link, imagem e alinhamento via style inline).
// Permite só um conjunto seguro de tags/atributos/estilos; texto puro passa
// intacto (sanitize-html não mexe em conteúdo sem tags).
const OPCOES = {
  allowedTags: [
    "p",
    "br",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "ul",
    "ol",
    "li",
    "span",
    "div",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "a",
    "img",
  ],
  allowedAttributes: {
    a: ["href", "target", "rel"],
    img: ["src", "alt", "width", "height"],
    "*": ["style"],
  },
  // Só alinhamento e dimensões — nada que permita overlay/posicionamento
  // (position, z-index, etc.) ou URLs embutidas no CSS.
  allowedStyles: {
    "*": {
      "text-align": [/^left$/, /^right$/, /^center$/, /^justify$/],
      width: [/^\d+(?:\.\d+)?(?:px|%)$/],
      height: [/^\d+(?:\.\d+)?(?:px|%)$/],
    },
  },
  // Bloqueia esquemas perigosos (ex.: "javascript:") em href/src.
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https"] },
  // Link de descrição de produto abre em nova aba, sem dar acesso da nova
  // aba de volta à página original (noopener) nem vazar o referrer.
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", {
      target: "_blank",
      rel: "noopener noreferrer",
    }),
  },
};

function sanitizarHtml(texto) {
  return sanitizeHtml(texto, OPCOES).trim();
}

// Versão só-texto (sem tags) da descrição — usada em listagens/resumos
// (ex.: item do carrinho) onde não faz sentido renderizar HTML.
function paraTextoPuro(texto) {
  return sanitizeHtml(texto, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = { sanitizarHtml, paraTextoPuro };
