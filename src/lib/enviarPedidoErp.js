const crypto = require("crypto");
const { decrypt } = require("./crypto");
const { retornaUsuario, gerarVendaMobilidadeOffline, BeijaflorApiError } = require("./beijaflorClient");

function apenasDigitos(valor) {
  return String(valor ?? "").replace(/\D/g, "");
}

function formatarCpfCnpj(digitos) {
  if (digitos.length <= 11) {
    return digitos
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
  }
  return digitos
    .replace(/(\d{2})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1.$2")
    .replace(/(\d{3})(\d)/, "$1/$2")
    .replace(/(\d{4})(\d{1,2})$/, "$1-$2");
}

function formatarTelefone(digitos) {
  if (!digitos) return "";
  if (digitos.length <= 10) {
    return digitos.replace(/(\d{2})(\d{4})(\d{0,4})/, "($1)$2-$3").replace(/-$/, "");
  }
  return digitos.replace(/(\d{2})(\d{5})(\d{0,4})/, "($1)$2-$3").replace(/-$/, "");
}

function formatarCep(digitos) {
  if (digitos.length !== 8) return digitos;
  return digitos.replace(/(\d{5})(\d{3})/, "$1-$2");
}

function formatarData(data) {
  const dia = String(data.getDate()).padStart(2, "0");
  const mes = String(data.getMonth() + 1).padStart(2, "0");
  return `${dia}/${mes}/${data.getFullYear()}`;
}

function formatarEnderecoParaObservacao(pedido) {
  const numero = pedido.enderecoNumero || "S/N";
  const linha1 = `${pedido.enderecoRua}, ${numero} - ${pedido.enderecoBairro}`;
  const linha2 = `${pedido.enderecoCidade}/${pedido.enderecoEstado} - CEP ${formatarCep(apenasDigitos(pedido.enderecoCep))}`;
  return `Endereço do pedido: ${linha1}, ${linha2}`;
}

// A API do beijaflor não atualiza o endereço do cliente quando ele já existe
// cadastrado por lá — então, além dos campos Cliente*, repetimos o endereço
// deste pedido aqui em texto pra quem for separar/entregar não depender só
// do cadastro (que pode estar desatualizado). Remover quando a API for ajustada.
function montarObservacao(pedido) {
  const partes = ["Feito via ecommerce BFStore"];
  if (pedido.cupomCodigo) partes.push(`Cupom aplicado: ${pedido.cupomCodigo}`);
  partes.push(pedido.tipoOperacao === "ENTREGA" ? "Entrega" : "Retirada");
  if (pedido.enderecoRua) partes.push(formatarEnderecoParaObservacao(pedido));
  return partes.join("\n");
}

// Endereço só falta quando é retirada + CPF (a única combinação em que o
// checkout dispensa os campos de endereço — CNPJ sempre exige endereço
// completo mesmo na retirada, ver checkout.tsx). Nesse caso, cidade/UF/CEP
// vão com os dados da própria loja; o resto vira um placeholder, já que a
// API do beijaflor exige os campos mas não temos o que informar de verdade.
function montarPayload({ empresa, pedido }) {
  const cpfCnpjDigitos = apenasDigitos(pedido.clienteCpfCnpj);
  const temEndereco = Boolean(pedido.enderecoRua);

  const cidadeLoja =
    typeof empresa.erpDados?.EmpresaCidade === "string" ? empresa.erpDados.EmpresaCidade : "";
  const ufLoja = typeof empresa.erpDados?.EmpresaUF === "string" ? empresa.erpDados.EmpresaUF : "";

  const payload = {
    EmpresaCodigo: Number(empresa.empresaCodigo),
    PedidoExterno: crypto.randomUUID(),
    Data: formatarData(pedido.createdAt),
    ClienteRazao: pedido.clienteRazaoSocial || pedido.clienteNome,
    ClienteFantasia: pedido.clienteNome,
    ClienteCPF_CNPJ: formatarCpfCnpj(cpfCnpjDigitos),
    ClienteIE_RG: pedido.clienteInscricaoEstadual || "ISENTO",
    ClienteTelefone: formatarTelefone(apenasDigitos(pedido.clienteTelefone)),
    ClienteEndereco: temEndereco ? pedido.enderecoRua : "NÃO INFOR.",
    ClienteEnderecoNumero: temEndereco ? pedido.enderecoNumero || "NÃO INFOR." : "NÃO INFOR.",
    ClienteCidadeNome: temEndereco ? pedido.enderecoCidade : cidadeLoja,
    ClienteCidadeUF: temEndereco ? pedido.enderecoEstado : ufLoja,
    ClienteCEP: temEndereco
      ? formatarCep(apenasDigitos(pedido.enderecoCep))
      : formatarCep(apenasDigitos(empresa.cep)),
    ClienteBairro: temEndereco ? pedido.enderecoBairro : "NÃO INFOR.",
    ClienteEmail: "",
    ValorDoDesconto: Number(pedido.descontoCupomValor) + Number(pedido.descontoPagamentoValor),
    ValorDoFrete: Number(pedido.freteValor),
    Observacao: montarObservacao(pedido),
    itens: pedido.itens.map((item) => ({
      ProdutoCodigo: item.produtoCodigo,
      Quantidade: item.quantidade,
      ValorUnitario: Number(item.precoUnitario),
      ValorDesconto: 0,
    })),
    FormasDePagamento: pedido.pagamentos.map((p) => ({
      Codigo: p.formaPagamentoCodigo,
      Parcelas: p.parcelas,
      ValorTotal: Number(p.valor),
    })),
  };
  if (empresa.vendedorPadraoCodigo != null) {
    payload.VendedorCodigo = Number(empresa.vendedorPadraoCodigo);
  }
  return payload;
}

// Nunca lança — quem chama (aceite automático ou manual do pedido) não deve
// falhar por causa disso. Resultado sempre vai pro banco via
// statusEnvioErp/erpPedidoId/erpErro, pro admin ver e (no futuro) reenviar.
async function enviarPedidoParaErp(prisma, empresaId, pedidoId) {
  const marcarErro = async (mensagem) => {
    await prisma.pedido
      .update({ where: { id: pedidoId }, data: { statusEnvioErp: "ERRO", erpErro: mensagem } })
      .catch(() => {});
  };

  const empresa = await prisma.empresa.findUnique({ where: { id: empresaId } });
  const pedido = await prisma.pedido.findUnique({
    where: { id: pedidoId },
    include: { itens: true, pagamentos: true },
  });
  if (!empresa || !pedido) return;

  if (!empresa.erpLoginCifrado || !empresa.erpSenhaCifrada) {
    await marcarErro("Loja sem credenciais do beijaflor ERP configuradas.");
    return;
  }

  try {
    const login = decrypt(empresa.erpLoginCifrado);
    const senha = decrypt(empresa.erpSenhaCifrada);
    const usuarioErp = await retornaUsuario(login, senha);

    const payload = montarPayload({ empresa, pedido });
    let resultado;
    try {
      resultado = await gerarVendaMobilidadeOffline({ token: usuarioErp.TokenAcesso, venda: payload });
    } catch (err) {
      // "Pedido já consta" — colisão de PedidoExterno (extremamente rara com
      // UUID, mas a API já nos avisou que isso pode acontecer). Tenta uma
      // vez com um id novo antes de desistir.
      if (err instanceof BeijaflorApiError && err.duplicado) {
        payload.PedidoExterno = crypto.randomUUID();
        resultado = await gerarVendaMobilidadeOffline({ token: usuarioErp.TokenAcesso, venda: payload });
      } else {
        throw err;
      }
    }

    await prisma.pedido.update({
      where: { id: pedidoId },
      data: { statusEnvioErp: "ENVIADO", erpPedidoId: String(resultado), erpErro: null },
    });
  } catch (err) {
    const mensagem =
      err instanceof BeijaflorApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Erro desconhecido ao enviar o pedido ao ERP.";
    await marcarErro(mensagem);
  }
}

module.exports = { enviarPedidoParaErp, montarPayload };
