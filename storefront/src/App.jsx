import { useState, useEffect, useCallback, createContext, useContext } from "react";

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

function getAuthSDK() {
  if (window.firebase && window.firebase.apps && window.firebase.apps.length && window.firebase.auth) {
    return Promise.resolve(window.firebase.auth());
  }
  if (window._fbAuthPromise) return window._fbAuthPromise;
  window._fbAuthPromise = (async () => {
    const b = `https://www.gstatic.com/firebasejs/${FB_VER}`;
    await loadJS(`${b}/firebase-app-compat.js`);
    await loadJS(`${b}/firebase-auth-compat.js`);
    if (!window.firebase.apps.length) window.firebase.initializeApp(FB_CFG);
    return window.firebase.auth();
  })();
  return window._fbAuthPromise;
}

// ─── Hooks ────────────────────────────────────────────────────
function useFirestore() {
  const [db, setDb] = useState(null);
  useEffect(() => { getDB().then(setDb).catch(console.error); }, []);
  return db;
}

function useAuthState() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  useEffect(() => {
    let unsub = () => {};
    getAuthSDK().then((auth) => {
      unsub = auth.onAuthStateChanged((u) => { setUser(u); setAuthLoading(false); });
    }).catch(() => setAuthLoading(false));
    return () => unsub();
  }, []);
  return { user, authLoading };
}

function usePerfil(db, uid) {
  const [perfil, setPerfil] = useState(null);
  useEffect(() => {
    if (!db || !uid) { setPerfil(null); return; }
    const unsub = db.collection("clientesPortal").doc(uid).onSnapshot(
      (doc) => setPerfil(doc.exists ? doc.data() : null),
      () => setPerfil(null)
    );
    return () => unsub();
  }, [db, uid]);
  return perfil;
}

function useMeusPedidos(db, uid) {
  const [pedidos, setPedidos] = useState([]);
  useEffect(() => {
    if (!db || !uid) { setPedidos([]); return; }
    // Ordenamos no cliente (nao no Firestore) para nao depender de um indice composto.
    const unsub = db.collection("pedidos").where("clienteUid", "==", uid).onSnapshot(
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        list.sort((a, b) => (b.criadoEm?.seconds || 0) - (a.criadoEm?.seconds || 0));
        setPedidos(list);
      },
      () => setPedidos([])
    );
    return () => unsub();
  }, [db, uid]);
  return pedidos;
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

