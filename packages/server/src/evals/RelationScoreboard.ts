/**
 * Scores what the relation matcher finds in each case of the frozen relation
 * evaluation (`evals/relations`) against the pairs that really happened.
 * Pure: `EvalRelations.ts` runs the matcher, this decides what it is worth.
 *
 * Each case lists every real pair among its entries, so any other pair the
 * matcher proposes is wrong. A pair of the wrong kind is wrong too, and the
 * real one counts as missed.
 */
import { relationKey } from '../reconciliation/Keys.ts'
import type { RelationKind } from '../reconciliation/Keys.ts'
import type { MatchedRelation } from '../reconciliation/Matching.ts'

export interface ExpectedRelation {
  readonly kind: RelationKind
  readonly outflowId: string
  readonly inflowId: string
}

export interface RelationCase {
  readonly id: string
  readonly tags: ReadonlyArray<string>
  /** Every real pair among the case's entries; empty when none is. */
  readonly relations: ReadonlyArray<ExpectedRelation>
}

/**
 * What became of one pair: confirmed automatically or only suggested, right
 * or wrong, or a real pair the matcher never proposed.
 */
export type Verdict =
  | 'auto_right'
  | 'auto_wrong'
  | 'suggested_right'
  | 'suggested_wrong'
  | 'missed'

export interface PairResult {
  readonly caseId: string
  readonly kind: RelationKind
  readonly outflowId: string
  readonly inflowId: string
  readonly verdict: Verdict
  /** The matcher's score and reasons; absent for a missed pair. */
  readonly score?: number
  readonly reasons?: ReadonlyArray<string>
}

/** Ratios from 0 to 1; `null` when nothing was counted. */
export interface RelationScore {
  readonly realPairs: number
  readonly counts: Readonly<Record<Verdict, number>>
  /**
   * Of the pairs confirmed without review, how many are real. A wrong one
   * silently hides a payment or an income, so this should be 1.
   */
  readonly autoPrecision: number | null
  /** Lower end of the 95% Wilson interval of `autoPrecision`. */
  readonly autoPrecisionLow: number | null
  /** Real pairs confirmed without review: the work saved. */
  readonly automation: number | null
  /** Real pairs confirmed or suggested: what the person gets to see. */
  readonly recall: number | null
  /** Of the suggestions, how many are real: a wrong one costs a click. */
  readonly suggestionPrecision: number | null
}

export interface RelationScoreboard {
  readonly overall: RelationScore
  readonly byKind: Readonly<Record<string, RelationScore>>
  readonly byTag: Readonly<Record<string, RelationScore>>
  readonly results: ReadonlyArray<PairResult>
}

const ratio = (part: number, whole: number) => (whole ? part / whole : null)

/** Wilson score interval's lower bound at 95%, sound on a few dozen pairs. */
const wilsonLow = (successes: number, total: number) => {
  if (!total) return null
  const z = 1.96
  const p = successes / total
  const z2n = (z * z) / total
  const centre = p + z2n / 2
  const spread = z * Math.sqrt((p * (1 - p)) / total + z2n / (4 * total))
  return (centre - spread) / (1 + z2n)
}

const score = (results: ReadonlyArray<PairResult>): RelationScore => {
  const counts: Record<Verdict, number> = {
    auto_right: 0,
    auto_wrong: 0,
    suggested_right: 0,
    suggested_wrong: 0,
    missed: 0,
  }
  for (const result of results) counts[result.verdict]++
  const realPairs = counts.auto_right + counts.suggested_right + counts.missed
  const confirmed = counts.auto_right + counts.auto_wrong
  return {
    realPairs,
    counts,
    autoPrecision: ratio(counts.auto_right, confirmed),
    autoPrecisionLow: wilsonLow(counts.auto_right, confirmed),
    automation: ratio(counts.auto_right, realPairs),
    recall: ratio(counts.auto_right + counts.suggested_right, realPairs),
    suggestionPrecision: ratio(
      counts.suggested_right,
      counts.suggested_right + counts.suggested_wrong,
    ),
  }
}

const groupScores = (
  results: ReadonlyArray<PairResult>,
  groupsOf: (result: PairResult) => ReadonlyArray<string>,
  // Groups shown even without a pair, such as a tag only cases without a
  // real pair carry that the matcher rightly left alone.
  known: ReadonlyArray<string> = [],
) => {
  const groups = new Map<string, Array<PairResult>>(
    known.map((group) => [group, []]),
  )
  for (const result of results)
    for (const group of groupsOf(result))
      groups.set(group, [...(groups.get(group) ?? []), result])
  return Object.fromEntries(
    [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([group, list]) => [group, score(list)]),
  )
}

/** Scores the matcher's relations for each case, by the case's id. */
export const relationScoreboard = (
  cases: ReadonlyArray<RelationCase>,
  found: ReadonlyMap<string, ReadonlyArray<MatchedRelation>>,
): RelationScoreboard => {
  const results: Array<PairResult> = []
  for (const item of cases) {
    const real = new Set(
      item.relations.map((relation) =>
        relationKey(relation.kind, relation.outflowId, relation.inflowId),
      ),
    )
    const proposed = new Set<string>()
    for (const relation of found.get(item.id) ?? []) {
      proposed.add(relation.key)
      const right = real.has(relation.key)
      const auto = relation.status === 'confirmed'
      results.push({
        caseId: item.id,
        kind: relation.kind,
        outflowId: relation.outflowId,
        inflowId: relation.inflowId,
        verdict: auto
          ? right
            ? 'auto_right'
            : 'auto_wrong'
          : right
            ? 'suggested_right'
            : 'suggested_wrong',
        score: relation.score,
        reasons: relation.reasons,
      })
    }
    for (const relation of item.relations)
      if (
        !proposed.has(
          relationKey(relation.kind, relation.outflowId, relation.inflowId),
        )
      )
        results.push({ caseId: item.id, ...relation, verdict: 'missed' })
  }
  const tagsOf = new Map(cases.map((item) => [item.id, item.tags]))
  return {
    overall: score(results),
    byKind: groupScores(results, (result) => [result.kind]),
    byTag: groupScores(
      results,
      (result) => tagsOf.get(result.caseId) ?? [],
      cases.flatMap((item) => item.tags),
    ),
    results,
  }
}
