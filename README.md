# Spendle

Aplicativo local para consolidar contas PF/PJ brasileiras, investimentos e cartões, provar saldos contra extratos bancários e reconciliar transferências.

São duas partes: o app web em `src/` (TanStack Start) e o backend V2 em [`packages/server`](./packages/server/README.md) (Effect 4 e SQLite). O app só fala com o backend pelas server functions; o navegador nunca acessa a API diretamente. O backend V1 foi aposentado ([ADR 003](./plans/adrs/003-backend-v2-effect.md)).

## Executar

Use Node.js 22.22.0 (`.node-version`) e pnpm 12.4.2 (`packageManager`).

```bash
cp .env.example .env.local
pnpm install --frozen-lockfile
pnpm setup:check
pnpm --filter @spendle/server dev   # API V2 em http://127.0.0.1:4100
pnpm dev                            # app web
```

`pnpm dev` escuta somente no endereço Tailscale da máquina (`tailscale ip -4`), acessível pelos dispositivos da tailnet e não pela rede local; falha se o Tailscale não estiver ativo. Acesse `http://<nome-da-máquina>.<tailnet>.ts.net:3000` ou o IP Tailscale na porta 3000.

O app lê `SPENDLE_API_URL` (padrão `http://127.0.0.1:4100`) e o token opcional `SPENDLE_API_TOKEN`. O servidor guarda o banco em `data/v2/`, fora da pasta pública e do Git; suas variáveis (Pluggy, OpenRouter, TypeSafe) estão no [README do servidor](./packages/server/README.md).

Os recursos de IA (assistente e classificador de categorias) ficam ligados por padrão quando o servidor tem as chaves, sem consentimento separado. Sem chave, nunca chamam o modelo. A resposta de um modelo nunca libera uma importação nem ensina a base de categorias.

## Migração do V1

Os dados de uma instalação V1 entram no V2 por `migrate-v1`, que lê o arquivo SQLite do V1 só para leitura e traz configuração e decisões humanas; os fatos são observados de novo nas fontes:

```bash
pnpm --filter @spendle/server migrate-v1 --from "$PWD/data/financas.db" --dry-run
pnpm --filter @spendle/server migrate-v1 --from "$PWD/data/financas.db"
```

Detalhes no [README do servidor](./packages/server/README.md#migração-do-v1).

## Comandos

```bash
pnpm typecheck
pnpm lint
pnpm test                            # testes do app web
pnpm build
pnpm --filter @spendle/server verify # tipos, diagnósticos Effect e testes do servidor
pnpm verify                          # tudo acima, também no CI
```

## Arquitetura

- TanStack Start, Router e Query; TypeScript, Tailwind CSS e shadcn `base-nova` com Base UI
- Backend V2 em Effect 4 com `effect/sql` sobre `node:sqlite`, contrato HTTP tipado em `@spendle/server/api`
- Valores em centavos, percentuais em basis points e BRL como moeda-base
- Fatos observados de bancos (Pluggy) e arquivos (OFX, CSV, PDF) imutáveis; decisões humanas duráveis; o resto é projeção recalculável
- Duas pontas preservadas em transferências, pagamentos de fatura e distribuições de lucro

O mapa do código está em [`plans/architecture.md`](./plans/architecture.md); escopo e decisões em [`plans/`](./plans/README.md). Verificações e limitações conhecidas estão em [`docs/`](./docs/README.md).

## Verificação com agentes

Para verificar a interface com o navegador integrado, siga a [skill browser-qa](.agents/skills/browser-qa/SKILL.md):

```bash
pnpm qa:start 3100       # app na 3100 e API V2 de QA em memória na 4300, numa nova pasta .qa/
pnpm qa:inspect <pasta>  # contas, lançamentos e importações do run, enquanto ele roda
pnpm qa:clean <pasta>    # remover um run depois de parar seu servidor
```

Cada worktree usa seu próprio run e uma porta explícita. Não é preciso copiar `.env.local` ou dados reais: a API de QA semeia dados sintéticos, usa uma Pluggy falsa e mantém a IA desligada. O run grava `server.log` (app) e `server-v2.log` (API).
