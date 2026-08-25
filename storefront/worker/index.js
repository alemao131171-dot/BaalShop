import { criarPreferencia, buscarPagamento } from "./mercadoPago.js";
import { firestoreQuery, firestorePatch, assignGiftcardTransactional } from "./firestoreRest.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

async function handleCriarPagamento(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON invalido" }, 400);
  }
  const grupoId = (body.grupoId || "").toString();
  if (!grupoId) return json({ error: "grupoId obrigatorio" }, 400);

  // Busca os pedidos direto no Firestore (nunca confia no total que o navegador manda).
  const pedidos = await firestoreQuery(env, "pedidos", [["grupoId", grupoId], ["status", "pendente"]]);
  if (!pedidos.length) return json({ error: "Pedido não encontrado ou já processado" }, 404);

  // Agrupa itens iguais (mesma categoria+valor) para o resumo no Mercado Pago ficar limpo.
  const porItem = {};
  for (const p of pedidos) {
    const key = `${p.categoria}__${p.valor}`;
    if (!porItem[key]) porItem[key] = { title: p.categoria, unit_price: p.valor, quantity: 0 };
    porItem[key].quantity++;
  }
  const items = Object.values(porItem);

  const origin = new URL(request.url).origin;
  let pref;
  try {
    pref = await criarPreferencia(env, {
      items,
      payerEmail: pedidos[0].clienteEmail || undefined,
      externalReference: grupoId,
      notificationUrl: `${origin}/api/mp-webhook`,
      backUrls: {
        success: `${origin}/?checkout=sucesso`,
        pending: `${origin}/?checkout=pendente`,
        failure: `${origin}/?checkout=falhou`,
      },
    });
  } catch (e) {
    return json({ error: e.message }, 502);
  }

  const isTest = (env.MP_ACCESS_TOKEN || "").startsWith("TEST-");
  const url = isTest ? pref.sandbox_init_point : pref.init_point;
  return json({ url });
}

// Le a coleção "cupons" com a service account (bypassa as regras do Firestore) para
// nunca precisar abrir leitura publica dessa coleção — assim ninguem consegue listar
// todos os codigos de cupom direto pelo SDK do cliente.
async function handleValidarCupom(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ valido: false, motivo: "JSON invalido" }, 400);
  }
  const codigo = (body.codigo || "").toString().trim().toUpperCase();
  const total = Number(body.total) || 0;
  if (!codigo) return json({ valido: false, motivo: "Digite um código de cupom" }, 400);

  const cupons = await firestoreQuery(env, "cupons", [["codigo", codigo]], 1);
  if (!cupons.length) return json({ valido: false, motivo: "Cupom não encontrado" });
  const c = cupons[0];

  if (c.ativo === false) return json({ valido: false, motivo: "Este cupom não está mais ativo" });
  if (c.validoAte) {
    const hoje = new Date().toISOString().slice(0, 10);
    if (c.validoAte < hoje) return json({ valido: false, motivo: "Este cupom expirou" });
  }
  if (c.valorMinimo != null && total < c.valorMinimo) {
    return json({ valido: false, motivo: `Pedido mínimo de R$ ${c.valorMinimo.toFixed(2)} para usar este cupom` });
  }

  return json({ valido: true, codigo: c.codigo, tipo: c.tipo, valor: c.valor });
}

// Tenta atribuir um giftcard disponivel a cada pedido via transacao (mesma logica do
// "Atribuir Codigo" do admin); se nao houver estoque, deixa "pago" para atribuicao manual.
// Usado tanto pelo webhook do Mercado Pago quanto pelo pedido 100% gratis (cupom de 100%).
async function confirmarEAtribuir(env, pedidos, extraBase) {
  const agora = new Date().toISOString();
  for (const pedido of pedidos) {
    try {
      const resultado = await assignGiftcardTransactional(env, pedido.categoria, pedido, { ...extraBase, pagoEm: agora });
      if (!resultado || resultado.conflito) {
        await firestorePatch(env, "pedidos", pedido.id, { status: "pago", ...extraBase, pagoEm: agora });
      }
    } catch (e) {
      console.error("Erro ao atribuir codigo automaticamente:", e.message);
      await firestorePatch(env, "pedidos", pedido.id, { status: "pago", ...extraBase, pagoEm: agora }).catch(() => {});
    }
  }
}

