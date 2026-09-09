# Estado de Transações na URL

Data: 2026-09-08. Checkout: `7ee8e81` com alterações locais anteriores preservadas.
Implementação: TanStack Router nativo, sem nuqs.

Ambiente sintético: `http://127.0.0.1:3101`, criado por `pnpm qa:start 3101 121`.
Diretório: `.qa/run-LYBL38`.

## Evidências

- `pnpm setup:check`: passou com SQLite, migrações e fixture sintética.
- Teste de esquema: páginas inválidas retornam a 1, busca limitada a 200 caracteres, categoria legada `uncategorized` e R$ 1.500,51 preservados.
- Teste de integração com Router e histórico em memória: link inicial, próxima página, filtro com retorno à página 1, voltar, avançar e limpeza dos parâmetros padrão.
- HTTP/SSR no ambiente sintético: páginas 1, 2 e 3 retornaram 50, 50 e 21 descrições distintas. A união contém 121 transações, sem repetição entre páginas.
- HTTP/SSR: `search=Despesa QA 120` retornou exatamente uma transação; `page=-1` retornou os mesmos resultados da primeira página.

## Limitações

O navegador integrado respondeu `No browser is available`. Não foram verificados cliques na tela, hidratação, recarga no navegador ou mutações por UI. As verificações HTTP/SSR e de histórico em memória são evidências separadas, não aprovação de browser QA.
Fixtures financeiras privadas não foram utilizadas. Não houve alterações de leitura ou escrita do ledger.

Verificação final: `pnpm verify` passou. Tipos, lint e build aprovados; 73 arquivos de teste passaram, 470 testes passaram e 10 testes foram ignorados em 2 arquivos. `git diff --check` passou. Servidor QA encerrado após as verificações.
