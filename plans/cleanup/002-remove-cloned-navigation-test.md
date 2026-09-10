# Remove the cloned transaction-page test

Priority P2. Effort S, hours. Risk low. Category tests. Depends on none.

## Why

The second test in `transactions.search.test.tsx` builds its own controls, route and loader. It does not test the production page. Its search action pushes history even though production replaces the current entry. Remove the clone, preserve the useful schema test and verify the real route through integrated browser QA.

## Execution rules

This is a local TypeScript/React app using TanStack Start, Router, Query, Drizzle and SQLite. Use Node 22.22.0 and pnpm 9.15.9. Read AGENTS.md first. Preserve the existing uncommitted work: this plan was written against commit `fef0d59` plus a dirty working tree on 2026-09-09. Do not reset, stash, commit, push, install a test framework, or access real financial data.

Before editing, run `git status --short` and save the baseline outside the tracked tree. Compare current source with the excerpts below and search all callers. If the relevant behavior has changed, reassess the deletion before proceeding. For a separate worktree, preserve the relevant dirty changes explicitly; a checkout of HEAD alone is not the audited state.

If dependencies are missing, run `pnpm install --frozen-lockfile`, then `pnpm setup:check`. Otherwise run `pnpm setup:check` directly. Expected result: exit 0. No database integration test may fall back to local financial data. Existing tests use `openTestDatabase()` from `src/test/database.ts`; temporary uploads belong to its directory.

Use existing Vitest imports and assertion style:
```ts
import { describe, expect, it } from 'vitest'
```
Run the focused command before and after editing. Record an existing failure separately; never change unrelated code to make the baseline green. Finish with `pnpm verify`, which runs typecheck, ESLint, tests and build. Record skipped/private-fixture checks separately. Do not claim private statements or browser flows were tested by unit tests.

Keep centavo precision, immutable imported facts, zero-difference import gating, both transfer sides and frozen closed budgets. Do not modify knowledge-base learning, server validators, query keys, migrations or financial calculations.

Update this plan's row in `plans/cleanup/README.md` only after verification. Review your diff against the recorded dirty baseline, not just against HEAD. If verification fails twice after a reasonable scoped fix, or runtime callers invalidate a deletion premise, stop and report the concrete issue.

## Scope and current state

Modify only `src/features/finance/transactions.search.test.tsx`, this plan's status and `plans/cleanup/002-qa.md`.

At line 53 the obsolete test starts:
```ts
it('keeps URL state, loader dependencies and back/forward navigation in sync', async () => {
  function Controls() {
```

It creates a separate route whose loader is:
```ts
loader: ({ deps }) => deps,
component: Controls,
```

The real page at `src/routes/transacoes.tsx:135` instead uses:
```ts
const setSearch = (value: string) =>
  void setUrlState({ search: value, page: 1 }, { replace: true })
```

Keep the first test, including invalid pages, legacy uncategorized links, decimal-comma parsing to 150051 centavos, and the 200-character search limit. Do not modify the route, search schema or query cache. Do not add a replacement toy route or E2E framework.

## Steps and checks

1. Run `pnpm exec vitest run src/features/finance/transactions.search.test.tsx`; expect both existing tests to pass. Read the production route and the two tests to confirm the discrepancy.
2. Remove only the second test, its Testing Library/router imports, `afterEach(cleanup)`, unused `transactionSearchDefaults` import and the jsdom environment directive. Keep the filename to avoid unnecessary churn. The remaining test uses only Vitest and the production schema/conversion functions. Run the focused command; expect one passing test.
3. Read `.agents/skills/browser-qa/SKILL.md`. Start `pnpm qa:start 3101 121` on an unused port. Through the integrated browser, verify 50/50/21 transaction rows, next/previous navigation, and a search for the synthetic expense numbered 121 resetting to page one with a global result count of one. Clear filters and confirm pagination returns.
4. Check actual history behavior at desktop and mobile widths. From unfiltered page one go to page two, then enter search text. Searching must replace that page-two entry. Browser Back should return to the preceding page-one entry, not the pre-search page-two entry; Forward should restore the filtered entry. Record the observed URLs and controls, avoiding assertions based on the removed test's behavior. Reload the filtered URL and confirm its state survives. Save evidence in `002-qa.md`, stop the server and clean its owned run.
5. Run `pnpm verify`; expect exit 0. Run `rg -n 'Controls|createRoute|createMemoryHistory|RouterProvider|jsdom|testing-library' src/features/finance/transactions.search.test.tsx`; expect no matches, exit 1.

## Done criteria

- The preserved schema test passes with its original assertions.
- No cloned route, controls or jsdom dependency remains in this test.
- Browser pagination/filter/history results are recorded separately from unit results.
- pnpm verify passes and no production source changed.

## Maintenance

Future automated navigation coverage should mount the actual route with synthetic data. A route recreated inside a test cannot detect production handler regressions. If browser behavior differs, report it separately; this plan does not authorize changing navigation semantics.

