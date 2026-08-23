# BaalShop Recargas (storefront)

Site público de vendas, separado do admin (`index.html` no GitHub Pages). Este projeto vai para o **Cloudflare Pages**, em domínio próprio, e conversa com o **mesmo** Firebase do admin (`baalshopgiftcards`) só que com permissões públicas bem restritas.

## Como as duas partes se conectam (Firestore)

```
storefront (Cloudflare Pages, público, sem login)
   lê   -> catalogo   (contagem de disponíveis, sem código)
   cria -> pedidos    (1 documento por unidade, status "pendente")

admin (GitHub Pages, exige login)
   escreve -> catalogo   (syncCatalogo(), roda sozinho a cada mudança em giftcards)
   lê/edita -> pedidos   (tela "Pedidos": Atribuir Código / Cancelar)
```

### Coleção `catalogo` (leitura pública, sem código nenhum)

Escrita automaticamente pelo admin (`syncCatalogo()` em `index.html`). Um documento por descrição de produto:

| campo         | tipo    | descrição                                  |
|---------------|---------|---------------------------------------------|
| `desc`        | string  | descrição exata do giftcard (chave de match) |
| `tipo`        | string  | `mensal` / `trimestral` / `anual`            |
| `categoria`   | string? | categoria (opcional)                         |
| `valor`       | number? | preço de venda                               |
| `disponiveis` | number  | quantos giftcards com essa `desc` estão livres |
| `atualizadoEm`| timestamp | última sincronização                       |

O storefront **nunca** vê `code` — essa coleção não guarda códigos.

### Coleção `pedidos` (criação pública, sem leitura/edição pública)

O storefront cria **um documento por unidade comprada** (se o cliente pede 2x o mesmo plano, são 2 documentos, ligados por `grupoId`). Isso é o que permite ao admin usar "Atribuir Código" (que busca 1 giftcard livre por `desc` e faz a atribuição via transação).

| campo                      | tipo      | descrição                                    |
|----------------------------|-----------|-----------------------------------------------|
| `desc`                     | string    | igual ao `catalogo.desc` do item comprado     |
| `tipo`                     | string    | copiado do catálogo                           |
| `valor`                    | number    | preço no momento da compra                    |
| `clienteNome`               | string    | nome informado no formulário                  |
| `clienteContato`           | string    | WhatsApp (preferência) ou e-mail              |
| `clienteEmail` / `clienteTelefone` | string? | campos separados, para referência        |
| `formaPagamentoPreferida`  | string    | `pix` ou `card` (só preferência do cliente)    |
| `status`                   | string    | `pendente` → `atribuido` / `cancelado`         |
| `origem`                   | string    | sempre `"storefront"`                         |
| `grupoId`                  | string    | agrupa os itens de um mesmo carrinho          |
| `criadoEm`                 | timestamp | `serverTimestamp()`                           |
| `codigo`, `giftcardId`, `atribuidoEm`, `atribuidoPor` | — | preenchidos pelo admin ao atribuir |

## Regras de segurança do Firestore (obrigatório antes de publicar)

O projeto Firebase precisa permitir **leitura pública** de `catalogo` e **criação pública** (sem leitura/edição) de `pedidos`, sem abrir mais nada. Isso é feito no **Firebase Console → Firestore Database → Regras** (não uso o Firebase CLI aqui porque não tenho acesso às credenciais do projeto). Adicione ao lado das regras já existentes para `giftcards`, `users`, `clientes`, `categorias`, `config`:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // ... regras existentes de giftcards/users/clientes/categorias/config (exigem login) ...

    match /catalogo/{doc} {
      allow read: if true;
      allow write: if request.auth != null; // só o admin logado escreve
    }

    match /pedidos/{doc} {
      allow read, update, delete: if request.auth != null; // só o admin logado
      allow create: if request.auth == null
        && request.resource.data.status == 'pendente'
        && request.resource.data.origem == 'storefront'
        && request.resource.data.desc is string
        && request.resource.data.clienteNome is string
        && request.resource.data.valor is number;
    }
  }
}
```

Isso garante que qualquer visitante só consegue **criar** um pedido pendente (não pode ler pedidos de outras pessoas, não pode editar status, não pode ver códigos). **Sem essa regra publicada, o site em produção não vai conseguir carregar o catálogo nem enviar pedidos** (vai ficar preso em "Conectando ao estoque..." ou dar erro ao confirmar).

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

- [ ] Regras do Firestore acima aplicadas no Firebase Console
- [ ] Pelo menos um giftcard cadastrado e **não usado** no admin, para o catálogo mostrar algo "disponível" (senão tudo aparece "Esgotado")
- [ ] Testar o fluxo completo uma vez: fazer um pedido de teste no storefront → confirmar que ele aparece em admin → **Pedidos** → **Atribuir Código** funciona
- [ ] Trocar os links de WhatsApp/e-mail no rodapé (`src/App.jsx`, componente `Footer`) para os reais
- [ ] Configurar domínio próprio em Cloudflare Pages, se for usar um (ex: `recargas.baalshop.com.br`)

## Limitações conhecidas (por decisão de escopo: "só formulário")

- **Não há envio automático de código por e-mail/WhatsApp.** O pedido fica "pendente"; a equipe vê o código em admin → Pedidos → Atribuir Código e precisa mandar manualmente para o cliente.
- **Não há gateway de pagamento real.** "Pix" e "Cartão" no formulário são só a preferência do cliente; o pagamento é combinado por fora (WhatsApp) antes da equipe atribuir o código.
- **Sem reserva de estoque.** Um pedido "pendente" não trava o giftcard — se dois clientes pedirem o mesmo produto quase ao mesmo tempo e só houver 1 disponível, o admin só conseguirá atribuir código a um deles (o outro pedido ficará pendente até repor estoque).

Se algum dia quiser evoluir para envio automático de e-mail ou um gateway de pagamento real (Mercado Pago, Pix automático etc.), isso exigiria uma Cloud Function ou backend adicional — não está implementado aqui.
