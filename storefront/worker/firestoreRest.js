// Cliente minimo do Firestore REST API para uso dentro do Cloudflare Worker
// (runtime V8 isolado, sem Node.js — por isso nao usamos o firebase-admin SDK).
// Autentica como uma Service Account do Google (bypassa as regras do Firestore,
// igual o Admin SDK faria — por isso a chave fica só como secret no Cloudflare,
// nunca no código).

const PROJECT_ID = "baalshopgiftcards";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

function b64urlFromBytes(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlFromString(str) {
  return b64urlFromBytes(new TextEncoder().encode(str));
}

function pemToDer(pem) {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

let cachedToken = null; // { token, exp } — sobrevive entre requests no mesmo isolate do Worker

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64urlFromString(JSON.stringify(header))}.${b64urlFromString(JSON.stringify(claims))}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64urlFromBytes(new Uint8Array(sig))}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error("Falha ao autenticar service account: " + (await res.text()));
  const data = await res.json();
  cachedToken = { token: data.access_token, exp: now + data.expires_in };
  return cachedToken.token;
}

// ── Conversao entre JSON simples e o formato "fields" do Firestore REST ──
function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === "object") return { mapValue: { fields: toFirestoreFields(v) } };
  return { stringValue: String(v) };
}
function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFirestoreValue(v);
  return fields;
}
function fromFirestoreValue(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return parseInt(v.integerValue, 10);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return { seconds: Math.floor(new Date(v.timestampValue).getTime() / 1000) };
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ("mapValue" in v) return fromFirestoreFields(v.mapValue.fields || {});
  return null;
}
function fromFirestoreFields(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields || {})) obj[k] = fromFirestoreValue(v);
  return obj;
}
function docIdFromName(name) {
  return name.split("/").pop();
}

async function authedFetch(env, url, opts = {}) {
  const token = await getAccessToken(env);
  return fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
}

export async function firestoreGetDoc(env, collection, id) {
  const res = await authedFetch(env, `${FIRESTORE_BASE}/${collection}/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore GET ${collection}/${id} falhou: ${await res.text()}`);
  const json = await res.json();
  return { id, name: json.name, updateTime: json.updateTime, ...fromFirestoreFields(json.fields) };
}

// Query simples: WHERE de igualdade (equality-only), sem orderBy, sem limite obrigatorio.
export async function firestoreQuery(env, collection, wheres, limit) {
  const structuredQuery = {
    from: [{ collectionId: collection }],
    where: {
      compositeFilter: {
        op: "AND",
        filters: wheres.map(([field, value]) => ({
          fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: toFirestoreValue(value) },
        })),
      },
    },
  };
  if (limit) structuredQuery.limit = limit;
  const res = await authedFetch(env, `${FIRESTORE_BASE}:runQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery }),
  });
  if (!res.ok) throw new Error(`Firestore runQuery em ${collection} falhou: ${await res.text()}`);
  const rows = await res.json();
  return rows
    .filter((r) => r.document)
    .map((r) => ({ id: docIdFromName(r.document.name), name: r.document.name, updateTime: r.document.updateTime, ...fromFirestoreFields(r.document.fields) }));
}

export async function firestorePatch(env, collection, id, data) {
  const fieldPaths = Object.keys(data).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const res = await authedFetch(env, `${FIRESTORE_BASE}/${collection}/${id}?${fieldPaths}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: toFirestoreFields(data) }),
  });
  if (!res.ok) throw new Error(`Firestore PATCH ${collection}/${id} falhou: ${await res.text()}`);
  return res.json();
}

// Transacao real (beginTransaction + commit com precondicao de updateTime) para
// atribuir 1 giftcard disponivel a 1 pedido sem risco de corrida entre pagamentos
// simultaneos — mesma logica do admin (atribuirCodigo), só que do lado do servidor.
export async function assignGiftcardTransactional(env, categoria, pedido, extraFields = {}) {
  const beginRes = await authedFetch(env, `${FIRESTORE_BASE}:beginTransaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!beginRes.ok) throw new Error("Falha ao iniciar transacao: " + (await beginRes.text()));
  const { transaction } = await beginRes.json();

  const candidatos = await firestoreQuery(env, "giftcards", [["categoria", categoria], ["usado", false]], 1);
  if (!candidatos.length) return null;
  const card = candidatos[0];

  const hoje = new Date().toISOString().slice(0, 10);
  const commitRes = await authedFetch(env, `${FIRESTORE_BASE}:commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transaction,
      writes: [
        {
          update: { name: card.name, fields: toFirestoreFields({ usado: true, dataUso: hoje, clienteNome: pedido.clienteNome || null, clienteId: null }) },
          updateMask: { fieldPaths: ["usado", "dataUso", "clienteNome", "clienteId"] },
          currentDocument: { updateTime: card.updateTime },
        },
        {
          update: {
            name: `projects/${PROJECT_ID}/databases/(default)/documents/pedidos/${pedido.id}`,
            fields: toFirestoreFields({
              status: "atribuido",
              codigo: card.code || "",
              giftcardId: card.id,
              atribuidoEm: new Date().toISOString(),
              atribuidoPor: "mercadopago-auto",
              ...extraFields,
            }),
          },
          updateMask: { fieldPaths: ["status", "codigo", "giftcardId", "atribuidoEm", "atribuidoPor", ...Object.keys(extraFields)] },
          currentDocument: { updateTime: pedido.updateTime },
        },
      ],
    }),
  });
  if (!commitRes.ok) {
    // Corrida: outro pagamento pegou o mesmo card ou o pedido mudou entre o GET e o commit.
    // Deixa o pedido como "pago" para o admin resolver manualmente em vez de tentar de novo,
    // ja que o webhook do Mercado Pago pode chamar de novo por conta propria.
    return { conflito: true };
  }
  return { codigo: card.code || "" };
}
