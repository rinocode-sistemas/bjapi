const { verifyToken } = require("../lib/jwt");
const { HttpError } = require("../lib/httpError");

function authenticate(req, _res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return next(new HttpError(401, "Token não informado."));
  }

  try {
    req.auth = verifyToken(token);
    next();
  } catch {
    next(new HttpError(401, "Token inválido ou expirado."));
  }
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return next(new HttpError(403, "Você não tem permissão para acessar este recurso."));
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
