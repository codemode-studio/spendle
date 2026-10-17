# Remove obsolete canonical-assignment code

Priority P2. Effort S, hours. Risk low. Category tech debt. Depends on none; execute before plan 004 because both edit canonicalization.ts.

## Why

Two exported financial-assignment functions survive only because two tests call them. The actual import commit uses `buildCanonicalCommitPlan`, `resolveImportOutcome` and `applyImportOutcome`. Delete the unused implementation without changing current reconciliation behavior.

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

Modify only `src/domain/canonicalization.ts`, `src/domain/canonicalization.test.ts` and this plan's status.

At line 493:

```ts
export function resolveCanonicalAssignments<
  TObservation extends CanonicalIdentity & { id: string },
  TTransaction extends CanonicalIdentity & { id: string },
>(input: {
  observations: TObservation[]
  transactions: TTransaction[]
  duplicateReasons: DuplicateReason[]
  preassigned?: ReadonlyMap<string, string>
})
```

The body constructs assignments from bank IDs and fingerprint overlaps.

At line 546:

```ts
export function canonicalEvidenceKind(input: {
  controlled: boolean
  duplicateReason: DuplicateReason
})
```

The first describe block in `canonicalization.test.ts`, named `canonical transaction assignments`, contains their only two tests. Later blocks test live identity and matching functions and must remain.

The real commit module imports:

```ts
import {
  applyImportOutcome,
  recoverBatchEvidence,
  resolveImportOutcome,
} from './canonical-outcome.server'
import { buildCanonicalCommitPlan } from './import-commit-plan.server'
```

Do not delete `CanonicalIdentity`, `DuplicateReason`, live matching functions, current commit code, evidence records or database migrations. Preserve all tests outside the obsolete first describe block.

## Steps and checks

1. Run `rg -n 'resolveCanonicalAssignments|canonicalEvidenceKind' src scripts`; expect only the two definitions and imports/calls in canonicalization.test.ts. Run `pnpm exec vitest run src/domain/canonicalization.test.ts src/domain/canonical-outcome.test.ts src/features/finance/import-correction.integration.test.ts src/features/finance/card-statement-control.integration.test.ts`; expect passing tests or explicitly recorded private-fixture skips.
2. Delete both function definitions, their test imports and the `canonical transaction assignments` describe block. Do not replace the obsolete algorithms with wrappers around current code. Run `pnpm typecheck`; expect exit 0.
3. Repeat the focused command. It should pass with exactly the two obsolete tests removed and all other assertions retained.
4. Run `pnpm verify`; expect exit 0. Run `rg -n 'resolveCanonicalAssignments|canonicalEvidenceKind' src scripts`; expect no matches, exit 1.

## Done criteria

- Both obsolete APIs and exactly their two tests are absent.
- Current identity/matching and import integration tests pass.
- pnpm verify passes; no production caller or financial behavior changed.
- Diff is confined to the scoped files.

## Maintenance

No new tests are required for unreachable code deletion. Preserve zero-difference gating, original facts and statement evidence by leaving the active commit path alone. If caller searches find a production consumer, stop and revise the premise rather than changing that consumer.
