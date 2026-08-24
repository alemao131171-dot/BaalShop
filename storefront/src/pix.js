// Gera o payload "Pix Copia e Cola" (BR Code) no formato EMV do Banco Central.
// 100% client-side, sem gateway/API de banco — por isso nao ha confirmacao
// automatica de pagamento: a equipe confere o extrato e so depois atribui o
// codigo no admin.

function sanitize(str, maxLen) {
  return (str || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove acentos
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "") // so letras/numeros/espaco, conforme spec do BR Code
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function emv(id, value) {
  const len = String(value.length).padStart(2, "0");
  return id + len + value;
}

// CRC16/CCITT-FALSE (poly 0x1021, init 0xFFFF) exigido pelo campo final do BR Code
function crc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

// { chave, nome, cidade, valor, txid }
export function buildPixPayload({ chave, nome, cidade, valor, txid }) {
  const nomeOk = sanitize(nome, 25) || "BAALSHOP";
  const cidadeOk = sanitize(cidade, 15) || "SAO PAULO";
  const txidOk = (txid || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "***";
  const valorStr = Number(valor || 0).toFixed(2);

  const merchantAccount = emv("00", "BR.GOV.BCB.PIX") + emv("01", String(chave).trim());

  let payload =
    emv("00", "01") +
    emv("01", "12") + // "12" = QR dinamico/uso unico (valor fixo, nao reutilizavel)
    emv("26", merchantAccount) +
    emv("52", "0000") +
    emv("53", "986") +
    emv("54", valorStr) +
    emv("58", "BR") +
    emv("59", nomeOk) +
    emv("60", cidadeOk) +
    emv("62", emv("05", txidOk));

  payload += "6304"; // ID+LEN do proprio campo do CRC, exigido antes de calcular
  return payload + crc16(payload);
}
