const BRAND_COLOR = "#0b3ea8";

// Templates de e-mail transacional — HTML com estilos inline e layout em
// tabela (compatibilidade com clientes de e-mail antigos, ex.: Outlook
// desktop). A "logo" é um badge feito em HTML/CSS puro (sem imagem externa),
// para renderizar de forma consistente em qualquer cliente sem depender de
// imagens remotas bloqueadas por padrão.
function layoutBase({ tituloPreview, conteudoHtml }) {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>BFStore</title>
  </head>
  <body style="margin:0; padding:0; background-color:#f1f3f6; font-family:Arial, Helvetica, sans-serif;">
    <div style="display:none; max-height:0; overflow:hidden; opacity:0;">${tituloPreview}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f3f6; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px; background-color:#ffffff; border-radius:16px; overflow:hidden; border:1px solid #e2e5ea;">
            <tr>
              <td style="padding:32px 32px 24px 32px; text-align:center; border-bottom:1px solid #eef0f3;">
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                  <tr>
                    <td style="width:40px; height:40px; background-color:${BRAND_COLOR}; border-radius:10px; text-align:center; vertical-align:middle;">
                      <span style="font-family:Arial, Helvetica, sans-serif; font-size:18px; font-weight:700; color:#ffffff; line-height:40px;">BF</span>
                    </td>
                    <td style="padding-left:10px; font-family:Arial, Helvetica, sans-serif; font-size:20px; font-weight:700; color:#1a1d22; vertical-align:middle;">
                      BFStore
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                ${conteudoHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px; background-color:#f7f8fa; text-align:center; font-family:Arial, Helvetica, sans-serif; font-size:12px; color:#8a919e;">
                Este é um e-mail automático — por favor, não responda.<br />
                BFStore &middot; painel administrativo de lojas
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function templateRedefinirSenha({ link, expiraEmHoras = 1 }) {
  const conteudoHtml = `
    <h1 style="margin:0 0 12px 0; font-family:Arial, Helvetica, sans-serif; font-size:22px; font-weight:700; color:#1a1d22;">
      Redefinir sua senha
    </h1>
    <p style="margin:0 0 24px 0; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:22px; color:#4a5160;">
      Recebemos uma solicitação para redefinir a senha da sua conta no painel administrativo da BFStore.
      Clique no botão abaixo para escolher uma nova senha.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;">
      <tr>
        <td style="border-radius:10px; background-color:${BRAND_COLOR};">
          <a href="${link}" target="_blank" style="display:inline-block; padding:14px 28px; font-family:Arial, Helvetica, sans-serif; font-size:15px; font-weight:700; color:#ffffff; text-decoration:none; border-radius:10px;">
            Redefinir minha senha
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 8px 0; font-family:Arial, Helvetica, sans-serif; font-size:13px; line-height:20px; color:#8a919e;">
      Se o botão não funcionar, copie e cole este link no navegador:
    </p>
    <p style="margin:0 0 24px 0; font-family:Arial, Helvetica, sans-serif; font-size:13px; line-height:20px; word-break:break-all;">
      <a href="${link}" target="_blank" style="color:${BRAND_COLOR};">${link}</a>
    </p>
    <p style="margin:0; font-family:Arial, Helvetica, sans-serif; font-size:13px; line-height:20px; color:#8a919e;">
      Este link expira em ${expiraEmHoras} hora${expiraEmHoras === 1 ? "" : "s"}.
      Se você não solicitou essa alteração, pode ignorar este e-mail — sua senha atual continua válida.
    </p>
  `;

  return layoutBase({ tituloPreview: "Redefina sua senha da BFStore", conteudoHtml });
}

module.exports = { templateRedefinirSenha };
