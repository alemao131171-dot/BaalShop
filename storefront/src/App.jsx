import { useState, useEffect, useCallback, createContext, useContext } from "react";
import QRCode from "qrcode";
import { buildPixPayload } from "./pix.js";
import { PIX_CONFIG } from "./pixConfig.js";

/*
 * BAALSHOP RECARGAS — Storefront + Firebase (baalshopgiftcards)
 *
 * Firestore collections (ver README.md para o schema completo):
 *   "catalogo" (leitura publica)      -> escrito pelo admin: {categoria, tipo, valor, disponiveis}
 *   "pedidos"  (somente criacao publica) -> 1 documento por unidade: {categoria, tipo, valor, clienteNome, clienteContato, status, criadoEm}
 *
 * O admin BaalShop (GitHub Pages) sincroniza catalogo.disponiveis
 * contando giftcards onde usado==false agrupados por categoria (syncCatalogo()).
 * O admin tambem le "pedidos" na tela "Pedidos" e atribui o codigo (Atribuir Codigo),
 * marcando o giftcard como usado e preenchendo pedido.codigo.
 *
 * IMPORTANTE: nao existe envio automatico de e-mail/WhatsApp com o codigo.
 * A entrega e manual: a equipe ve o codigo atribuido no admin e envia ao cliente
 * pelo contato informado no pedido.
 */

// ─── Firebase loader ──────────────────────────────────────────
const FB_VER = "10.12.2";
const FB_CFG = {
  apiKey: "AIzaSyCFJXTPi3-hkvqIhNGB0O_ym2PH6p_vN1g",
  authDomain: "baalshopgiftcards.firebaseapp.com",
  projectId: "baalshopgiftcards",
  storageBucket: "baalshopgiftcards.firebasestorage.app",
  messagingSenderId: "786012992709",
  appId: "1:786012992709:web:48979369d15d31724a2cac",
};

const scriptPromises = {};
function loadJS(src) {
  if (scriptPromises[src]) return scriptPromises[src];
  scriptPromises[src] = new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = src; s.onload = ok; s.onerror = fail;
    document.head.appendChild(s);
  });
  return scriptPromises[src];
}

// Cache no window (nao no modulo) para sobreviver a HMR do Vite em dev e a
// double-invoke de efeitos do React.StrictMode, evitando re-inicializar o app Firebase.
function getDB() {
  if (window.firebase && window.firebase.apps && window.firebase.apps.length) {
    return Promise.resolve(window.firebase.firestore());
  }
  if (window._fbDbPromise) return window._fbDbPromise;
  window._fbDbPromise = (async () => {
    const b = `https://www.gstatic.com/firebasejs/${FB_VER}`;
    await loadJS(`${b}/firebase-app-compat.js`);
    await loadJS(`${b}/firebase-firestore-compat.js`);
    if (!window.firebase.apps.length) window.firebase.initializeApp(FB_CFG);
    return window.firebase.firestore();
  })();
  return window._fbDbPromise;
}

// ─── Hooks ────────────────────────────────────────────────────
function useFirestore() {
  const [db, setDb] = useState(null);
  useEffect(() => { getDB().then(setDb).catch(console.error); }, []);
  return db;
}

function useCatalogo(db) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!db) return;
    const unsub = db.collection("catalogo").onSnapshot(
      (snap) => {
        const arr = [];
        snap.forEach((d) => arr.push({ id: d.id, ...d.data() }));
        setItems(arr);
        setLoading(false);
      },
      () => setLoading(false)
    );
    return () => unsub();
  }, [db]);
  return { items, loading };
}

// ─── Fallback (enquanto o Firebase carrega ou catalogo ainda vazio) ────
const FEATURES_POR_TIPO = {
  mensal: ["30 dias de acesso", "2 telas simultâneas", "Dispositivos Android", "Canais ao vivo + sob demanda"],
  trimestral: ["90 dias de acesso", "2 telas simultâneas", "Dispositivos Android", "Canais ao vivo + sob demanda"],
  anual: ["365 dias de acesso", "2 telas simultâneas", "Dispositivos Android", "Canais ao vivo + sob demanda"],
};

const FALLBACK = [
  { id: "unitv-mensal", categoria: "UniTV Mensal", tipo: "mensal", valor: 22, disponiveis: 0 },
  { id: "unitv-anual", categoria: "UniTV Anual", tipo: "anual", valor: 180, disponiveis: 0 },
];

