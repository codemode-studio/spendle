# Spendle

Aplicativo local para consolidar contas PF/PJ brasileiras, investimentos e cartões, provar saldos contra extratos bancários e reconciliar transferências.

São duas partes: o app web em `src/` (TanStack Start) e o backend em [`packages/server`](./packages/server/README.md) (Effect 4 e SQLite). O app só fala com o backend pelas server functions; o navegador nunca acessa a API diretamente. O backend V1 foi aposentado ([ADR 003](./plans/adrs/003-backend-v2-effect.md)).

## Executar

Use Node.js 22.22.0 (`.node-version`) e o CLI `vp` do [Vite+](https://viteplus.dev), instalado com `curl -fsSL https://vite.plus | bash`. Ele usa o pnpm 12.4.2 de `packageManager`; rode os comandos do projeto pelo `vp`, não pelo `pnpm`.

```bash
cp .env.example .env.local
vp install --frozen-lockfile
vp run setup:check
vp run --filter @spendle/server dev   # API em http://127.0.0.1:4100
vp run dev                            # app web
```

`vp run dev` escuta em `http://localhost:3000`, sem depender do Tailscale.

O app exige entrar com Google. Em `.env.local`, preencha `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e, em `SPENDLE_ALLOWED_EMAILS`, as contas Google que podem entrar; lista vazia não deixa ninguém entrar. O cliente OAuth do Google precisa do redirecionamento `http://localhost:3000/api/auth/callback/google`. Pessoas, sessões e os aplicativos conectados por MCP ficam no banco do Better Auth em `data/auth/auth.sqlite` (`SPENDLE_AUTH_DATABASE_PATH`), separado dos dados financeiros; as tabelas são criadas no primeiro acesso.

Cada conta Google enxerga só os dados do seu espaço familiar; quem criou o espaço adiciona as outras pessoas da família em Configurações, que também precisam estar em `SPENDLE_ALLOWED_EMAILS`. Se você já tinha dados antes dos espaços, rode uma vez, antes de entrar: `vp run --filter @spendle/server claim-space --email <seu e-mail>`.

O app lê `SPENDLE_API_URL` (padrão `http://127.0.0.1:4100`) e o token opcional `SPENDLE_API_TOKEN`. O servidor guarda um banco por espaço familiar em `data/v2/`, fora da pasta pública e do Git; suas variáveis (Pluggy, OpenRouter, TypeSafe) estão no [README do servidor](./packages/server/README.md).

Os recursos de IA (assistente e classificador de categorias) ficam ligados por padrão quando o servidor tem as chaves, sem consentimento separado. Sem chave, nunca chamam o modelo. A resposta de um modelo nunca libera uma importação nem ensina a base de categorias.

## MCP

O Spendle expõe um servidor MCP em `<BETTER_AUTH_URL>/api/mcp` para assistentes como Claude Code, Claude e Cursor. O cliente descobre o login sozinho: a pessoa entra com Google, aprova o aplicativo em `/autorizar` e ele passa a ler contas, transações, planejamento, previsão de caixa, cartões, investimentos e as conexões de Open Finance, além de atualizar e sincronizar essas conexões. O MCP não altera categorias, planos nem contas. Tirar um e-mail de `SPENDLE_ALLOWED_EMAILS` corta também os tokens já emitidos para ele.

```sh
claude mcp add --transport http spendle http://localhost:3000/api/mcp
```

## Migração do V1

Os dados de uma instalação V1 entram no Spendle por `migrate-v1`, que lê o arquivo SQLite do V1 só para leitura e traz configuração e decisões humanas; os fatos são observados de novo nas fontes:

```bash
vp run --filter @spendle/server migrate-v1 --from "$PWD/data/financas.db" --dry-run
vp run --filter @spendle/server migrate-v1 --from "$PWD/data/financas.db"
```

Detalhes no [README do servidor](./packages/server/README.md#migração-do-v1).

## Comandos

```bash
vp run typecheck
vp lint
vp fmt --check                         # vp run fmt formata e corrige o lint
vp run test                            # testes do app web
vp build
vp run --filter @spendle/server verify # tipos, diagnósticos Effect e testes do servidor
vp run verify                          # tudo acima, também no CI
```

## Arquitetura

- TanStack Start, Router e Query; TypeScript, Tailwind CSS e shadcn `base-nova` com Base UI
- Backend em Effect 4 com `effect/sql` sobre `node:sqlite`, contrato HTTP tipado em `@spendle/server/api`
- Valores em centavos, percentuais em basis points e BRL como moeda-base
- Fatos observados de bancos (Pluggy) e arquivos (OFX, CSV, PDF) imutáveis; decisões humanas duráveis; o resto é projeção recalculável
- Duas pontas preservadas em transferências, pagamentos de fatura e distribuições de lucro

O mapa do código está em [`plans/architecture.md`](./plans/architecture.md); escopo e decisões em [`plans/`](./plans/README.md). Verificações e limitações conhecidas estão em [`docs/`](./docs/README.md).

## Verificação com agentes

Quando solicitar ou autorizar a verificação com o navegador integrado, siga a [skill browser-qa](.agents/skills/browser-qa/SKILL.md):

```bash
vp run qa:start 3100       # app na 3100 e API de QA em memória na 4300, numa nova pasta .qa/
vp run qa:inspect <pasta>  # contas, lançamentos e importações do run, enquanto ele roda
vp run qa:clean <pasta>    # remover um run depois de parar seu servidor
```

Para verificações somente de leitura, reutilize um servidor adequado já em execução. Verificações que alteram dados usam um run isolado por worktree e uma porta explícita. Não é preciso copiar `.env.local` ou dados reais: a API de QA semeia dados sintéticos, usa uma Pluggy falsa e mantém a IA desligada. O run grava `server.log` (app) e `server-api.log` (API).
