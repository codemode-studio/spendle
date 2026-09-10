# Estado de Transações na URL

08/09/2026. Base `7ee8e81` com alterações locais. TanStack Router nativo.

QA sintética `.qa/run-LYBL38`, porta 3101, criada com `pnpm qa:start 3101 121`.

- Testes de esquema: página inválida volta a 1, busca limitada a 200 caracteres, categoria legada `uncategorized` e R$ 1.500,51 preservados.
- Router com histórico em memória: link inicial, paginação, filtro voltando à página 1, voltar/avançar e remoção dos parâmetros padrão.
- HTTP/SSR: páginas 1, 2 e 3 retornaram 50, 50 e 21 descrições, totalizando 121 transações sem repetição. Busca por `Despesa QA 120` retornou uma transação; `page=-1` retornou a primeira página.

O navegador integrado retornou `No browser is available`. Cliques, hidratação, recarga e mutações pela interface ficaram sem verificação. Testes e HTTP/SSR não substituem essa cobertura.

`pnpm setup:check`, `pnpm verify` e `git diff --check` passaram: 470 testes aprovados e 10 ignorados. Fixtures privadas não utilizadas. Servidor encerrado.
