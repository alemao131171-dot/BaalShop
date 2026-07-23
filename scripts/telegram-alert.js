const admin = require('firebase-admin');

// ============================================================
// CONFIG
// ============================================================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ============================================================
// HELPERS
// ============================================================
function tipoDias(tipo) {
  if (tipo === 'anual') return 365;
  if (tipo === 'trimestral') return 90;
  return 30;
}

function calcVenc(dataUso, tipo) {
  if (!dataUso) return null;
  const d = new Date(dataUso + 'T12:00:00');
  d.setDate(d.getDate() + tipoDias(tipo));
  return d;
}

function escTg(s) {
  return s.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

function fmtDate(d) {
  return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('Carregando dados do Firestore...');

  const cardsSnap = await db.collection('giftcards').get();
  const cards = cardsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  console.log(`Total de cards: ${cards.length}`);

  const hoje = new Date();
  const usados = cards.filter(c => c.usado && c.clienteId && c.dataUso);

  // Agrupar por cliente
  const porCliente = {};
  usados.forEach(c => {
    if (!porCliente[c.clienteId]) porCliente[c.clienteId] = [];
    porCliente[c.clienteId].push(c);
  });

  const vencidos = [];
  const aVencer = [];

  Object.entries(porCliente).forEach(([cliId, arr]) => {
    // Pegar a licenca com vencimento mais recente
    arr.sort((a, b) => (calcVenc(b.dataUso, b.tipo) || 0) - (calcVenc(a.dataUso, a.tipo) || 0));
    const ultimo = arr[0];
    const venc = calcVenc(ultimo.dataUso, ultimo.tipo);
    if (!venc) return;

    const diff = Math.ceil((venc - hoje) / (1000 * 60 * 60 * 24));
    const info = {
      nome: ultimo.clienteNome || 'Sem nome',
      desc: ultimo.desc,
      tipo: ultimo.tipo,
      cat: ultimo.categoria || '',
      vencStr: fmtDate(venc),
      dias: Math.abs(diff)
    };

    if (diff < 0) vencidos.push(info);
    else if (diff <= 7) aVencer.push(info);
  });

  if (!vencidos.length && !aVencer.length) {
    console.log('Nenhum cliente pendente ou a vencer. Nada a enviar.');
    return;
  }

  // Montar mensagem
  let msg = '🔔 *Alerta Gift Cards \\- BaalShop*\n\n';
  msg += '📅 ' + escTg(fmtDate(hoje)) + '\n\n';

  if (vencidos.length) {
    msg += '🔴 *LICENCAS VENCIDAS \\(' + vencidos.length + '\\)*\n';
    vencidos.forEach(v => {
      msg += '• ' + escTg(v.nome) + ' \\- ' + escTg(v.desc) + ' \\(' + escTg(v.tipo) + '\\)\n';
      msg += '  Venceu: ' + escTg(v.vencStr) + ' \\(' + v.dias + ' dias\\)\n';
    });
    msg += '\n';
  }

  if (aVencer.length) {
    msg += '🟡 *A VENCER EM 7 DIAS \\(' + aVencer.length + '\\)*\n';
    aVencer.forEach(v => {
      msg += '• ' + escTg(v.nome) + ' \\- ' + escTg(v.desc) + ' \\(' + escTg(v.tipo) + '\\)\n';
      msg += '  Vence: ' + escTg(v.vencStr) + ' \\(' + v.dias + ' dias\\)\n';
    });
  }

  const ativos = cards.filter(c => !c.usado).length;
  const usadosTotal = cards.filter(c => c.usado).length;
  msg += '\n📊 Total: ' + cards.length + ' licencas \\| ' + ativos + ' ativas \\| ' + usadosTotal + ' usadas';

  // Enviar via Telegram
  console.log('Enviando alerta no Telegram...');

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: 'MarkdownV2'
      })
    }
  );

  const result = await response.json();

  if (result.ok) {
    console.log('Alerta enviado com sucesso!');
  } else {
    console.error('Erro ao enviar:', result);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
