# Spendle

Spendle reúne as finanças de uma família brasileira num só lugar: contas PF e PJ, cartões e investimentos. Ele confere cada saldo contra o extrato do banco, liga as duas pontas de transferências e pagamentos de fatura e mostra o mês contra o planejado.

É um projeto pessoal que roda na sua máquina. Os dados ficam em SQLite local, e só entra quem você autoriza com uma conta Google.

## Executar

Você precisa do Node.js 22.22.0 (`.node-version`) e do CLI `vp` do [Vite+](https://viteplus.dev):

```bash
curl -fsSL https://vite.plus | bash
```

Depois:

```bash
cp .env.example .env.local
vp install --frozen-lockfile
vp run setup:check
vp run --filter @spendle/server dev   # API em http://127.0.0.1:4100
vp run dev                            # app em http://localhost:3000
```

### Entrar com Google

Preencha em `.env.local`:

- `BETTER_AUTH_SECRET`: gere com `openssl rand -base64 32`.
- `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`: de um cliente OAuth do Google com o redirecionamento `http://localhost:3000/api/auth/callback/google`.
- `SPENDLE_ALLOWED_EMAILS`: as contas que podem entrar. Com a lista vazia, ninguém entra.

Cada conta enxerga só o seu espaço familiar. Quem criou o espaço adiciona o resto da família em Configurações; essas pessoas também precisam estar em `SPENDLE_ALLOWED_EMAILS`.

### Bancos e IA

Open Finance (Pluggy), o assistente e o classificador de categorias são configurados no [README do servidor](./packages/server/README.md). A IA fica ligada quando o servidor tem as chaves e nunca é chamada sem elas. Uma resposta de modelo não libera importação nem ensina categorias: isso só acontece com decisões suas.

## Usar com assistentes (MCP)

Claude Code, Claude, Cursor e outros clientes MCP podem ler suas finanças em `<BETTER_AUTH_URL>/api/mcp`:

```bash
claude mcp add --transport http spendle http://localhost:3000/api/mcp
```

O cliente abre o login sozinho. Você entra com Google e aprova o aplicativo em `/autorizar`. A partir daí ele lê contas, transações, planejamento, previsão de caixa, cartões, investimentos e conexões de Open Finance, e pode atualizar e sincronizar essas conexões. Ele não altera categorias, planos nem contas. Tirar um e-mail de `SPENDLE_ALLOWED_EMAILS` também corta o acesso que esse e-mail já tinha dado.

## Onde ficam os dados

Na sua máquina:

- `data/v2/`: um banco por espaço familiar, com os dados financeiros.
- `data/auth/auth.sqlite`: pessoas, sessões e aplicativos MCP aprovados (`SPENDLE_AUTH_DATABASE_PATH`).

As duas pastas ficam fora do Git. Em produção, cada espaço é um Durable Object com o próprio SQLite e o Better Auth usa o D1 `spendle-auth` (veja [Publicar](#publicar)). Fatos vindos de bancos e arquivos nunca são alterados, e suas decisões ficam guardadas. Todo o resto pode ser recalculado a partir dos dois.

## Publicar

A produção é um Worker da Cloudflare, `spendle`, em `https://spendle.codemode.studio` ([ADR 004](./plans/adrs/004-cloudflare-workers.md)). `vp run build` gera o Worker; `vp run dev` continua no Node, com a API de `packages/server`.

- **Deploy:** o workflow `Deploy` publica cada commit de `main` depois que o `Verify` passa, com os segredos `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID` do repositório. À mão: `vp run build && vp run deploy`, com o `cf` autenticado.
- **Configuração:** `cloudflare.config.ts` declara o Worker, os Durable Objects (`Control` e um `Space` por espaço), o D1 `spendle-auth`, as variáveis públicas e os segredos que ele espera.
- **Segredos:** ficam na Cloudflare e passam de uma versão para a próxima; `cf workers secrets list --worker spendle` lista os nomes. Para trocar um: `cf workers secrets update <NOME> --worker spendle --type secret_text --text <valor>`, ou `cf deploy --secrets-file <arquivo>` junto com um deploy.
- **Google:** o cliente OAuth precisa listar `https://spendle.codemode.studio/api/auth/callback/google`.
- **Pluggy:** o servidor registra o webhook `https://spendle.codemode.studio/api/pluggy/webhook` na primeira requisição do objeto `Control` depois de cada deploy.
- **Testar o Worker localmente:** crie `.dev.vars.qa` com segredos sintéticos (`BETTER_AUTH_URL=http://127.0.0.1:4791`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SPENDLE_ALLOWED_EMAILS=qa@spendle.local`, `SPENDLE_QA_SIGN_IN_TOKEN`) e rode `vp build --mode qa`, depois `vp preview --mode qa --port 4791`. Ele roda no workerd com o estado em `.cloudflare/state/`, e `/api/auth/qa/sign-in?token=<SPENDLE_QA_SIGN_IN_TOKEN>` faz login.

## Desenvolvimento

O app web fica em `src/` (TanStack Start). Ele fala com o backend em [`packages/server`](./packages/server/README.md) (Effect 4 e SQLite) só por server functions. Rode os comandos pelo `vp`, nunca pelo `pnpm`:

```bash
vp run typecheck
vp lint
vp fmt --check   # vp run fmt formata e corrige o lint
vp run test
vp run verify    # o mesmo gate do CI
```

Agentes verificam as mudanças de ponta a ponta sozinhos: `vp run qa:start` sobe um run isolado com dados sintéticos e login de QA, e a skill [browser-qa](./.agents/skills/browser-qa/SKILL.md) explica o resto. As regras para agentes estão em [AGENTS.md](./AGENTS.md).

Arquitetura e decisões ficam em [`plans/`](./plans/README.md). Registros de QA ficam em [`docs/`](./docs/README.md).