const MAX_QTY = 10; // teto por item no carrinho — nao depende do estoque, compra sem estoque e permitida

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
  const valorVenda = doc.valor != null ? doc.valor : 0;
  const valorPromo = doc.valorPromo != null ? doc.valorPromo : null;
  return {
    id: doc.id,
    categoriaRaw,
    nome: prettify(categoriaRaw),
    tipo,
    period: tipoPeriodo(tipo),
    badge: tipo === "anual" ? "Melhor custo-benefício" : null,
    // preco e sempre o valor efetivo (o que o cliente paga — usado no carrinho/checkout).
    // precoOriginal so vem preenchido quando ha promocao, pra mostrar riscado no card.
    preco: valorPromo != null ? valorPromo : valorVenda,
    precoOriginal: valorPromo != null ? valorVenda : null,
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
  const { user, authLoading } = useAuthState();
  const perfil = usePerfil(db, user?.uid);
  const meusPedidos = useMeusPedidos(db, user?.uid);
  const [cart, setCart] = useState([]);
  const [page, setPage] = useState("home");
  const [toast, setToast] = useState(null);

  const plans = raw.length > 0 ? raw.map(norm) : FALLBACK.map(norm);

  const flash = useCallback((m) => { setToast(m); setTimeout(() => setToast(null), 2500); }, []);

  // Detecta a volta do Checkout Pro do Mercado Pago (back_urls) e leva o cliente pra
  // "Minha Conta", onde o pedido/codigo atualiza sozinho assim que o webhook processar.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get("checkout");
    if (!checkout) return;
    const msgs = {
      sucesso: "✅ Pagamento em confirmação! Seu código aparece aqui em instantes.",
      pendente: "⏳ Pagamento pendente. Assim que for aprovado, o código aparece aqui.",
      falhou: "❌ Pagamento não foi aprovado. Você pode tentar de novo.",
    };
    flash(msgs[checkout] || "Voltando do pagamento...");
    setPage("conta");
    window.history.replaceState({}, "", window.location.pathname);
  }, [flash]);

  // Comprar sem estoque e permitido de proposito: o pedido fica registrado mesmo assim
  // e, se nao houver giftcard disponivel na hora do pagamento, o webhook do Mercado Pago
  // deixa o status em "pago" para o admin atribuir o codigo manualmente depois de repor.
  // Por isso o limite de quantidade aqui e so um teto razoavel (MAX_QTY), nao o estoque.
  const addToCart = useCallback((plan, q = 1) => {
    setCart(prev => {
      const ex = prev.find(i => i.plan.id === plan.id);
      if (ex) {
        if (ex.qty + q > MAX_QTY) { flash(`⚠️ Máximo de ${MAX_QTY} por pedido`); return prev; }
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
      if (n > MAX_QTY) return i;
      return { ...i, qty: Math.max(0, n) };
    }).filter(i => i.qty > 0));
  }, []);

  const rmItem = useCallback((id) => setCart(p => p.filter(i => i.plan.id !== id)), []);
  const total = cart.reduce((s, i) => s + i.plan.preco * i.qty, 0);
  const count = cart.reduce((s, i) => s + i.qty, 0);

  const [cupom, setCupom] = useState(null);
  const [cupomBusy, setCupomBusy] = useState(false);
  const desconto = cupom
    ? Math.min(total, cupom.tipo === "percentual" ? total * (cupom.valor / 100) : cupom.valor)
    : 0;
  const totalFinal = Math.max(0, total - desconto);

  // Se o carrinho mudar depois do cupom aplicado (ex: adicionar um item de categoria nao
  // permitida) e o cupom tiver restricao, remove ele automaticamente em vez de deixar
  // aplicado sobre itens fora do escopo.
  useEffect(() => {
    if (!cupom || !cupom.categorias || !cupom.categorias.length) return;
    const foraDoEscopo = cart.some(i => !cupom.categorias.includes(i.plan.categoriaRaw));
    if (foraDoEscopo) {
      setCupom(null);
      flash(`⚠️ Cupom ${cupom.codigo} removido — só vale para ${cupom.categorias.join(", ")}`);
    }
  }, [cart, cupom, flash]);

  // Valida o cupom no Worker (nunca direto no Firestore — evita expor todos os codigos
  // via leitura publica). O total é reconferido de novo no servidor ao criar o pagamento.
  const aplicarCupom = useCallback(async (codigo) => {
    setCupomBusy(true);
    try {
      const categoriasCarrinho = [...new Set(cart.map(i => i.plan.categoriaRaw))];
      const res = await fetch("/api/validar-cupom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codigo, total, categorias: categoriasCarrinho }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.valido) throw new Error(data.motivo || "Cupom inválido");
      setCupom({ codigo: data.codigo, tipo: data.tipo, valor: data.valor, categorias: data.categorias || null });
      flash(`✅ Cupom ${data.codigo} aplicado!`);
    } finally {
      setCupomBusy(false);
    }
  }, [total, cart, flash]);

  const removerCupom = useCallback(() => setCupom(null), []);

  // Cria 1 documento de pedido por unidade (compativel com o admin: Pedidos > Atribuir Codigo
  // busca giftcards por igualdade exata de `categoria`). Um grupoId liga os itens do mesmo carrinho.
  // Login e obrigatorio: clienteUid identifica o pedido como do cliente logado, tanto para a
  // regra do Firestore quanto para ele conseguir ver o pedido/codigo em "Minha Conta".
  // O desconto do cupom e distribuido proporcionalmente entre as unidades, com a ultima
  // absorvendo o resto do arredondamento — assim a soma dos "valor" bate exatamente com
  // totalFinal, e o Worker (que recalcula o total no servidor) nao precisa saber de cupom.
  const submitOrder = useCallback(async (cli) => {
    if (!db) throw new Error("Não foi possível conectar ao servidor. Tente novamente em instantes.");
    if (!user) throw new Error("Faça login para continuar.");
    if (cart.length === 0) throw new Error("Carrinho vazio.");

    const unidades = [];
    cart.forEach(item => { for (let n = 0; n < item.qty; n++) unidades.push(item.plan); });
    if (unidades.length > 400) throw new Error("Pedido muito grande, reduza a quantidade.");

    let acumulado = 0;
    const valoresFinais = unidades.map((plan, idx) => {
      if (idx === unidades.length - 1) return Math.round((totalFinal - acumulado) * 100) / 100;
      const proporcao = total > 0 ? plan.preco / total : 0;
      const valorFinal = Math.round((plan.preco - desconto * proporcao) * 100) / 100;
      acumulado += valorFinal;
      return valorFinal;
    });

    const grupoId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const clienteContato = cli.phone || cli.email;
    const batch = db.batch();
    unidades.forEach((plan, idx) => {
      const ref = db.collection("pedidos").doc();
      batch.set(ref, {
        categoria: plan.categoriaRaw,
        tipo: plan.tipo,
        valor: valoresFinais[idx],
        valorOriginal: plan.preco,
        cupomCodigo: cupom ? cupom.codigo : null,
        clienteUid: user.uid,
        clienteNome: cli.name,
        clienteContato,
        clienteEmail: cli.email || null,
        clienteTelefone: cli.phone || null,
        status: "pendente",
        origem: "storefront",
        grupoId,
        criadoEm: window.firebase.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();
    setCupom(null);
    return grupoId;
  }, [db, cart, user, cupom, total, desconto, totalFinal]);

  // Cria o pagamento no Mercado Pago (Checkout Pro) para um grupo de pedidos ja gravados
  // e devolve a URL de redirecionamento. O total e recalculado no servidor (Worker) a
  // partir do Firestore — nunca confia no total calculado so no navegador.
  const criarPagamento = useCallback(async (grupoId) => {
    const res = await fetch("/api/criar-pagamento", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grupoId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) throw new Error(data.error || "Não foi possível iniciar o pagamento. Tente novamente.");
    return data.url;
  }, []);

  // Pedido com cupom de 100% de desconto: nao passa pelo Mercado Pago (nao daria pra
  // cobrar R$0,00). O Worker reconfere a soma real no Firestore antes de liberar —
  // nunca confia neste totalFinal calculado so no navegador.
  const confirmarPedidoGratis = useCallback(async (grupoId) => {
    const res = await fetch("/api/confirmar-pedido-gratis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grupoId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "Não foi possível concluir o pedido. Tente novamente.");
  }, []);

  const signup = useCallback(async ({ email, password, nome, telefone }) => {
    const auth = await getAuthSDK();
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    if (nome) await cred.user.updateProfile({ displayName: nome });
    if (db) {
      await db.collection("clientesPortal").doc(cred.user.uid).set({
        nome: nome || "",
        telefone: telefone || "",
        email,
        criadoEm: window.firebase.firestore.FieldValue.serverTimestamp(),
      });
    }
    return cred.user;
  }, [db]);

  const login = useCallback(async ({ email, password }) => {
    const auth = await getAuthSDK();
    await auth.signInWithEmailAndPassword(email, password);
  }, []);

  const logout = useCallback(async () => {
    const auth = await getAuthSDK();
    await auth.signOut();
    setPage("home");
  }, []);

  const resetPassword = useCallback(async (email) => {
    const auth = await getAuthSDK();
    await auth.sendPasswordResetEmail(email);
  }, []);

  return (
    <Ctx.Provider value={{
      plans, cart, addToCart, updQty, rmItem, total, count, page, setPage, toast, loading, submitOrder, criarPagamento, confirmarPedidoGratis,
      user, authLoading, perfil, meusPedidos, signup, login, logout, resetPassword,
      cupom, cupomBusy, desconto, totalFinal, aplicarCupom, removerCupom,
    }}>
      {children}
    </Ctx.Provider>
  );
}
const use$ = () => useContext(Ctx);

// ─── Components ───────────────────────────────────────────────

function Stock({ qty }) {
  // Sem estoque nao bloqueia a compra: o pedido fica pendente/pago ate a equipe repor e atribuir manualmente.
  if (qty <= 0) return <span style={S.sWait}>Sob encomenda — pode levar mais tempo</span>;
  if (qty <= 5) return <span style={S.sLow}>Últimas {qty} unid.</span>;
  return <span style={S.sOk}>{qty} disponíveis</span>;
}

function Header() {
  const { count, totalFinal, setPage, user, authLoading } = use$();
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
          {!authLoading && <a style={S.nLnk} onClick={() => setPage("conta")}>{user ? "Minha Conta" : "Entrar"}</a>}
        </nav>
        <button style={S.cBtn} onClick={() => setPage("checkout")}>
          🛒{count > 0 && <span style={S.cBdg}>{count}</span>}{totalFinal > 0 && <span style={S.cTot}>{fmt(totalFinal)}</span>}
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
        <p style={S.heroD}>Filmes, séries, canais ao vivo e muito mais. Pague com Pix, cartão ou boleto pelo Mercado Pago e receba o código na hora.</p>
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
      <p style={S.secS}>Pague com Pix, cartão ou boleto pelo Mercado Pago e receba o código na hora</p>
      <div style={S.pGrid}>
        {(loading ? FALLBACK.map(norm) : plans).map(plan => {
          return (
            <div key={plan.id} style={{ ...S.pCard, ...(plan.badge ? S.pCardFt : {}) }}>
              {plan.badge && <div style={S.pBdg}>{plan.badge}</div>}
              <div style={{ textAlign: "center", marginBottom: 20 }}>
                <h3 style={S.pNm}>{plan.nome}</h3>
                <div style={{ color: "#999", fontSize: 14 }}>{plan.period}</div>
                <div style={{ marginTop: 8 }}><Stock qty={plan.disponivel} /></div>
              </div>
              <div style={S.prBlk}>
                {plan.precoOriginal != null && <div style={S.prOriginal}>{fmt(plan.precoOriginal)}</div>}
                <div style={S.prMain}>{fmt(plan.preco)}</div>
                {plan.precoOriginal != null && <div style={S.prPromoTag}>🔥 Promoção</div>}
              </div>
              <ul style={S.ftList}>
                {(plan.features || []).map((f, i) => <li key={i} style={S.ftItem}><span style={S.chk}>✓</span> {f}</li>)}
              </ul>
              <button style={{ ...S.buyB, ...(plan.badge ? S.buyBFt : {}) }} onClick={() => { addToCart(plan); setPage("checkout"); }}>
                Fazer pedido
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
    { i: "🔐", t: "Crie sua conta", d: "Pra acompanhar o pedido" },
    { i: "💳", t: "Pague no Mercado Pago", d: "Pix, cartão ou boleto" },
    { i: "📺", t: "Ative na hora", d: "Código liberado em Minha Conta" },
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
    { q: "Como recebo meu gift card?", a: "Assim que o Mercado Pago confirma o pagamento, o código aparece automaticamente em \"Minha Conta\" — não precisa esperar contato de ninguém." },
    { q: "Como ativo o código?", a: "No app UniTV, faça login, acesse a área de recarga e insira o código. A ativação é imediata." },
    { q: "Quantos dispositivos?", a: "Até 2 telas simultâneas em qualquer dispositivo Android compatível." },
    { q: "Quanto tempo demora?", a: "Normalmente o código fica disponível em poucos minutos após o pagamento ser aprovado. Se o produto estiver sob encomenda, pode levar um pouco mais." },
    { q: "Como funciona o pagamento?", a: "Você paga direto pelo Mercado Pago — Pix, cartão ou boleto — na hora de confirmar o pedido. Não precisa combinar nada por fora." },
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

function AuthForms({ onDone }) {
  const { signup, login, resetPassword } = use$();
  const [mode, setMode] = useState("login");
  const [f, setF] = useState({ email: "", password: "", nome: "", telefone: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const up = (k, v) => setF((p) => ({ ...p, [k]: v }));

  const errMap = {
    "auth/email-already-in-use": "Este e-mail já tem uma conta. Tente entrar.",
    "auth/invalid-email": "E-mail inválido",
    "auth/weak-password": "Senha deve ter pelo menos 6 caracteres",
    "auth/user-not-found": "Conta não encontrada",
    "auth/wrong-password": "Senha incorreta",
    "auth/invalid-credential": "E-mail ou senha incorretos",
    "auth/too-many-requests": "Muitas tentativas — aguarde e tente de novo",
  };

  const submit = async () => {
    setErr(null); setMsg(null);
    if (!f.email || !f.password) { setErr("Preencha e-mail e senha"); return; }
    if (mode === "signup" && !f.nome) { setErr("Preencha seu nome"); return; }
    setBusy(true);
    try {
      if (mode === "signup") await signup(f);
      else await login(f);
      onDone && onDone();
    } catch (e) {
      setErr(errMap[e.code] || e.message);
    } finally {
      setBusy(false);
    }
  };

  const esqueceuSenha = async () => {
    setErr(null); setMsg(null);
    if (!f.email) { setErr("Digite seu e-mail acima para redefinir a senha"); return; }
    try {
      await resetPassword(f.email);
      setMsg("E-mail de redefinição enviado! Confira sua caixa de entrada.");
    } catch {
      setErr("Erro ao enviar e-mail de redefinição");
    }
  };

  return (
    <div>
      <div style={S.ptSm}>
        <button style={{ ...S.ptBSm, ...(mode === "login" ? S.ptASm : {}) }} onClick={() => { setMode("login"); setErr(null); setMsg(null); }}>Entrar</button>
        <button style={{ ...S.ptBSm, ...(mode === "signup" ? S.ptASm : {}) }} onClick={() => { setMode("signup"); setErr(null); setMsg(null); }}>Criar conta</button>
      </div>
      {mode === "signup" && (
        <div style={S.fRow}><label style={S.lab}>Nome completo *</label><input style={S.inp} value={f.nome} onChange={(e) => up("nome", e.target.value)} placeholder="João da Silva" /></div>
      )}
      <div style={S.fRow}><label style={S.lab}>E-mail *</label><input style={S.inp} type="email" value={f.email} onChange={(e) => up("email", e.target.value)} placeholder="seu@email.com" /></div>
      {mode === "signup" && (
        <div style={S.fRow}><label style={S.lab}>WhatsApp</label><input style={S.inp} value={f.telefone} onChange={(e) => up("telefone", e.target.value)} placeholder="(00) 00000-0000" /></div>
      )}
      <div style={S.fRow}><label style={S.lab}>Senha *</label><input style={S.inp} type="password" value={f.password} onChange={(e) => up("password", e.target.value)} placeholder="mínimo 6 caracteres" /></div>
      {err && <div style={S.errM}>{err}</div>}
      {msg && <div style={{ ...S.errM, background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#16a34a" }}>{msg}</div>}
      <button style={S.mainBtn} onClick={submit} disabled={busy}>{busy ? "Aguarde..." : mode === "signup" ? "Criar conta" : "Entrar"}</button>
      {mode === "login" && (
        <button type="button" onClick={esqueceuSenha} style={{ background: "none", border: "none", color: "#d97706", fontSize: 13, marginTop: 12, cursor: "pointer", display: "block", width: "100%", textAlign: "center" }}>
          Esqueci minha senha
        </button>
      )}
    </div>
  );
}

function Conta() {
  const { user, authLoading, perfil, meusPedidos, logout } = use$();

  if (authLoading) return <div style={S.ckC}><p style={{ textAlign: "center", color: "#888", padding: "40px 0" }}>Carregando...</p></div>;

  if (!user) return (
    <div style={S.ckC}><div style={S.ckCd}>
      <h2 style={S.ckTi}>Minha conta</h2>
      <p style={{ fontSize: 13, color: "#888", marginBottom: 20 }}>Entre ou crie uma conta para acompanhar seus pedidos e ver os códigos assim que forem liberados.</p>
      <AuthForms />
    </div></div>
  );

  const statusLabel = { pendente: "Aguardando pagamento", pago: "Pago — preparando código", atribuido: "Código disponível", cancelado: "Cancelado" };
  const statusColor = { pendente: "#f59e0b", pago: "#2563eb", atribuido: "#16a34a", cancelado: "#dc2626" };

  return (
    <div style={S.ckC}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700 }}>Olá, {perfil?.nome || user.displayName || "cliente"}</h2>
          <p style={{ fontSize: 13, color: "#888" }}>{user.email}</p>
        </div>
        <button onClick={() => logout()} style={{ background: "none", border: "1px solid #e8e2d5", borderRadius: 10, padding: "8px 14px", fontSize: 13, cursor: "pointer", color: "#666", whiteSpace: "nowrap" }}>Sair</button>
      </div>
      <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>Meus pedidos</h3>
      {meusPedidos.length === 0 && <p style={{ color: "#888", fontSize: 14 }}>Você ainda não fez nenhum pedido.</p>}
      {meusPedidos.map((p) => (
        <div key={p.id} style={{ ...S.ckCd, marginBottom: 12, padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 12 }}>
            <strong style={{ fontSize: 14 }}>{prettify(p.categoria)}</strong>
            <span style={{ fontSize: 12, fontWeight: 700, color: statusColor[p.status] || "#888", whiteSpace: "nowrap" }}>{statusLabel[p.status] || p.status}</span>
          </div>
          <div style={{ fontSize: 13, color: "#888", marginBottom: 10 }}>
            {fmt(p.valor)} · {p.criadoEm ? new Date(p.criadoEm.seconds * 1000).toLocaleDateString("pt-BR") : ""}
          </div>
          {p.status === "atribuido" && p.codigo && (
            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "10px 12px", fontFamily: "monospace", fontSize: 14, fontWeight: 700, color: "#16a34a", wordBreak: "break-all" }}>
              {p.codigo}
            </div>
          )}
          {p.status === "pendente" && <div style={{ fontSize: 12, color: "#f59e0b" }}>Aguardando confirmação do pagamento</div>}
          {p.status === "pago" && <div style={{ fontSize: 12, color: "#2563eb" }}>Pagamento confirmado — nossa equipe está preparando seu código</div>}
          {p.status === "cancelado" && <div style={{ fontSize: 12, color: "#dc2626" }}>Pedido cancelado</div>}
        </div>
      ))}
    </div>
  );
}

function CupomBox() {
  const { cupom, cupomBusy, desconto, aplicarCupom, removerCupom } = use$();
  const [input, setInput] = useState("");
  const [erro, setErro] = useState(null);

  const aplicar = async () => {
    setErro(null);
    if (!input.trim()) return;
    try { await aplicarCupom(input.trim()); setInput(""); }
    catch (e) { setErro(e.message); }
  };

  if (cupom) {
    return (
      <div style={S.cupomAplicado}>
        <span>🎟️ <strong>{cupom.codigo}</strong> aplicado — desconto de {fmt(desconto)}</span>
        <button type="button" onClick={removerCupom} style={S.cupomRemover}>Remover</button>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input style={{ ...S.inp, flex: 1 }} placeholder="Cupom de desconto" value={input} onChange={e => setInput(e.target.value.toUpperCase())} onKeyDown={e => e.key === "Enter" && aplicar()} />
        <button type="button" onClick={aplicar} disabled={cupomBusy || !input.trim()} style={{ background: "#d97706", color: "#fff", border: "none", borderRadius: 10, padding: "0 18px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
          {cupomBusy ? "..." : "Aplicar"}
        </button>
      </div>
      {erro && <div style={{ fontSize: 12, color: "#dc2626", marginTop: 6 }}>{erro}</div>}
    </div>
  );
}

function Checkout() {
  const { cart, updQty, rmItem, desconto, totalFinal, cupom, setPage, plans, submitOrder, criarPagamento, confirmarPedidoGratis, user, perfil } = use$();
  const [f, setF] = useState({ email: "", name: "", phone: "" });
  const [step, setSt] = useState("cart");
  const [busy, setBusy] = useState(false);
  const [oid, setOid] = useState(null);
  const [payUrl, setPayUrl] = useState(null);
  const [gratis, setGratis] = useState(false);
  const [err, setErr] = useState(null);
  const up = (k, v) => setF(p => ({ ...p, [k]: v }));
  const ok = f.email && f.name;
  const ehGratis = totalFinal <= 0;

  // Preenche com os dados da conta assim que o cliente loga (durante o checkout ou antes dele).
  useEffect(() => { if (user && !f.email) setF((p) => ({ ...p, email: user.email || "" })); }, [user]);
  useEffect(() => { if (perfil && !f.name) setF((p) => ({ ...p, name: perfil.nome || p.name, phone: perfil.telefone || p.phone })); }, [perfil]);
  // Comprar sem estoque e permitido — so avisamos que pode demorar mais, nao bloqueamos o pedido.
  const temSobEncomenda = cart.some(i => { const c = plans.find(p => p.id === i.plan.id); return !c || c.disponivel < i.qty; });

  if (cart.length === 0 && step !== "done") return (
    <div style={S.ckC}><div style={S.emB}>
      <span style={{ fontSize: 56 }}>🛒</span>
      <h2 style={{ margin: "16px 0 8px", fontWeight: 700 }}>Carrinho vazio</h2>
      <p style={{ color: "#888", marginBottom: 24 }}>Escolha um plano para começar</p>
      <button style={S.mainBtn} onClick={() => setPage("home")}>← Ver planos</button>
    </div></div>
  );

  if (step === "done") {
    if (gratis) {
      return (
        <div style={S.ckC}><div style={S.sucB}>
          <div style={{ fontSize: 56, marginBottom: 8 }}>✅</div>
          <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Pedido concluído!</h2>
          <p style={{ color: "#666", lineHeight: 1.6, marginBottom: 24 }}>
            Pedido #{oid ? oid.slice(0, 8) : "..."} confirmado com cupom de 100% de desconto — nada a pagar. O código já deve estar disponível em "Minha Conta".
          </p>
          <button style={S.mainBtn} onClick={() => setPage("conta")}>Ver em Minha Conta →</button>
        </div></div>
      );
    }
    return (
      <div style={S.ckC}><div style={S.sucB}>
        <div style={{ fontSize: 56, marginBottom: 8 }}>💳</div>
        <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Redirecionando para o pagamento...</h2>
        <p style={{ color: "#666", lineHeight: 1.6, marginBottom: 24 }}>
          Pedido #{oid ? oid.slice(0, 8) : "..."} registrado. Você vai ser levado ao Mercado Pago para pagar via Pix, cartão ou boleto — o código é liberado automaticamente aqui em "Minha Conta" assim que o pagamento for confirmado.
        </p>
        {payUrl && <a href={payUrl} style={{ ...S.mainBtn, display: "block", textDecoration: "none", boxSizing: "border-box" }}>Ir para o pagamento →</a>}
      </div></div>
    );
  }

  const doSubmit = async () => {
    setBusy(true); setErr(null);
    try {
      // Reaproveita o grupoId se essa for uma nova tentativa (ex: a criacao do pagamento
      // falhou antes) para nao duplicar os pedidos já gravados.
      const grupoId = oid || await submitOrder(f);
      if (!oid) setOid(grupoId);
      // Cupom de 100%: nunca chama o Mercado Pago, conclui direto (o Worker reconfere
      // a soma no Firestore antes de liberar, nunca confia neste calculo do navegador).
      if (ehGratis) {
        await confirmarPedidoGratis(grupoId);
        setGratis(true);
        setSt("done");
        return;
      }
      const url = await criarPagamento(grupoId);
      setPayUrl(url);
      setSt("done");
      window.location.href = url;
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={S.ckC}>
      <button style={S.bkLnk} onClick={() => step === "cart" ? setPage("home") : setSt("cart")}>← {step === "cart" ? "Voltar aos planos" : "Voltar"}</button>
      <div style={S.ckSt}>
        {["Carrinho", "Seus dados", "Confirmação"].map((l, i) => {
          const si = ["cart", "info", "confirm"].indexOf(step);
          return <div key={i} style={{ ...S.ckStI, opacity: i <= si ? 1 : .35 }}><div style={{ ...S.ckDot, background: i <= si ? "#d97706" : "#ddd" }}>{i + 1}</div><span style={{ fontSize: 12, fontWeight: 600 }}>{l}</span></div>;
        })}
      </div>
      {temSobEncomenda && <div style={S.warn}>ℹ️ Algum item está sob encomenda — a compra é permitida, mas pode levar mais tempo até termos o código disponível.</div>}

      {step === "cart" && <div style={S.ckCd}>
        <h2 style={S.ckTi}>Seu carrinho</h2>
        {cart.map(i => { const mx = plans.find(p => p.id === i.plan.id)?.disponivel || 0; return (
          <div key={i.plan.id} style={S.cRow}>
            <div><div style={S.cNm}>▶ {i.plan.nome}</div><div style={S.cSb}>{i.plan.period} · {fmt(i.plan.preco)}</div><div style={{ marginTop: 4 }}><Stock qty={mx} /></div></div>
            <div style={S.cRt}><div style={S.qW}><button style={S.qB} onClick={() => updQty(i.plan.id, -1)}>−</button><span style={S.qV}>{i.qty}</span><button style={S.qB} onClick={() => updQty(i.plan.id, 1)}>+</button></div><div style={S.cPr}>{fmt(i.plan.preco * i.qty)}</div><button style={S.rmB} onClick={() => rmItem(i.plan.id)}>✕</button></div>
          </div>
        ); })}
        <CupomBox />
        {desconto > 0 && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: "#16a34a", marginBottom: 4 }}><span>Desconto ({cupom.codigo})</span><span>-{fmt(desconto)}</span></div>}
        <div style={S.totBar}><span style={{ fontSize: 16, fontWeight: 600 }}>Total</span><span style={S.totV}>{fmt(totalFinal)}</span></div>
        <button style={S.mainBtn} onClick={() => setSt("info")}>Continuar →</button>
      </div>}

      {step === "info" && <div style={S.ckCd}>
        {!user ? (
          <>
            <h2 style={S.ckTi}>Entre para continuar</h2>
            <p style={{ color: "#888", fontSize: 14, marginBottom: 20 }}>Crie uma conta ou entre para acompanhar seu pedido e ver o código assim que estiver disponível.</p>
            <AuthForms />
          </>
        ) : (
          <>
            <h2 style={S.ckTi}>Seus dados</h2>
            <p style={{ color: "#888", fontSize: 14, marginBottom: 20 }}>Confirme seus dados de contato para este pedido</p>
            <div style={S.fRow}><label style={S.lab}>E-mail</label><input style={{ ...S.inp, background: "#f7f7f7", color: "#888" }} value={f.email} disabled /></div>
            <div style={S.fFlx}><div style={S.fHf}><label style={S.lab}>Nome completo *</label><input style={S.inp} placeholder="João da Silva" value={f.name} onChange={e => up("name", e.target.value)} /></div><div style={S.fHf}><label style={S.lab}>WhatsApp</label><input style={S.inp} placeholder="(00) 00000-0000" value={f.phone} onChange={e => up("phone", e.target.value)} /></div></div>
            <button style={{ ...S.mainBtn, opacity: ok ? 1 : .45 }} disabled={!ok} onClick={() => setSt("confirm")}>Revisar pedido →</button>
          </>
        )}
      </div>}

      {step === "confirm" && <div style={S.ckCd}>
        <h2 style={S.ckTi}>Confirmar pedido</h2>
        <div style={S.sumB}>
          {cart.map(i => <div key={i.plan.id} style={S.sumL}><span>{i.plan.nome} × {i.qty}</span><span>{fmt(i.plan.preco * i.qty)}</span></div>)}
          {desconto > 0 && <div style={{ ...S.sumL, color: "#16a34a" }}><span>Desconto ({cupom.codigo})</span><span>-{fmt(desconto)}</span></div>}
          <div style={{ ...S.sumL, borderTop: "2px solid #eee", paddingTop: 10, marginTop: 6, fontWeight: 700 }}><span>Total estimado</span><span style={{ color: "#d97706", fontSize: 20 }}>{fmt(totalFinal)}</span></div>
        </div>
        <div style={S.payI}><div style={{ fontSize: 14, color: "#666", lineHeight: 1.6 }}>
          {ehGratis ? (
            <>Seu cupom cobre 100% do valor — não há pagamento a fazer. Ao confirmar, o código de ativação é liberado automaticamente aqui em "Minha Conta"{temSobEncomenda ? ", exceto para itens sob encomenda, que ficam com a equipe até termos estoque para atribuir manualmente." : "."}</>
          ) : (
            <>Ao confirmar, você será levado ao <strong>Mercado Pago</strong> para pagar via Pix, cartão ou boleto. Assim que o pagamento for aprovado, o código de ativação é liberado automaticamente aqui em "Minha Conta"{temSobEncomenda ? " — exceto para itens sob encomenda, que ficam com a equipe até termos estoque para atribuir manualmente." : "."}</>
          )}
        </div></div>
        {err && <div style={S.errM}>{err}</div>}
        <button style={S.mainBtn} onClick={doSubmit} disabled={busy}>
          {busy ? "⏳ Enviando..." : ehGratis ? "Concluir pedido →" : "Ir para o pagamento →"}
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
  if (page === "conta") return <Conta />;
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
  prOriginal: { fontSize: 16, fontWeight: 600, color: "#aaa", textDecoration: "line-through" },
  prPromoTag: { fontSize: 12, fontWeight: 700, color: "#dc2626", marginTop: 4 },
  ftList: { listStyle: "none", padding: 0, margin: "0 0 24px" },
  ftItem: { padding: "8px 0", fontSize: 14, color: "#555", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid #fef9ef" },
  chk: { color: "#d97706", fontWeight: 700, fontSize: 14 },
  buyB: { width: "100%", padding: "14px", borderRadius: 14, border: "2px solid #d97706", background: "#fff", color: "#d97706", fontSize: 15, fontWeight: 700, cursor: "pointer" },
  buyBFt: { background: "linear-gradient(135deg,#f59e0b,#d97706)", color: "#fff", border: "none" },
  dis: { opacity: .4, cursor: "not-allowed" },
  sOk: { fontSize: 12, fontWeight: 600, color: "#16a34a", background: "#f0fdf4", padding: "3px 10px", borderRadius: 8 },
  sLow: { fontSize: 12, fontWeight: 600, color: "#ea580c", background: "#fff7ed", padding: "3px 10px", borderRadius: 8 },
  sOut: { fontSize: 12, fontWeight: 600, color: "#dc2626", background: "#fef2f2", padding: "3px 10px", borderRadius: 8 },
  sWait: { fontSize: 12, fontWeight: 600, color: "#7c3aed", background: "#f5f3ff", padding: "3px 10px", borderRadius: 8 },
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
  cupomAplicado: { display: "flex", justifyContent: "space-between", alignItems: "center", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "#16a34a", marginBottom: 16, gap: 10 },
  cupomRemover: { background: "none", border: "none", color: "#dc2626", fontSize: 12, fontWeight: 600, cursor: "pointer", textDecoration: "underline", whiteSpace: "nowrap" },
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