function prettify(s) {
  return (s || "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || "Plano";
}

function tipoPeriodo(tipo) {
  return tipo === "anual" ? "365 dias" : tipo === "trimestral" ? "90 dias" : "30 dias";
}

// Mapeia o documento real do Firestore (schema do admin) para o shape usado na UI.
// Agrupamos por `categoria` (nao por `desc`) porque a descricao de cada giftcard
// pode ser unica por unidade (numero de serie); `categoria` e o campo estavel que
// identifica o produto. `categoriaRaw` e mantido para casar exatamente com
// giftcards.categoria na hora de criar o pedido.
function norm(doc) {
  const tipo = doc.tipo || "mensal";
  const categoriaRaw = doc.categoria || tipo;
  return {
    id: doc.id,
    categoriaRaw,
    nome: prettify(categoriaRaw),
    tipo,
    period: tipoPeriodo(tipo),
    badge: tipo === "anual" ? "Melhor custo-benefício" : null,
    preco: doc.valor != null ? doc.valor : 0,
    disponivel: doc.disponiveis ?? 0,
    features: FEATURES_POR_TIPO[tipo] || FEATURES_POR_TIPO.mensal,
  };
}

const fmt = (v) => (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

// ─── Context ──────────────────────────────────────────────────
const Ctx = createContext();
function Prov({ children }) {
  const db = useFirestore();
  const { items: raw, loading } = useCatalogo(db);
  const [cart, setCart] = useState([]);
  const [page, setPage] = useState("home");
  const [pay, setPay] = useState("pix");
  const [toast, setToast] = useState(null);

  const plans = raw.length > 0 ? raw.map(norm) : FALLBACK.map(norm);

  const flash = useCallback((m) => { setToast(m); setTimeout(() => setToast(null), 2500); }, []);

  const addToCart = useCallback((plan, q = 1) => {
    if (plan.disponivel <= 0) { flash("❌ Produto esgotado!"); return; }
    setCart(prev => {
      const ex = prev.find(i => i.plan.id === plan.id);
      if (ex) {
        if (ex.qty + q > plan.disponivel) { flash(`⚠️ Apenas ${plan.disponivel} disponível(is)`); return prev; }
        return prev.map(i => i.plan.id === plan.id ? { ...i, qty: i.qty + q } : i);
      }
      return [...prev, { plan, qty: q }];
    });
    flash(`✅ ${plan.nome} adicionado!`);
  }, [flash]);

  const updQty = useCallback((id, d) => {
    setCart(prev => prev.map(i => {
      if (i.plan.id !== id) return i;
      const n = i.qty + d;
      const cur = plans.find(p => p.id === id);
      if (n > (cur?.disponivel || 0)) return i;
      return { ...i, qty: Math.max(0, n) };
    }).filter(i => i.qty > 0));
  }, [plans]);

  const rmItem = useCallback((id) => setCart(p => p.filter(i => i.plan.id !== id)), []);
  const total = cart.reduce((s, i) => s + i.plan.preco * i.qty, 0);
  const count = cart.reduce((s, i) => s + i.qty, 0);

  // Cria 1 documento de pedido por unidade (compativel com o admin: Pedidos > Atribuir Codigo
  // busca giftcards por igualdade exata de `desc`). Um grupoId liga os itens do mesmo carrinho.
  const submitOrder = useCallback(async (cli) => {
    if (!db) throw new Error("Não foi possível conectar ao servidor. Tente novamente em instantes.");
    if (cart.length === 0) throw new Error("Carrinho vazio.");
    const grupoId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const clienteContato = cli.phone || cli.email;
    const batch = db.batch();
    let count = 0;
    cart.forEach(item => {
      for (let n = 0; n < item.qty; n++) {
        const ref = db.collection("pedidos").doc();
        batch.set(ref, {
          categoria: item.plan.categoriaRaw,
          tipo: item.plan.tipo,
          valor: item.plan.preco,
          clienteNome: cli.name,
          clienteContato,
          clienteEmail: cli.email || null,
          clienteTelefone: cli.phone || null,
          formaPagamentoPreferida: pay,
          status: "pendente",
          origem: "storefront",
          grupoId,
          criadoEm: window.firebase.firestore.FieldValue.serverTimestamp(),
        });
        count++;
      }
    });
    if (count > 400) throw new Error("Pedido muito grande, reduza a quantidade.");
    await batch.commit();
    return grupoId;
  }, [db, cart, pay]);

  return (
    <Ctx.Provider value={{ plans, cart, addToCart, updQty, rmItem, total, count, page, setPage, pay, setPay, toast, loading, submitOrder }}>
      {children}
    </Ctx.Provider>
  );
}
const use$ = () => useContext(Ctx);

// ─── Components ───────────────────────────────────────────────

function Stock({ qty }) {
  if (qty <= 0) return <span style={S.sOut}>Esgotado</span>;
  if (qty <= 5) return <span style={S.sLow}>Últimas {qty} unid.</span>;
  return <span style={S.sOk}>{qty} disponíveis</span>;
}

function Header() {
  const { count, total, setPage } = use$();
  return (
    <header style={S.hdr}>
      <div style={S.hdrIn}>
        <div style={S.lWrap} onClick={() => setPage("home")}>
          <div style={S.lIco}>⚡</div>
          <div style={S.lTxt}><span style={{ color: "#f59e0b" }}>Baal</span><span style={{ color: "#fff" }}>Shop</span><span style={S.lSub}>Recargas</span></div>
        </div>
        <nav style={S.nav}>
          <a style={S.nLnk} onClick={() => setPage("home")}>Início</a>
          <a style={S.nLnk} href="#planos" onClick={() => setPage("home")}>Planos</a>
          <a style={S.nLnk} href="#como" onClick={() => setPage("home")}>Como funciona</a>
          <a style={S.nLnk} onClick={() => setPage("download")}>Download</a>
        </nav>
        <button style={S.cBtn} onClick={() => setPage("checkout")}>
          🛒{count > 0 && <span style={S.cBdg}>{count}</span>}{total > 0 && <span style={S.cTot}>{fmt(total)}</span>}
        </button>
      </div>
    </header>
  );
}

function Hero() {
  const { loading } = use$();
  return (
    <section style={S.hero}>
      <div style={S.heroOv} />
      <div style={S.heroC}>
        <div style={S.heroBdg}>⚡ BaalShop Recargas</div>
        <h1 style={S.heroT}>Recarga <span style={{ color: "#f59e0b" }}>UniTV</span></h1>
        <p style={S.heroD}>Filmes, séries, canais ao vivo e muito mais. Peça sua recarga e receba o código combinando o pagamento com a nossa equipe.</p>
        <div style={S.heroSt}>
          <div style={S.st}><div style={S.stN}>500+</div><div style={S.stL}>Canais ao vivo</div></div>
          <div style={S.stDiv} />
          <div style={S.st}><div style={S.stN}>5.000+</div><div style={S.stL}>Filmes e séries</div></div>
          <div style={S.stDiv} />
          <div style={S.st}><div style={S.stN}>2</div><div style={S.stL}>Telas simultâneas</div></div>
        </div>
        {loading && <div style={{ color: "#f59e0b", fontSize: 13, marginBottom: 16 }}>Conectando ao estoque...</div>}
        <a href="#planos" style={S.heroCta}>Ver planos ↓</a>
      </div>
    </section>
  );
}

function Plans() {
  const { plans, addToCart, setPage, loading } = use$();
  return (
    <section id="planos" style={S.sec}>
      <h2 style={S.secT}>Escolha seu plano</h2>
      <p style={S.secS}>Faça o pedido e combinamos o pagamento (Pix ou cartão) pelo contato informado</p>
      <div style={S.pGrid}>
        {(loading ? FALLBACK.map(norm) : plans).map(plan => {
          const out = plan.disponivel <= 0;
          return (
            <div key={plan.id} style={{ ...S.pCard, ...(plan.badge ? S.pCardFt : {}), ...(out ? { opacity: .55 } : {}) }}>
              {plan.badge && <div style={S.pBdg}>{plan.badge}</div>}
              <div style={{ textAlign: "center", marginBottom: 20 }}>
                <h3 style={S.pNm}>{plan.nome}</h3>
                <div style={{ color: "#999", fontSize: 14 }}>{plan.period}</div>
                <div style={{ marginTop: 8 }}><Stock qty={plan.disponivel} /></div>
              </div>
              <div style={S.prBlk}>
                <div style={S.prMain}>{fmt(plan.preco)}</div>
              </div>
              <ul style={S.ftList}>
                {(plan.features || []).map((f, i) => <li key={i} style={S.ftItem}><span style={S.chk}>✓</span> {f}</li>)}
              </ul>
              <button style={{ ...S.buyB, ...(plan.badge ? S.buyBFt : {}), ...(out ? S.dis : {}) }} disabled={out} onClick={() => { addToCart(plan); setPage("checkout"); }}>
                {out ? "Indisponível" : "Fazer pedido"}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function How() {
  const steps = [
    { i: "🎯", t: "Escolha o plano", d: "Mensal ou Anual" },
    { i: "📝", t: "Envie seus dados", d: "Nome e WhatsApp/e-mail" },
    { i: "💬", t: "Combinamos o pagamento", d: "Pix ou cartão, por WhatsApp" },
    { i: "📺", t: "Receba e ative", d: "Nossa equipe envia o código" },
  ];
  return (
    <section id="como" style={{ ...S.sec, background: "#fef8ee" }}>
      <h2 style={S.secT}>Como funciona</h2>
      <div style={S.stGrid}>
        {steps.map((s, i) => <div key={i} style={S.stCard}><div style={S.stpN}>{i + 1}</div><div style={{ fontSize: 36, marginBottom: 12 }}>{s.i}</div><h4 style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{s.t}</h4><p style={{ fontSize: 13, color: "#888" }}>{s.d}</p></div>)}
      </div>
    </section>
  );
}

function Devs() {
  const d = [{ i: "📱", n: "Celular Android" }, { i: "📺", n: "Smart TV" }, { i: "📦", n: "TV Box" }, { i: "🔥", n: "Fire TV Stick" }, { i: "💻", n: "Tablet" }];
  return (
    <section style={S.sec}>
      <h2 style={S.secT}>Dispositivos compatíveis</h2>
      <div style={S.devG}>{d.map((x, i) => <div key={i} style={S.devC}><span style={{ fontSize: 32 }}>{x.i}</span><span style={{ fontSize: 13, fontWeight: 600, color: "#555" }}>{x.n}</span></div>)}</div>
    </section>
  );
}

function Faq() {
  const [o, setO] = useState(null);
  const q = [
    { q: "Como recebo meu gift card?", a: "Depois de combinarmos o pagamento pelo WhatsApp/e-mail informado, nossa equipe envia o código para você por lá." },
    { q: "Como ativo o código?", a: "No app UniTV, faça login, acesse a área de recarga e insira o código. A ativação é imediata." },
    { q: "Quantos dispositivos?", a: "Até 2 telas simultâneas em qualquer dispositivo Android compatível." },
    { q: "Quanto tempo demora?", a: "Normalmente entramos em contato em poucos minutos após o pedido, dentro do nosso horário de atendimento." },
    { q: "Como funciona o pagamento?", a: "Você escolhe Pix ou cartão só como preferência. Combinamos o pagamento com você pelo WhatsApp/e-mail antes de liberar o código." },
  ];
  return (
    <section style={{ ...S.sec, background: "#fef8ee" }}>
      <h2 style={S.secT}>Dúvidas frequentes</h2>
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        {q.map((x, i) => <div key={i} style={S.faqI} onClick={() => setO(o === i ? null : i)}>
          <div style={S.faqQ}><span>{x.q}</span><span style={{ fontSize: 10, color: "#aaa", transform: o === i ? "rotate(180deg)" : "rotate(0)", transition: "transform 0.2s" }}>▼</span></div>
          {o === i && <div style={{ fontSize: 14, color: "#666", lineHeight: 1.6, paddingTop: 10 }}>{x.a}</div>}
        </div>)}
      </div>
    </section>
  );
}

function Download() {
  return (
    <section style={S.sec}>
      <h2 style={S.secT}>Como baixar e ativar o UniTV</h2>
      <p style={S.secS}>Depois de receber seu código, siga o passo a passo abaixo</p>

      <div style={{ ...S.ckCd, marginBottom: 24 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>1. Baixe o app</h3>
        <p style={{ fontSize: 13, color: "#888", marginBottom: 18 }}>Para novos usuários — quem nunca instalou o UniTV no dispositivo</p>

        <div style={{ marginBottom: 18 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>📺 Link para TV</div>
          <a href="https://app.unitv-plus.site/app/unitv_RS-NPWN.apk" target="_blank" rel="noreferrer" style={S.dlLink}>
            Link original — sem propagandas
          </a>
          <a href="https://links.fileload.one/NPWN" target="_blank" rel="noreferrer" style={S.dlLink}>
            Link reduzido — sem propagandas
          </a>
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
          <div style={S.dlCode}><div style={S.dlCodeLbl}>Código Downloader</div><div style={S.dlCodeVal}>4404302</div></div>
          <div style={S.dlCode}><div style={S.dlCodeLbl}>Código NTDOWN</div><div style={S.dlCodeVal}>----</div></div>
        </div>

        <div>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>📱 Link para celular (Android)</div>
          <a href="http://mkdw.qrdldunitvss.com/download" target="_blank" rel="noreferrer" style={S.dlLink}>App Mobile</a>
        </div>
      </div>

      <div style={S.ckCd}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>2. Usuários antigos</h3>
        <p style={{ fontSize: 14, color: "#666", lineHeight: 1.6, marginBottom: 16 }}>
          Se você já instalou o UniTV antes (por outros meios ou já tem o app no dispositivo), não precisa baixar de novo —
          nossa equipe te envia um login e senha criados no Painel da UniTV junto com seu código.
        </p>
        <div style={{ padding: 16, background: "#fffbf2", borderRadius: 12 }}>
          <div style={{ fontSize: 13, marginBottom: 10, lineHeight: 1.5 }}><strong>Usuário novo</strong> = aquele que nunca instalou o UniTV no dispositivo e realiza um teste após a instalação.</div>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}><strong>Usuário antigo</strong> = alguém que já instalou o UniTV por outros meios ou já possui o aplicativo no dispositivo.</div>
        </div>
      </div>
    </section>
  );
}

function PixQrBlock({ payload }) {
  const [dataUrl, setDataUrl] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    setDataUrl(null);
    QRCode.toDataURL(payload, { margin: 1, width: 220 })
      .then((url) => { if (active) setDataUrl(url); })
      .catch(() => {});
    return () => { active = false; };
  }, [payload]);

  const copiar = () => {
    navigator.clipboard.writeText(payload).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div style={{ textAlign: "center", marginBottom: 20 }}>
      {dataUrl
        ? <img src={dataUrl} alt="QR Code Pix" style={{ width: 200, height: 200, borderRadius: 12, border: "1px solid #eee" }} />
        : <div style={{ width: 200, height: 200, margin: "0 auto", background: "#f3f3f3", borderRadius: 12 }} />}
      <p style={{ fontSize: 13, color: "#888", margin: "10px 0" }}>Escaneie com o app do seu banco ou copie o código Pix abaixo</p>
      <button type="button" onClick={copiar} style={{ background: "#d97706", color: "#fff", border: "none", borderRadius: 10, padding: "8px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
        {copied ? "✓ Copiado!" : "📋 Copiar código Pix"}
      </button>
    </div>
  );
}

function Checkout() {
  const { cart, updQty, rmItem, total, setPage, pay, setPay, plans, submitOrder } = use$();
  const [f, setF] = useState({ email: "", name: "", phone: "" });
  const [step, setSt] = useState("cart");
  const [busy, setBusy] = useState(false);
  const [oid, setOid] = useState(null);
  const [err, setErr] = useState(null);
  const up = (k, v) => setF(p => ({ ...p, [k]: v }));
  const ok = f.email && f.name;
  const sv = cart.every(i => { const c = plans.find(p => p.id === i.plan.id); return c && c.disponivel >= i.qty; });

  if (cart.length === 0 && step !== "done") return (
    <div style={S.ckC}><div style={S.emB}>
      <span style={{ fontSize: 56 }}>🛒</span>
      <h2 style={{ margin: "16px 0 8px", fontWeight: 700 }}>Carrinho vazio</h2>
      <p style={{ color: "#888", marginBottom: 24 }}>Escolha um plano para começar</p>
      <button style={S.mainBtn} onClick={() => setPage("home")}>← Ver planos</button>
    </div></div>
  );

  if (step === "done") {
    const pixAtivo = pay === "pix" && !!PIX_CONFIG.chave && !!PIX_CONFIG.cidade;
    const pixPayload = pixAtivo ? buildPixPayload({ chave: PIX_CONFIG.chave, nome: PIX_CONFIG.nome, cidade: PIX_CONFIG.cidade, valor: total, txid: oid }) : null;
    return (
      <div style={S.ckC}><div style={S.sucB}>
        <div style={{ fontSize: 56, marginBottom: 8 }}>✅</div>
        <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Pedido registrado!</h2>
        {pixAtivo ? (
          <>
            <p style={{ color: "#666", lineHeight: 1.6, marginBottom: 20 }}>
              Pague agora pelo Pix abaixo. Depois de confirmarmos o pagamento, enviamos o código para <strong style={{ color: "#d97706" }}>{f.phone || f.email}</strong>.
            </p>
            <PixQrBlock payload={pixPayload} />
          </>
        ) : (
          <p style={{ color: "#666", lineHeight: 1.6, marginBottom: 24 }}>Em breve entraremos em contato pelo<br /><strong style={{ color: "#d97706" }}>{f.phone || f.email}</strong><br />para combinar o pagamento e enviar o código.</p>
        )}
        <div style={S.sumB}>
          <div style={S.ordN}>Pedido #{oid ? oid.slice(0, 8) : "..."}</div>
          {cart.map(i => <div key={i.plan.id} style={S.sumL}><span>{i.plan.nome} × {i.qty}</span><span style={{ fontWeight: 600 }}>{fmt(i.plan.preco * i.qty)}</span></div>)}
          <div style={S.sumL}><span style={{ fontSize: 12, color: "#999" }}>Preferência: {pay === "pix" ? "Pix" : "Cartão"}</span></div>
          <div style={{ ...S.sumL, borderTop: "2px solid #e5e5e5", paddingTop: 10, marginTop: 6, fontWeight: 700, fontSize: 16 }}><span>Total estimado</span><span style={{ color: "#d97706" }}>{fmt(total)}</span></div>
        </div>
        <button style={S.mainBtn} onClick={() => setPage("home")}>Voltar ao início</button>
      </div></div>
    );
  }

  const doSubmit = async () => { setBusy(true); setErr(null); try { const id = await submitOrder(f); setOid(id); setSt("done"); } catch (e) { setErr(e.message); } finally { setBusy(false); } };

  return (
    <div style={S.ckC}>
      <button style={S.bkLnk} onClick={() => step === "cart" ? setPage("home") : setSt("cart")}>← {step === "cart" ? "Voltar aos planos" : "Voltar"}</button>
      <div style={S.ckSt}>
        {["Carrinho", "Seus dados", "Confirmação"].map((l, i) => {
          const si = ["cart", "info", "confirm"].indexOf(step);
          return <div key={i} style={{ ...S.ckStI, opacity: i <= si ? 1 : .35 }}><div style={{ ...S.ckDot, background: i <= si ? "#d97706" : "#ddd" }}>{i + 1}</div><span style={{ fontSize: 12, fontWeight: 600 }}>{l}</span></div>;
        })}
      </div>
      {!sv && <div style={S.warn}>⚠️ Alguns itens ficaram indisponíveis. Verifique as quantidades.</div>}

      {step === "cart" && <div style={S.ckCd}>
        <h2 style={S.ckTi}>Seu carrinho</h2>
        {cart.map(i => { const mx = plans.find(p => p.id === i.plan.id)?.disponivel || 0; return (
          <div key={i.plan.id} style={S.cRow}>
            <div><div style={S.cNm}>▶ {i.plan.nome}</div><div style={S.cSb}>{i.plan.period} · {fmt(i.plan.preco)}</div><div style={{ marginTop: 4 }}><Stock qty={mx} /></div></div>
            <div style={S.cRt}><div style={S.qW}><button style={S.qB} onClick={() => updQty(i.plan.id, -1)}>−</button><span style={S.qV}>{i.qty}</span><button style={S.qB} onClick={() => updQty(i.plan.id, 1)}>+</button></div><div style={S.cPr}>{fmt(i.plan.preco * i.qty)}</div><button style={S.rmB} onClick={() => rmItem(i.plan.id)}>✕</button></div>
          </div>
        ); })}
        <div style={S.totBar}><span style={{ fontSize: 16, fontWeight: 600 }}>Total</span><span style={S.totV}>{fmt(total)}</span></div>
        <button style={{ ...S.mainBtn, ...(sv ? {} : S.dis) }} disabled={!sv} onClick={() => setSt("info")}>Continuar →</button>
      </div>}

      {step === "info" && <div style={S.ckCd}>
        <h2 style={S.ckTi}>Seus dados</h2>
        <p style={{ color: "#888", fontSize: 14, marginBottom: 20 }}>Usamos esses dados só para combinar o pagamento e enviar o código</p>
        <div style={S.fRow}><label style={S.lab}>E-mail *</label><input style={S.inp} type="email" placeholder="seu@email.com" value={f.email} onChange={e => up("email", e.target.value)} /></div>
        <div style={S.fFlx}><div style={S.fHf}><label style={S.lab}>Nome completo *</label><input style={S.inp} placeholder="João da Silva" value={f.name} onChange={e => up("name", e.target.value)} /></div><div style={S.fHf}><label style={S.lab}>WhatsApp</label><input style={S.inp} placeholder="(00) 00000-0000" value={f.phone} onChange={e => up("phone", e.target.value)} /></div></div>
        <div style={S.fRow}><label style={S.lab}>Como prefere pagar?</label>
          <div style={S.ptSm}><button style={{ ...S.ptBSm, ...(pay === "pix" ? S.ptASm : {}) }} onClick={() => setPay("pix")}>📱 Pix</button><button style={{ ...S.ptBSm, ...(pay === "card" ? S.ptASm : {}) }} onClick={() => setPay("card")}>💳 Cartão</button></div>
        </div>
        <button style={{ ...S.mainBtn, opacity: ok ? 1 : .45 }} disabled={!ok} onClick={() => setSt("confirm")}>Revisar pedido →</button>
      </div>}

      {step === "confirm" && <div style={S.ckCd}>
        <h2 style={S.ckTi}>Confirmar pedido</h2>
        <div style={S.sumB}>
          {cart.map(i => <div key={i.plan.id} style={S.sumL}><span>{i.plan.nome} × {i.qty}</span><span>{fmt(i.plan.preco * i.qty)}</span></div>)}
          <div style={{ ...S.sumL, borderTop: "2px solid #eee", paddingTop: 10, marginTop: 6, fontWeight: 700 }}><span>Total estimado</span><span style={{ color: "#d97706", fontSize: 20 }}>{fmt(total)}</span></div>
        </div>
        <div style={S.payI}><div style={{ fontSize: 14, color: "#666", lineHeight: 1.6 }}>
          Ao confirmar, seu pedido fica registrado como <strong>pendente</strong>. Nossa equipe vai falar com você em <strong>{f.phone || f.email}</strong> para combinar o pagamento via {pay === "pix" ? "Pix" : "cartão"} e, depois de confirmado, enviar o código de ativação.
        </div></div>
        {err && <div style={S.errM}>{err}</div>}
        <button style={S.mainBtn} onClick={doSubmit} disabled={busy || !sv}>
          {busy ? "⏳ Enviando..." : "Confirmar pedido"}
        </button>
      </div>}
    </div>
  );
}

function Footer() {
  return (
    <footer style={S.ftr}>
      <div style={S.ftrIn}>
        <div style={S.fCol}><div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}><span style={{ background: "#d97706", color: "#fff", borderRadius: 8, width: 28, height: 28, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700 }}>⚡</span><strong>BaalShop Recargas</strong></div><p style={{ fontSize: 13, color: "#999", lineHeight: 1.5, maxWidth: 280 }}>Gift cards e recargas digitais com atendimento assistido. Não nos responsabilizamos pelo conteúdo das plataformas.</p></div>
        <div style={S.fCol}><strong style={{ fontSize: 13, display: "block", marginBottom: 10 }}>Institucional</strong><a style={S.fLnk} href="#">Termos de uso</a><a style={S.fLnk} href="#">Privacidade</a><a style={S.fLnk} href="#">Reembolso</a></div>
        <div style={S.fCol}><strong style={{ fontSize: 13, display: "block", marginBottom: 10 }}>Contato</strong><a style={S.fLnk} href="#">💬 WhatsApp</a><a style={S.fLnk} href="#">📧 contato@baalshop.com.br</a></div>
      </div>
      <div style={S.fBot}>© 2026 BaalShop Recargas · Gift cards digitais com atendimento assistido</div>
    </footer>
  );
}

function Pg() {
  const { page } = use$();
  if (page === "checkout") return <Checkout />;
  if (page === "download") return <Download />;
  return <><Hero /><Plans /><How /><Devs /><Faq /></>;
}

function AppInner() {
  const { toast } = use$();
  return (
    <div style={S.app}>
      <Header />
      {toast && <div style={S.tst}>{toast}</div>}
      <main><Pg /></main>
      <Footer />
    </div>
  );
}

export default function App() {
  return <Prov><AppInner /></Prov>;
}

// ─── Styles ───────────────────────────────────────────────────
const S = {
  app: { fontFamily: "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", background: "#fff", color: "#1a1a2e", minHeight: "100vh" },
  tst: { position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "#1a1a2e", color: "#fff", padding: "12px 24px", borderRadius: 12, fontSize: 14, fontWeight: 500, zIndex: 999, boxShadow: "0 8px 30px rgba(0,0,0,.25)" },
  hdr: { background: "#0f0a1e", padding: "0 20px", position: "sticky", top: 0, zIndex: 100, borderBottom: "1px solid rgba(217,119,6,.15)" },
  hdrIn: { maxWidth: 1100, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", height: 60 },
  lWrap: { display: "flex", alignItems: "center", gap: 10, cursor: "pointer" },
  lIco: { width: 34, height: 34, background: "linear-gradient(135deg,#f59e0b,#d97706)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 16 },
  lTxt: { fontSize: 18, fontWeight: 800, letterSpacing: "-.5px" },
  lSub: { color: "#f59e0b", fontSize: 11, fontWeight: 600, marginLeft: 4 },
  nav: { display: "flex", gap: 24 },
  nLnk: { color: "#aaa", fontSize: 13, fontWeight: 500, textDecoration: "none", cursor: "pointer" },
  cBtn: { position: "relative", background: "rgba(217,119,6,.12)", border: "1px solid rgba(217,119,6,.2)", borderRadius: 12, padding: "8px 14px", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, fontSize: 16 },
  cBdg: { background: "#d97706", color: "#fff", borderRadius: 99, padding: "1px 7px", fontSize: 11, fontWeight: 700, position: "absolute", top: -6, right: -6 },
  cTot: { fontSize: 13, fontWeight: 600, color: "#f59e0b" },
  hero: { background: "linear-gradient(170deg,#0f0a1e 0%,#1e1145 50%,#2d1a6e 100%)", padding: "80px 20px 70px", textAlign: "center", position: "relative", overflow: "hidden" },
  heroOv: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, background: "radial-gradient(ellipse at 50% 0%,rgba(245,158,11,.12) 0%,transparent 70%)" },
  heroC: { position: "relative", maxWidth: 700, margin: "0 auto" },
  heroBdg: { display: "inline-block", background: "rgba(245,158,11,.12)", border: "1px solid rgba(245,158,11,.3)", color: "#f59e0b", padding: "6px 16px", borderRadius: 99, fontSize: 13, fontWeight: 600, marginBottom: 20 },
  heroT: { fontSize: 48, fontWeight: 800, color: "#fff", marginBottom: 16, letterSpacing: "-1.5px", lineHeight: 1.1 },
  heroD: { color: "#b8b0d0", fontSize: 17, lineHeight: 1.6, maxWidth: 520, margin: "0 auto 32px" },
  heroSt: { display: "flex", justifyContent: "center", gap: 32, marginBottom: 36, flexWrap: "wrap" },
  st: { textAlign: "center" }, stN: { fontSize: 28, fontWeight: 800, color: "#fff" }, stL: { fontSize: 12, color: "#8b80a8", marginTop: 2 },
  stDiv: { width: 1, background: "rgba(217,119,6,.3)", alignSelf: "stretch" },
  heroCta: { display: "inline-block", background: "linear-gradient(135deg,#f59e0b,#d97706)", color: "#fff", padding: "14px 36px", borderRadius: 14, fontSize: 16, fontWeight: 700, textDecoration: "none" },
  sec: { padding: "60px 20px", maxWidth: 900, margin: "0 auto" },
  secT: { fontSize: 28, fontWeight: 800, textAlign: "center", marginBottom: 8, letterSpacing: "-.5px" },
  secS: { textAlign: "center", color: "#888", fontSize: 15, marginBottom: 28 },
  pGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 24 },
  pCard: { background: "#fff", border: "2px solid #e8e2d5", borderRadius: 20, padding: "32px 28px", position: "relative" },
  pCardFt: { borderColor: "#d97706", boxShadow: "0 4px 30px rgba(217,119,6,.12)" },
  pBdg: { position: "absolute", top: -13, left: "50%", transform: "translateX(-50%)", background: "linear-gradient(135deg,#f59e0b,#d97706)", color: "#fff", padding: "5px 18px", borderRadius: 99, fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" },
  pNm: { fontSize: 22, fontWeight: 700, marginBottom: 4 },
  prBlk: { textAlign: "center", marginBottom: 24, padding: "16px 0", background: "#fffbf2", borderRadius: 14 },
  prMain: { fontSize: 36, fontWeight: 800, color: "#1a1a2e", letterSpacing: "-1px" },
  ftList: { listStyle: "none", padding: 0, margin: "0 0 24px" },
  ftItem: { padding: "8px 0", fontSize: 14, color: "#555", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid #fef9ef" },
  chk: { color: "#d97706", fontWeight: 700, fontSize: 14 },
  buyB: { width: "100%", padding: "14px", borderRadius: 14, border: "2px solid #d97706", background: "#fff", color: "#d97706", fontSize: 15, fontWeight: 700, cursor: "pointer" },
  buyBFt: { background: "linear-gradient(135deg,#f59e0b,#d97706)", color: "#fff", border: "none" },
  dis: { opacity: .4, cursor: "not-allowed" },
  sOk: { fontSize: 12, fontWeight: 600, color: "#16a34a", background: "#f0fdf4", padding: "3px 10px", borderRadius: 8 },
  sLow: { fontSize: 12, fontWeight: 600, color: "#ea580c", background: "#fff7ed", padding: "3px 10px", borderRadius: 8 },
  sOut: { fontSize: 12, fontWeight: 600, color: "#dc2626", background: "#fef2f2", padding: "3px 10px", borderRadius: 8 },
  warn: { background: "#fff7ed", border: "1px solid #fed7aa", color: "#c2410c", padding: "12px 16px", borderRadius: 12, fontSize: 14, fontWeight: 500, marginBottom: 16, textAlign: "center" },
  stGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 20 },
  stCard: { textAlign: "center", padding: 24, borderRadius: 16, background: "#fff", border: "1px solid #eee", position: "relative" },
  stpN: { position: "absolute", top: 12, left: 16, fontSize: 11, fontWeight: 800, color: "#ccc" },
  devG: { display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap" },
  devC: { display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "20px 28px", borderRadius: 14, border: "1px solid #eee", background: "#fffbf2" },
  faqI: { borderBottom: "1px solid #eee", cursor: "pointer", padding: "16px 0" },
  faqQ: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 15, fontWeight: 600 },
  ckC: { maxWidth: 580, margin: "0 auto", padding: "24px 20px 60px" },
  ckCd: { background: "#fff", borderRadius: 18, padding: "28px 24px", border: "1px solid #eee", boxShadow: "0 2px 16px rgba(0,0,0,.04)" },
  ckTi: { fontSize: 20, fontWeight: 700, marginBottom: 20 },
  ckSt: { display: "flex", justifyContent: "center", gap: 32, marginBottom: 24 },
  ckStI: { display: "flex", flexDirection: "column", alignItems: "center", gap: 6 },
  ckDot: { width: 28, height: 28, borderRadius: 99, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 13, fontWeight: 700 },
  bkLnk: { background: "none", border: "none", color: "#d97706", fontSize: 14, fontWeight: 600, cursor: "pointer", marginBottom: 16, padding: 0, display: "block" },
  ptSm: { display: "flex", borderRadius: 12, overflow: "hidden", border: "2px solid #e8e2d5" },
  ptBSm: { flex: 1, padding: "10px", border: "none", background: "#fffbf2", cursor: "pointer", fontSize: 14, fontWeight: 600, color: "#888" },
  ptASm: { background: "#d97706", color: "#fff" },
  cRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 0", borderBottom: "1px solid #f3f3f3", flexWrap: "wrap", gap: 12 },
  cNm: { fontWeight: 700, fontSize: 15, color: "#1a1a2e" }, cSb: { fontSize: 13, color: "#999", marginTop: 2 },
  cRt: { display: "flex", alignItems: "center", gap: 14 },
  qW: { display: "flex", border: "2px solid #e8e2d5", borderRadius: 10, overflow: "hidden" },
  qB: { width: 30, height: 30, border: "none", background: "#fef8ee", cursor: "pointer", fontSize: 16, fontWeight: 700, color: "#555" },
  qV: { width: 28, textAlign: "center", lineHeight: "30px", fontSize: 14, fontWeight: 700 },
  cPr: { fontWeight: 700, fontSize: 15, minWidth: 65, textAlign: "right" },
  rmB: { background: "none", border: "none", color: "#ccc", fontSize: 16, cursor: "pointer" },
  totBar: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 0 20px" },
  totV: { fontSize: 24, fontWeight: 800, color: "#d97706" },
  mainBtn: { width: "100%", padding: "14px", borderRadius: 14, border: "none", background: "linear-gradient(135deg,#f59e0b,#d97706)", color: "#fff", fontSize: 16, fontWeight: 700, cursor: "pointer" },
  fRow: { marginBottom: 16 }, fFlx: { display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap" }, fHf: { flex: "1 1 200px" },
  lab: { display: "block", fontSize: 13, fontWeight: 600, color: "#444", marginBottom: 6 },
  inp: { width: "100%", padding: "12px 14px", borderRadius: 10, border: "2px solid #e8e2d5", fontSize: 14, outline: "none", boxSizing: "border-box" },
  sumB: { background: "#fffbf2", borderRadius: 14, padding: 16, marginBottom: 16 },
  sumL: { display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 14 },
  ordN: { textAlign: "center", fontWeight: 700, color: "#d97706", fontSize: 13, marginBottom: 8, letterSpacing: 1 },
  payI: { background: "#f9fafb", borderRadius: 12, padding: 16, marginBottom: 16 },
  emB: { textAlign: "center", padding: "60px 20px", background: "#fff", borderRadius: 18, border: "1px solid #eee" },
  sucB: { textAlign: "center", padding: "40px 24px", background: "#fff", borderRadius: 18, border: "1px solid #eee" },
  errM: { background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", padding: "10px 14px", borderRadius: 10, fontSize: 13, marginBottom: 12, textAlign: "center" },
  dlLink: { display: "block", fontSize: 13, color: "#d97706", fontWeight: 600, textDecoration: "none", marginBottom: 8, wordBreak: "break-all" },
  dlCode: { background: "#fffbf2", border: "1px solid #f0e4cc", borderRadius: 12, padding: "10px 16px", flex: "1 1 160px" },
  dlCodeLbl: { fontSize: 12, color: "#888", marginBottom: 4 },
  dlCodeVal: { fontSize: 16, fontWeight: 700, fontFamily: "monospace", color: "#1a1a2e" },
  ftr: { background: "#0f0a1e", color: "#ccc", padding: "40px 20px 0" },
  ftrIn: { maxWidth: 900, margin: "0 auto", display: "flex", flexWrap: "wrap", gap: 40, paddingBottom: 30 },
  fCol: { flex: "1 1 200px" },
  fLnk: { display: "block", color: "#999", fontSize: 13, textDecoration: "none", marginBottom: 8, cursor: "pointer" },
  fBot: { borderTop: "1px solid rgba(255,255,255,.06)", padding: "14px 0", textAlign: "center", fontSize: 12, color: "#555" },
};
