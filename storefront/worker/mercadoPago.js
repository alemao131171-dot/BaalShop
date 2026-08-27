// Chamadas ao Mercado Pago (Checkout Pro). O Access Token nunca aparece no
// navegador — só e usado aqui, dentro do Worker.

const API = "https://api.mercadopago.com";

export async function criarPreferencia(env, { items, payerEmail, externalReference, backUrls, notificationUrl }) {
  const res = await fetch(`${API}/checkout/preferences`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      items,
      payer: payerEmail ? { email: payerEmail } : undefined,
      external_reference: externalReference,
      notification_url: notificationUrl,
      back_urls: backUrls,
      auto_return: "approved",
      statement_descriptor: "BAALSHOP RECARGAS",
      payment_methods: { installments: 5 }, // maximo de parcelas no cartao
    }),
  });
  if (!res.ok) throw new Error("Erro ao criar preferencia no Mercado Pago: " + (await res.text()));
  return res.json();
}

export async function buscarPagamento(env, paymentId) {
  const res = await fetch(`${API}/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error("Erro ao consultar pagamento no Mercado Pago: " + (await res.text()));
  return res.json();
}
