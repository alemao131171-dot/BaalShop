# BaalShop Recargas (storefront)

Site público de vendas, separado do admin (`index.html` no GitHub Pages). Este projeto vai para o **Cloudflare Pages**, em domínio próprio, e conversa com o **mesmo** Firebase do admin (`baalshopgiftcards`) só que com permissões públicas bem restritas.

## Como as duas partes se conectam (Firestore)

```
storefront (Cloudflare Pages, público — mas comprar exige criar conta)
   lê   -> catalogo        (contagem de disponíveis, sem código)
   cria -> pedidos          (1 documento por unidade, vinculado ao clienteUid)
   lê/escreve -> clientesPortal/{uid}  (perfil do próprio cliente logado)

admin (GitHub Pages, exige login de funcionário)
   escreve -> catalogo   (syncCatalogo(), roda sozinho a cada mudança em giftcards)
   lê/edita -> pedidos   (tela "Pedidos": Atribuir Código / Cancelar)
```

O login do cliente usa o **mesmo Firebase Auth** do admin, mas são contas diferentes: uma conta só é "admin" se tiver um documento em `/users/{uid}` (criado pela tela "Usuarios"); contas criadas pelo storefront nunca ganham esse documento. As regras do Firestore usam essa distinção (`isAdmin()`) para impedir que um cliente logado veja dados de outros clientes ou de giftcards de outra pessoa.

### Coleção `catalogo` (leitura pública, sem código nenhum)

Escrita automaticamente pelo admin (`syncCatalogo()` em `index.html`). Um documento por **categoria** de produto (não por descrição — a descrição de cada giftcard pode ser única por unidade/número de série, então `categoria` é o campo estável que identifica o produto):

| campo         | tipo    | descrição                                  |
|---------------|---------|---------------------------------------------|
| `categoria`   | string  | categoria exata do giftcard (chave de match) |
| `tipo`        | string  | `mensal` / `trimestral` / `anual`            |
| `valor`       | number? | preço de venda                               |
| `disponiveis` | number  | quantos giftcards dessa `categoria` estão livres |
| `atualizadoEm`| timestamp | última sincronização                       |

O storefront **nunca** vê `code` — essa coleção não guarda códigos.

### Coleção `pedidos` (criação só por cliente logado; leitura restrita ao próprio pedido)

O storefront cria **um documento por unidade comprada** (se o cliente pede 2x o mesmo plano, são 2 documentos, ligados por `grupoId`). Isso é o que permite ao admin usar "Atribuir Código" (que busca 1 giftcard livre por `categoria` e faz a atribuição via transação).

| campo                      | tipo      | descrição                                    |
|----------------------------|-----------|-----------------------------------------------|
| `categoria`                | string    | igual ao `catalogo.categoria` do item comprado |
| `tipo`                     | string    | copiado do catálogo                           |
| `valor`                    | number    | preço no momento da compra                    |
| `clienteUid`               | string    | uid do Firebase Auth do cliente logado que comprou |
| `clienteNome`               | string    | nome informado no formulário                  |
| `clienteContato`           | string    | WhatsApp (preferência) ou e-mail              |
| `clienteEmail` / `clienteTelefone` | string? | campos separados, para referência        |
| `status`                   | string    | `pendente` → `pago` (sem estoque) → `atribuido` / `cancelado` |
| `origem`                   | string    | sempre `"storefront"`                         |
| `grupoId`                  | string    | agrupa os itens de um mesmo carrinho — é o `external_reference` enviado ao Mercado Pago |
| `criadoEm`                 | timestamp | `serverTimestamp()`                           |
| `mpPaymentId`              | string    | id do pagamento no Mercado Pago, preenchido pelo webhook |
| `pagoEm`                   | timestamp | quando o webhook confirmou o pagamento        |
| `codigo`, `giftcardId`, `atribuidoEm`, `atribuidoPor` | — | preenchidos automaticamente pelo webhook (`atribuidoPor: "mercadopago-auto"`) quando há estoque, ou manualmente pelo admin quando `status` fica em `pago` por falta de estoque |

O cliente vê seus próprios pedidos (e o `codigo` assim que `status` vira `atribuido`) na página **Minha Conta** do storefront, que consulta `pedidos` filtrando por `clienteUid == auth.currentUser.uid`.

### Coleção `clientesPortal/{uid}` (perfil do cliente do storefront)

Criada no cadastro (signup) do cliente. Id do documento = uid do Firebase Auth.

| campo      | tipo      | descrição                          |
|------------|-----------|--------------------------------------|
| `nome`     | string    | nome informado no cadastro           |
| `telefone` | string?   | WhatsApp informado no cadastro       |
| `email`    | string    | e-mail da conta (igual ao Auth)      |
| `criadoEm` | timestamp | `serverTimestamp()`                  |

Só o próprio cliente lê/escreve o seu; o admin pode ler (não escrever) para eventual suporte.

## Regras de segurança do Firestore (obrigatório antes de publicar)

