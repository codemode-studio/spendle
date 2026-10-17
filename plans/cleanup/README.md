# Cleanup plans

Written and implemented 2026-09-09 against commit `fef0d59` and the existing dirty working tree. These plans cover audit findings 1–4. Existing unrelated edits were preserved.

| Order | Plan                                                                                | Effort | Risk | Depends on | Status |
| ----- | ----------------------------------------------------------------------------------- | ------ | ---- | ---------- | ------ |
| 1     | [Remove unused strategy screens](001-remove-unused-strategy-ui.md)                  | S      | Low  | None       | DONE   |
| 2     | [Remove the cloned navigation test](002-remove-cloned-navigation-test.md)           | S      | Low  | None       | DONE   |
| 3     | [Remove obsolete canonical assignment](003-remove-obsolete-canonical-assignment.md) | S      | Low  | None       | DONE   |
| 4     | [Remove test-only adapters](004-remove-test-only-adapters.md)                       | S      | Low  | 003        | DONE   |

Execute in order. Plan 004 follows 003 because both edit canonicalization.ts. Each plan contains its own context, scope and verification commands. Preserve pre-existing edits and keep verification results separate from the static audit.

## Verification

- `pnpm setup:check`: passed.
- Focused baseline: 238 tests passed. After cleanup: 233 passed. Two obsolete canonical-assignment tests and the cloned navigation test were removed; duplicate validation scenarios were consolidated while moving coverage to the production state API.
- `pnpm verify`: passed typecheck, lint, tests and production build. Tests: 487 passed, 10 skipped across two files.
- Skipped checks: optional private-statement and real-PDF fixture tests, including their live-AI path, were not enabled. Synthetic tests passed.
- Browser interactions passed at 1280×800 and 390×844. See [home checks](001-qa.md) and [transaction checks](002-qa.md). Screenshot capture failed in the browser tool, so visual screenshot review remains unverified.
- Seven source/test files changed, removing 938 net lines. GoalRing and StrategyDashboard were compared against the saved working-tree baseline and are unchanged. No financial production function body changed except deletion of APIs with no runtime callers.

## Deferred findings

Prompt-substring assertions, local-only feedback buttons and smaller dead exports are not included in this batch.

## Considered and rejected

- Server validators and query-key factories are functional boundaries, not redundant wrappers.
- Cache invalidation tests exercise real QueryClient behavior.
- Small integration entrypoints call fixtures with substantial database assertions.
- Formatting aliases in finance.ts still have a live MonthlyOverview consumer; do not remove them with the obsolete strategy screens.
