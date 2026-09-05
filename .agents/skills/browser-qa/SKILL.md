---
name: browser-qa
description: Verify Finanças da Família changes through an available integrated browser using isolated synthetic data. Use after changes to screens, navigation, mutations, import flows, or query invalidation.
---

# Browser QA

Use the available integrated browser tool. No Playwright installation is required. Read its tool documentation before operating the browser; do not assume APIs for upload, screenshots or console access exist.

## Start an isolated run

Run `pnpm setup:check`, then `pnpm qa:start 3100` from the checkout being verified. Choose another explicit port for concurrent worktrees. The command prints a URL, run directory, database and upload directory. It refuses an occupied port. Use only that printed URL for mutations.

The run contains synthetic account `Conta BRL de teste`, card `Cartão BRL de teste`, and categories. A verified zero balance on the last day of the previous month anchors import reconciliation. AI calls are disabled. The run directory contains `balanced.ofx`, `unbalanced.ofx`, and `server.log`. Files and database belong to this run; do not copy or symlink a user's `data/` into QA.

For transaction pagination/performance use a separate `pnpm qa:start 3101 121` run. Its 121 synthetic expenses change balances; use the empty default run for import assertions.

## Select checks by the change

| Change                           | Browser assertions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routes or shell                  | Open `/`, `/transacoes`, `/configuracoes`, `/categorias`, `/planejamento` and `/importar`; confirm the intended page renders. Open `/qa-missing`; verify the not-found message and follow “Ir para visão geral”.                                                                                                                                                                                                                                                                                                        |
| Transactions or invalidation     | Create a manual BRL expense of R$ 10,00 on the synthetic account. Confirm description, negative amount, category, and account. Change the category, navigate away and back, then reload to verify persistence. Check category totals reflect it.                                                                                                                                                                                                                                                                        |
| Import staging/commit            | On `/importar`, select the synthetic account and upload `balanced.ofx` through the browser. Resolve any required coverage review using its declared dates. Confirm two movements, +R$ 1.000,00 and -R$ 100,00, closing balance R$ 900,00 and zero difference before committing. Commit, then inspect the transaction list. Upload the identical file again; confirm no additional transactions. Use a separate fresh run for `unbalanced.ofx`; confirm its R$ 999,00 control cannot be committed against net R$ 900,00. |
| Transaction filtering/pagination | Use the 121-row run. Confirm 50 rows on page one, 50 on page two, 21 on page three, no repeated IDs via `qa:inspect`/query results if needed. Search for a specific numbered expense and confirm the global result count and reset to page one. Clear filters and check next/previous navigation.                                                                                                                                                                                                                       |
| Planning or financial reads      | Open planning and configuration after a mutation. Confirm balances and strategy totals refresh; the page must not remain indefinitely loading. Use `pnpm bench` and integration tests for exact history/FX calculations.                                                                                                                                                                                                                                                                                                |

Perform import checks before manual transaction checks, or start a fresh run; changing the ledger changes reconciliation expectations. Read current screen labels if they differ from this guide. Do not replace the browser mutation with a direct database write and call it browser coverage.

## Evidence and cleanup

Record URL, commit/worktree, run directory, flows actually exercised, expected versus observed values, and pass/fail. Save screenshots with the browser tool when supported, especially on failure. Consult `server.log` for operation IDs/durations and browser console/network errors when the tool exposes them. `pnpm qa:inspect <run-directory>` reads the QA database without changing it.

If file upload or another required browser capability is unavailable, mark that flow unverified and run its integration test as separate evidence. Do not claim a browser pass based on a server test.

Stop the spawned server before `pnpm qa:clean <run-directory>`. Preserve a failing run until its evidence is recorded. The cleanup command checks ownership and refuses an active run.