O conteúdo completo e atualizado das regras está em [`firestore.rules`](firestore.rules) — copie o arquivo inteiro e cole no **Firebase Console → Firestore Database → Regras → Publicar** (não uso o Firebase CLI aqui porque não tenho acesso às credenciais do projeto).

Pontos-chave dessa versão:
- `isAdmin()` diferencia funcionário (tem doc em `/users/{uid}`) de cliente comum — **sem essa distinção, qualquer cliente logado conseguiria ler/editar os dados de todo mundo**, já que login de cliente e de admin usam o mesmo Firebase Auth.
- `catalogo`: leitura pública, escrita só admin.
- `pedidos`: só o cliente dono (`clienteUid`) ou o admin conseguem ler; criar exige estar logado E o `clienteUid` do documento ser o do próprio usuário (não dá pra criar pedido em nome de outro uid); editar/apagar é só admin.
- `clientesPortal/{uid}`: só o próprio cliente lê/escreve o seu; admin só lê.

Toda vez que este arquivo mudar (por uma nova funcionalidade), é preciso republicar manualmente no Firebase Console — eu não tenho como aplicar isso automaticamente. **Sem a regra publicada, o site trava em "Conectando ao estoque...", no cadastro, ou no envio do pedido.**

## Pagamento: Mercado Pago (Checkout Pro) com atribuição automática de código

O storefront não é mais um site 100% estático: o `wrangler.toml` define `main = "worker/index.js"` além de `[assets]`, então o mesmo Worker que serve os arquivos também roda o código de servidor em `storefront/worker/`:

```
storefront/worker/
  index.js         -> rotas HTTP: POST /api/criar-pagamento, /api/mp-webhook (tudo o mais cai nos arquivos estaticos)
  mercadoPago.js    -> chama a API do Mercado Pago (criar preferencia, consultar pagamento)
  firestoreRest.js  -> cliente REST do Firestore autenticado como Service Account (bypassa as regras,
                        igual o Admin SDK faria — por isso as credenciais ficam só como secret)
```

Fluxo completo:

1. Cliente confirma o pedido → o storefront grava os `pedidos` (`status: "pendente"`) e chama `POST /api/criar-pagamento` com o `grupoId`.
2. O Worker busca esses pedidos **direto no Firestore** (nunca confia no total calculado só no navegador), cria uma preferência no Mercado Pago com `external_reference = grupoId`, e devolve a URL de checkout.
3. Cliente é redirecionado, paga no Mercado Pago (Pix, cartão ou boleto) e volta para o site.
4. Mercado Pago chama `POST /api/mp-webhook` (server-to-server) avisando o id do pagamento.
5. O Worker **sempre** consulta a API do Mercado Pago de novo (`GET /v1/payments/{id}`) para confirmar o status real — nunca confia no conteúdo do webhook em si. Só segue se `status === "approved"` e o valor pago bater com a soma dos pedidos daquele `grupoId`.
6. Para cada pedido: tenta atribuir 1 giftcard disponível daquela `categoria` via transação (mesma lógica do "Atribuir Código" do admin, só que do lado do servidor). Se conseguir, o pedido já vira `atribuido` com o `codigo` — o cliente vê na hora em "Minha Conta". Se não houver estoque, o pedido fica `pago` para o admin atribuir manualmente depois de repor.
7. O processo é **idempotente**: se o Mercado Pago chamar o webhook de novo (ele faz isso), a segunda chamada não encontra mais pedidos com `status: "pendente"` naquele grupo e não faz nada.

### Configurando os segredos (nunca em código, nunca no chat)

Dois segredos precisam ser configurados **direto no Cloudflare**, rodando estes comandos você mesmo dentro de `storefront/`:

```bash
npx wrangler secret put MP_ACCESS_TOKEN
```
Cola o Access Token do Mercado Pago (painel de desenvolvedores → Suas integrações → sua aplicação → Credenciais). Recomendo testar primeiro com as credenciais de **teste** (começam com `TEST-`) — o Worker detecta esse prefixo e usa automaticamente o link de sandbox do Mercado Pago, sem precisar mudar nada no código. Só troca pelo Access Token de produção depois de validar o fluxo completo com um pagamento de teste.

```bash
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT
```
Cola o conteúdo **inteiro** do arquivo JSON gerado em Firebase Console → ⚙️ Configurações do projeto → Contas de serviço → **Gerar nova chave privada**. Esse arquivo dá acesso total ao Firestore (equivalente ao Admin SDK) — trate como senha, nunca comite no git (por isso o `.gitignore` já bloqueia arquivos `*firebase-adminsdk*.json`).

### Configurando o webhook no Mercado Pago

Painel do Mercado Pago → Suas integrações → sua aplicação → **Webhooks** → adicione a URL `https://SEU-DOMINIO/api/mp-webhook` e marque o evento **Pagamentos**. (O Worker também recebe a `notification_url` que ele mesmo manda em cada preferência, então isso é mais um reforço do que uma obrigação — mas configurar aqui também garante que retries/eventos antigos cheguem.)

### Testando

