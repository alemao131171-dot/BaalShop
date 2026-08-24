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
| `formaPagamentoPreferida`  | string    | `pix` ou `card` (só preferência do cliente)    |
| `status`                   | string    | `pendente` → `atribuido` / `cancelado`         |
| `origem`                   | string    | sempre `"storefront"`                         |
| `grupoId`                  | string    | agrupa os itens de um mesmo carrinho          |
| `criadoEm`                 | timestamp | `serverTimestamp()`                           |
| `codigo`, `giftcardId`, `atribuidoEm`, `atribuidoPor` | — | preenchidos pelo admin ao atribuir |

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
- [ ] `src/pixConfig.js` preenchido com a chave/nome/cidade Pix reais (senão o checkout não mostra QR Code)
- [ ] Testar o fluxo completo uma vez: criar conta no storefront → fazer um pedido de teste → confirmar que ele aparece em admin → **Pedidos** → **Atribuir Código** funciona → o código aparece em **Minha Conta** no storefront
- [ ] Trocar os links de WhatsApp/e-mail no rodapé (`src/App.jsx`, componente `Footer`) para os reais
- [ ] Configurar domínio próprio em Cloudflare Pages, se for usar um (ex: `recargas.baalshop.com.br`)

## Limitações conhecidas (por decisão de escopo)

- **Login é obrigatório para comprar.** O cliente cria conta (e-mail+senha, mesmo Firebase Auth do admin) antes de finalizar o pedido; isso é o que permite ele ver o código depois em "Minha Conta".
- **Não há envio automático de código por e-mail/WhatsApp.** O pedido fica "pendente"; a equipe vê o código em admin → Pedidos → Atribuir Código, e o cliente passa a ver o código sozinho em "Minha Conta" (não precisa mais de contato manual, mas ainda não há notificação push/e-mail avisando que ficou pronto).
- **QR Code Pix é estático com valor fixo, sem gateway/webhook.** Não há confirmação automática de pagamento — a equipe confere o extrato do Mercado Pago e só depois clica "Atribuir Código" no admin.
- **Sem reserva de estoque.** Um pedido "pendente" não trava o giftcard — se dois clientes pedirem o mesmo produto quase ao mesmo tempo e só houver 1 disponível, o admin só conseguirá atribuir código a um deles (o outro pedido ficará pendente até repor estoque).

Se algum dia quiser evoluir para envio automático de e-mail/push quando o código for liberado, ou um gateway de pagamento real com confirmação automática (Mercado Pago, Pix automático etc.), isso exigiria uma Cloud Function ou backend adicional — não está implementado aqui.
