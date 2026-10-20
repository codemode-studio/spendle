# Arquitetura

O Spendle tem duas partes: o app web em `src/` e o backend em
`packages/server` ([ADR 003](./adrs/003-backend-v2-effect.md)). O backend V1
(Drizzle, `src/db`, `src/domain` e os módulos `*.server.ts` de finanças) e a
migração dos dados dele foram removidos.

## App web (`src/`)

- `src/routes`: rotas do TanStack Start. Cada rota carrega read models do V2
  por TanStack Query e compõe as seções da feature.
- `src/features/v2`: server functions (`*.functions.ts`) que validam a entrada
  com `Schema` e chamam a API pelo cliente de `src/lib/v2/client.server.ts`;
  `queries.ts` reúne chaves de query, opções e invalidações.
- `src/features/<área>`: componentes e derivações de apresentação (Home,
  Categorias, Planejamento, Investimentos, Configurações). Não guardam regras
  financeiras: saldos, reconciliação, categorias, recorrências, orçamento e
  previsão vêm prontos da API.
- `src/lib`: formatação de moeda, datas e períodos em pt-BR, presets de
  estratégia, gasto por categoria no período e o estado de apresentação de uma
  recorrência. `src/lib/v2/errors.ts` traduz falhas da API em mensagens.
- `src/components`: shell, diálogos compartilhados e os componentes shadcn.

O navegador nunca fala com a API: só as server functions, no servidor, com o
token opcional `SPENDLE_API_TOKEN`.

## Backend V2 (`packages/server`)

Effect 4 sobre SQLite (`node:sqlite`), com banco próprio em `data/v2/`. Fatos
observados em bancos e arquivos são imutáveis, decisões humanas são duráveis e
o resto é projeção recalculável. Os módulos e a API estão no
[README do servidor](../packages/server/README.md).

## Regras de dependência

- `src/` importa do servidor só o contrato `@spendle/server/api`.
- Rotas e componentes chamam server functions; não montam regras financeiras.
- Política de casamento e categorização fica pura no servidor, testável sem
  I/O; a complexidade fica nos adaptadores (Pluggy, arquivos, IA).

As garantias financeiras e decisões de continuidade permanecem normativas no
[ADR 001](./adrs/001-import-continuity-and-reconciliation.md).
