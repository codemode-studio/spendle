import { followCategoryDecisions } from '../categories/FollowDecisions.ts'
import { categorize } from '../categories/Policy.ts'
import type { PolicyCategory } from '../categories/Policy.ts'
import { learn } from '../categories/Store.ts'
import type { PatternRow } from '../categories/Store.ts'
import type { EvalItem, Outcomes } from './Scoreboard.ts'

/**
 * What the deterministic V2 policy does with the exam: the store learns the
 * context split as if the person had decided each item in review, then
 * every exam item is categorized by patterns, prefixes and the provider
 * map, with no model. The dataset carries no provider categories, so this
 * measures what the store's patterns alone resolve.
 */
export const policyOutcomes = (
  context: ReadonlyArray<EvalItem>,
  exam: ReadonlyArray<EvalItem>,
  categories: ReadonlyArray<PolicyCategory>,
): Outcomes => {
  let store: ReadonlyArray<PatternRow> = []
  context.forEach((item, index) => {
    if (item.expectedCategoryId === null) return
    const learned = learn(
      store,
      {
        description: item.description,
        amountCents: item.amountCents,
        categoryId: item.expectedCategoryId,
        source: 'review',
      },
      { now: '2026-01-01T00:00:00.000Z', newId: `eval-${index}` },
    )
    if (learned) store = learned.rows
  })
  const inferences = categorize({
    entries: exam.map((item) => ({
      id: item.id,
      amountCents: item.amountCents,
      description: item.description,
      providerCategories: [],
    })),
    relations: [],
    decisions: followCategoryDecisions([], new Set()),
    store,
    categories,
  })
  return new Map(
    inferences.map((inference) => [
      inference.entryId,
      {
        categoryId: inference.categoryId,
        applied: inference.status === 'applied',
      },
    ]),
  )
}
