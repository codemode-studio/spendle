# Test production APIs and remove test-only adapters

Priority P2. Effort S, hours. Risk low if existing scenarios are preserved. Category tests and tech debt. Depends on plan 003 to serialize edits to canonicalization.ts.

## Why

Three exported adapters have no production callers. Tests currently target private-helper adapters instead of the state and matching APIs used by the application. Move those scenarios first, then remove the unnecessary exports.

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

Modify only:

- `src/domain/import-audit.ts`
- `src/domain/import-audit.test.ts`
- `src/domain/canonicalization.ts`
- `src/features/finance/import.test.ts`
- This plan's status.

At import-audit.ts:281:

```ts
export function effectiveValidationReason(
  row: ImportValidationReasonRow & { hasDestinationConflict?: boolean },
): ImportAuditReasonCode | null {
  return effectivePersistedValidationReason(
    row,
    row.hasDestinationConflict ?? false,
  )
}
```

At line 360:

```ts
export function resolveImportReviewReason(input: {
  stored: ImportAuditReasonCode | null
  derived: ImportAuditReasonCode
}): ImportAuditReasonCode {
  return preferImportReviewReason(input.stored, input.derived)
}
```

The live API is `getEffectiveImportValidationState(row, live)`. It calls both private helpers directly and returns status, reason, message, committable and remediation flags. Keep the private helpers and all production state logic unchanged.

At canonicalization.ts:390:

```ts
export function assignStatementValueMatches<
  TObservation extends StatementValue,
  TTransaction extends StatementValue,
>(observations: TObservation[], transactions: TTransaction[]) {
  const result = matchStatementValueSubset(observations, transactions)
  return result && !result.unmatched.length ? result.matches : null
}
```

The live matcher returns null when existing transactions remain unused; otherwise it returns `{ matches, unmatched }`. An unmatched observation does not always mean null. Tests must assert the actual result contract, not rebuild the deleted adapter locally.

Do not change helper bodies, import validators, review precedence, database behavior, sameStatementValues or query invalidation. No new generic fixtures or wrappers.

## Steps and checks

1. Run `rg -n 'effectiveValidationReason|resolveImportReviewReason|assignStatementValueMatches' src scripts`; confirm only definitions and the scoped tests use them. Run `pnpm exec vitest run src/domain/import-audit.test.ts src/features/finance/import.test.ts src/features/finance/import-validation-reasons.integration.test.ts src/features/finance/import-live-conflicts.integration.test.ts`; expect all to pass.
2. Rewrite the effective-reason table to call `getEffectiveImportValidationState`. Move any fixture's `hasDestinationConflict` into the second, live-facts argument. Preserve each meaningful scenario. The full state derives a final reason, so do not blindly compare private intermediate null values with final reasons.
3. Replace the stored/derived precedence table with concrete state fixtures. Cover persisted blocked/identical-file/destination-conflict reasons resisting apparent readiness; live destination conflicts overriding stored ready; and stale remediable reasons yielding to current facts. Use reconciled status to derive ready, imported account state with no closing balance to derive needs_balance, and divergent state plus `hasStatementMatchCandidates: true` to derive statement_match_candidates. For hard blockers assert committable false and all remediation flags false. Retain existing `nextValidationState` hard-blocker tests. Do not change production semantics to fit a fixture. Run `pnpm exec vitest run src/domain/import-audit.test.ts`; expect all scenarios to pass.
4. Replace calls to `assignStatementValueMatches` in import.test.ts with `matchStatementValueSubset`. For the definitive-PDF/prior-CSV case assert the exact pair in matches and an empty unmatched list. Preserve rejection of conflicting E1/E2 bank IDs and acceptance of an unidentified observation against the known transaction. Assert exact matched/unmatched state for accepted cases, rather than only not-null. Run `pnpm exec vitest run src/features/finance/import.test.ts`; expect all tests to pass.
5. Delete the three adapters and their obsolete test imports. Run `pnpm typecheck` and repeat the full focused command; expect exit 0 and passing tests.
6. Run `pnpm verify`; expect exit 0. Run `rg -n 'effectiveValidationReason|resolveImportReviewReason|assignStatementValueMatches' src scripts`; expect no matches, exit 1.

## Done criteria

- The three test-only APIs have no remaining definitions or callers.
- Every meaningful original scenario targets the production state/matcher API.
- Hard blocker tests assert non-committability and unavailable remediation.
- Private helper and production API bodies remain unchanged.
- Focused tests and pnpm verify pass; diff stays in scope.

## Maintenance and stop conditions

Stop if any scenario requires changing the production calculation, or cannot be represented by legitimate row/live facts. Report the mismatch with the original case rather than casting around types or restoring an adapter. No browser mutation is needed when only unused exports and tests change; if production import flow changes, it is outside this plan and requires separate scope and browser QA.
