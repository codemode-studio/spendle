# Remove unused strategy screens

Priority P2. Effort S, hours. Risk low. Category tech debt. Depends on none.

## Why

The 879-line `src/features/finance/strategy-progress.tsx` retains screens that no route renders. Its only externally consumed exports are `GoalRing` and the `StrategyDashboard` type. Delete the unused component trees while keeping the two live exports at their existing import path.

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

Modify only `src/features/finance/strategy-progress.tsx`, this plan's status, and `plans/cleanup/001-qa.md` for browser evidence.

At line 62:
```ts
export function StrategyProgressView({
  dashboard,
  today = todayIso(),
  cashCents,
  detailed = false,
```

At line 806:
```ts
export function StrategyHistory({ months = 3 }: { months?: number }) {
  const history = useQuery(strategyHistoryOptions(months))
```

The live consumer `src/features/home/monthly-overview.tsx` imports:
```ts
import { GoalRing } from '#/features/finance/strategy-progress'
import type { StrategyDashboard } from '#/features/finance/strategy-progress'
```

The ring uses `ShieldCheck` and `TrendingUp`, clamps percentage between 0 and 100, and exposes an accessible progress label. Preserve its entire implementation and the dashboard type unchanged.

Do not rename the file, move the exports, change MonthlyOverview, delete domain algorithms/tests, or remove formatting aliases from `src/domain/finance.ts`. MonthlyOverview still imports those aliases. Keep the live strategy-history query and server implementation; MonthlyOverview uses them.

## Steps and checks

1. Run `rg -n 'StrategyProgressView|StrategyHistory|GoalRing|StrategyDashboard' src scripts`. Confirm the two screen exports have no callers, distinguishing `StrategyHistory` from the live `getStrategyHistory` API. Run `pnpm exec vitest run src/features/home/monthly-overview.test.tsx`; expect all tests to pass.
2. Delete `StrategyProgressView`, `StrategyHistory`, `CommitmentOverview`, `CommitmentProgress`, `ConsumptionProgressView`, `BucketRow`, `overallLabel` and the private `todayIso`. Remove imports used only by them. Retain the existing GoalRing and StrategyDashboard definitions verbatim. Run `pnpm typecheck`; expect exit 0.
3. Run the focused test again. Read `.agents/skills/browser-qa/SKILL.md`, start `pnpm qa:start 3100` on an unused port and use the integrated browser at the printed URL. Check the home page at desktop and mobile widths, navigate monthly history, and confirm reserve/investment goal rings render with the same labels and values. No real data or AI calls. Record URL, run directory, actual dimensions, observed values and outcome in `001-qa.md`. Stop the spawned server, then use `pnpm qa:clean <printed-run-directory>`.
4. Run `pnpm verify`; expect exit 0. Run `rg -n 'StrategyProgressView|export function StrategyHistory|function CommitmentOverview|function ConsumptionProgressView|function BucketRow' src`; expect no matches, exit 1.

## Done criteria

- The unused component definitions are absent.
- GoalRing and StrategyDashboard retain their original definitions and import path.
- Focused tests and pnpm verify pass; browser results are recorded accurately.
- Only scoped files changed relative to the initial working tree.

## Maintenance

No new test is needed for deleted, unreachable UI. Do not extend this deletion to domain algorithms just because they become unused; review those separately. Stop if a new screen caller has appeared or the ring requires visual changes.