// Pedido com cupom de 100% de desconto: nunca chama o Mercado Pago (nao daria pra cobrar
// R$0,00 de forma sensata). Nunca confia no navegador dizendo "isso e gratis" — reconfirma
// a soma dos valores direto no Firestore antes de liberar.
async function handleConfirmarGratis(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON invalido" }, 400);
  }
  const grupoId = (body.grupoId || "").toString();
  if (!grupoId) return json({ error: "grupoId obrigatorio" }, 400);

  const pedidos = await firestoreQuery(env, "pedidos", [["grupoId", grupoId], ["status", "pendente"]]);
  if (!pedidos.length) return json({ error: "Pedido não encontrado ou já processado" }, 404);

  const totalPedido = pedidos.reduce((s, p) => s + (p.valor || 0), 0);
  if (totalPedido > 0.009) return json({ error: "Este pedido não é gratuito" }, 400);

  await confirmarEAtribuir(env, pedidos, { origemPagamento: "cupom-100" });
  return json({ ok: true });
}

async function handleWebhook(request, env) {
  const url = new URL(request.url);
  let paymentId = url.searchParams.get("data.id") || url.searchParams.get("id");
  let type = url.searchParams.get("type") || url.searchParams.get("topic");

  if (request.method === "POST") {
    try {
      const body = await request.json();
      paymentId = paymentId || body?.data?.id;
      type = type || body?.type;
    } catch {
      // corpo vazio/nao-JSON — segue só com os query params, se tiver
    }
  }

  // Só nos interessa notificacao de pagamento; outros tipos (merchant_order etc.) so confirmamos recebimento.
  if (type !== "payment" || !paymentId) return new Response("ok", { status: 200 });

  let pagamento;
  try {
    pagamento = await buscarPagamento(env, paymentId);
  } catch (e) {
    console.error("Erro ao consultar pagamento:", e.message);
    return new Response("erro ao consultar pagamento", { status: 502 });
  }

  if (pagamento.status !== "approved") return new Response("ok", { status: 200 });

  const grupoId = pagamento.external_reference;
  if (!grupoId) return new Response("ok", { status: 200 });

  // Idempotente: se o webhook chegar mais de uma vez, na segunda chamada os pedidos
  // ja nao estarao mais "pendente" e a query volta vazia — nada e refeito.
  const pedidos = await firestoreQuery(env, "pedidos", [["grupoId", grupoId], ["status", "pendente"]]);
  if (!pedidos.length) return new Response("ok", { status: 200 });

  const totalEsperado = pedidos.reduce((s, p) => s + (p.valor || 0), 0);
  const valorPago = pagamento.transaction_amount || 0;
  const valorBate = Math.abs(totalEsperado - valorPago) < 0.01;
  const agora = new Date().toISOString();

  if (!valorBate) {
    // Valor pago nao confere com o esperado — nao arrisca atribuir codigo sozinho,
    // deixa "pago" para o admin conferir manualmente.
    for (const pedido of pedidos) {
      await firestorePatch(env, "pedidos", pedido.id, { status: "pago", mpPaymentId: String(paymentId), pagoEm: agora });
    }
    return new Response("ok", { status: 200 });
  }

  await confirmarEAtribuir(env, pedidos, { mpPaymentId: String(paymentId) });
  return new Response("ok", { status: 200 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/criar-pagamento" && request.method === "POST") {
        return await handleCriarPagamento(request, env);
      }
      if (url.pathname === "/api/validar-cupom" && request.method === "POST") {
        return await handleValidarCupom(request, env);
      }
      if (url.pathname === "/api/confirmar-pedido-gratis" && request.method === "POST") {
        return await handleConfirmarGratis(request, env);
      }
      if (url.pathname === "/api/mp-webhook") {
        return await handleWebhook(request, env);
      }
    } catch (e) {
      console.error("Erro no worker:", e);
      return json({ error: "Erro interno" }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};