1. Configure os secrets com as credenciais de **teste** do Mercado Pago primeiro.
2. Use um [usuário de teste comprador](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/additional-content/test-cards) do Mercado Pago para simular um pagamento aprovado.
3. Confirme que o pedido virou `atribuido` sozinho (ou `pago`, se não houver estoque de teste) e que o código aparece em "Minha Conta".
4. Só depois disso, troque `MP_ACCESS_TOKEN` para o Access Token de produção.

### Reforço de segurança opcional (não implementado)

O Mercado Pago permite configurar um segredo de assinatura para o webhook (`x-signature` header) — validar essa assinatura antes de processar é uma camada extra além da consulta obrigatória à API (passo 5 acima, que é a proteção real). Não implementei isso agora para manter o escopo simples; se quiser adicionar depois, o segredo entraria como mais um `wrangler secret put`.

## Rodando localmente

```bash
cd storefront
npm install
npm run dev
```

Abre em `http://localhost:5173`. Se o catálogo estiver vazio (nenhum giftcard disponível ainda no admin), a tela usa um catálogo de exemplo (`FALLBACK`) só para não ficar em branco — os planos aparecem como "Esgotado" até existir estoque real.

## Build de produção

```bash
npm run build
```

Gera a pasta `storefront/dist/` (HTML/CSS/JS estático, sem servidor).

## Deploy no Cloudflare Pages

Duas formas — escolha uma. **Nenhuma delas foi executada por mim**: publicar um site é uma ação visível externamente, então isso fica para você confirmar/rodar.

### Opção A — Painel do Cloudflare (mais simples, sem instalar nada)

1. Rode `npm run build` dentro de `storefront/` (gera `dist/`).
2. Acesse [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create application** → **Pages** → **Upload assets**.
3. Dê um nome ao projeto (ex: `baalshop-recargas`) e arraste a pasta `storefront/dist` inteira.
4. Cloudflare gera uma URL tipo `baalshop-recargas.pages.dev`. Depois, em **Custom domains**, você pode apontar seu domínio próprio.

Toda vez que quiser atualizar: rode `npm run build` de novo e repita o upload (ou use a Opção B/C para automatizar).

### Opção B — Wrangler CLI (linha de comando)

```bash
cd storefront
npm run build
npx wrangler login          # abre o navegador para autorizar sua conta Cloudflare
npx wrangler pages deploy dist --project-name=baalshop-recargas
```

Na primeira vez, o Wrangler pergunta se quer criar o projeto `baalshop-recargas` — confirme. As próximas execuções de `wrangler pages deploy dist --project-name=baalshop-recargas` publicam uma nova versão.

### Opção C — Deploy automático via GitHub (recomendado para manter atualizado)

1. No painel Cloudflare → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**, escolha este repositório.
2. Configure:
   - **Root directory**: `storefront`
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
3. A cada push no branch escolhido, o Cloudflare builda e publica automaticamente. É independente do GitHub Pages do admin (que continua publicando a raiz do repositório).

## Checklist antes de divulgar o link

- [ ] Regras do Firestore (`firestore.rules`) aplicadas no Firebase Console
- [ ] Pelo menos um giftcard cadastrado e **não usado** no admin, para o catálogo mostrar algo "disponível" (senão tudo aparece "Esgotado")
- [ ] `MP_ACCESS_TOKEN` e `FIREBASE_SERVICE_ACCOUNT` configurados via `wrangler secret put` (senão o checkout falha ao criar o pagamento)
- [ ] Webhook cadastrado no painel do Mercado Pago apontando pra `/api/mp-webhook`
- [ ] Testado com credenciais de **teste** do Mercado Pago antes de trocar para produção
- [ ] Testar o fluxo completo uma vez: criar conta no storefront → fazer um pedido de teste → pagar (teste) → confirmar que o pedido virou `atribuido` sozinho e o código aparece em **Minha Conta**
- [ ] Trocar os links de WhatsApp/e-mail no rodapé (`src/App.jsx`, componente `Footer`) para os reais
- [ ] Configurar domínio próprio em Cloudflare Pages, se for usar um (ex: `recargas.baalshop.com.br`)

## Limitações conhecidas (por decisão de escopo)

- **Login é obrigatório para comprar.** O cliente cria conta (e-mail+senha, mesmo Firebase Auth do admin) antes de finalizar o pedido; isso é o que permite ele ver o código depois em "Minha Conta".
- **Sem notificação push/e-mail avisando que o código ficou pronto.** O cliente vê o código sozinho em "Minha Conta" assim que o pagamento é confirmado, mas precisa voltar lá pra checar — não manda aviso proativo.
- **Sem reserva de estoque durante o checkout.** Um pedido "pendente" não trava o giftcard antes do pagamento — se dois clientes pedirem o mesmo produto quase ao mesmo tempo e só houver 1 disponível, o primeiro pagamento confirmado leva o código (via transação no Worker); o outro fica `pago` aguardando repor estoque.
- **Webhook não valida a assinatura do Mercado Pago** (`x-signature`) — mitigado pelo fato de que o Worker sempre reconsulta a API do Mercado Pago antes de confiar em qualquer notificação, mas é um reforço a mais que dá pra adicionar depois.
