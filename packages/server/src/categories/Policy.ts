import type { FollowedCategoryDecisions } from './FollowDecisions.ts'
import { knowledgeExactPatterns, knowledgeKey } from './Patterns.ts'
import type { Direction, KnowledgeKey } from './Patterns.ts'
import {
  builtInProviderCategories,
  pluggyProvider,
} from './ProviderCategories.ts'
import { coveringPrefix, providerPattern } from './Store.ts'
import type { PatternRow } from './Store.ts'

/**
 * Bump on any change to what `categorize` returns for the same input: the
 * categorizer then rebuilds every inference when the server starts.
 */
export const POLICY_VERSION = 1

/** How sure each origin is, 0 to 100. */
export const confidence = {
  decision: 100,
  exactPattern: 98,
  prefix: 92,
  providerMapping: 90,
  /** A decision about a whole entry that has since split, for each part. */
  splitDecision: 70,
  /** A confirmed transfer or card payment. */
  reconciliation: 100,
  providerBuiltIn: 60,
} as const

/**
 * The default probability from which a model answer is applied: infinite,
 * so every answer goes to review. `TYPESAFE_APPLY_THRESHOLD` raises it for
 * one model version once `eval:categories` shows its confident answers are
 * right often enough (see `evals/categories/README.md`).
 */
export const MODEL_APPLY_THRESHOLD = Number.POSITIVE_INFINITY
/** Model answers below this probability are dropped. */
export const MODEL_SUGGEST_FLOOR = 0.5

/** Income categories for money received, the rest for money spent. */
export const fitsDirection = (
  bucket: string | undefined,
  direction: Direction,
) => (bucket === 'income') === (direction === 'income')

export type InferenceOrigin =
  | 'decision'
  | 'reconciliation'
  | 'refund'
  | 'pattern'
  | 'prefix'
  | 'provider'
  | 'model'
  | 'none'

export type InferenceStatus = 'applied' | 'review' | 'none'

/** What one rule says about an entry. */
export interface Proposal {
  readonly categoryId: string
  readonly origin: Exclude<InferenceOrigin, 'none'>
  /** The decision key, pattern id, relation key or provider category behind it. */
  readonly originRef: string | null
  readonly confidence: number
  readonly status: 'applied' | 'review'
  readonly excludedFromSpending: boolean
  readonly reasons: ReadonlyArray<string>
}

export interface Inference {
  readonly entryId: string
  readonly categoryId: string | null
  readonly origin: InferenceOrigin
  readonly originRef: string | null
  readonly confidence: number
  readonly status: InferenceStatus
  readonly excludedFromSpending: boolean
  readonly reasons: ReadonlyArray<string>
  /** What the rules that lost said, in rule order. */
  readonly candidates: ReadonlyArray<Proposal>
}

export interface PolicyEntry {
  readonly id: string
  readonly amountCents: number
  readonly description: string
  /** The provider category each current observation reports. */
  readonly providerCategories: ReadonlyArray<{
    readonly id: string | null
    readonly name: string | null
  }>
}

export interface PolicyCategory {
  readonly id: string
  readonly bucket: string
  readonly active: boolean
  readonly system: boolean
}

/** A reconciliation relation between two entries. */
export interface PolicyRelation {
  readonly key: string
  readonly kind: 'internal_transfer' | 'card_payment' | 'refund'
  readonly outflowEntryId: string
  readonly inflowEntryId: string
  readonly status: 'suggested' | 'confirmed' | 'conflict'
  readonly score: number
}

/** Cached model answers by `pattern|direction`, under one model version. */
export interface PolicyModel {
  readonly version: string
  readonly answers: ReadonlyMap<
    string,
    { readonly categoryId: string | null; readonly probability: number }
  >
  readonly applyThreshold: number
  readonly suggestFloor: number
}

export interface PolicyInput {
  readonly entries: ReadonlyArray<PolicyEntry>
  readonly relations: ReadonlyArray<PolicyRelation>
  readonly decisions: FollowedCategoryDecisions
  readonly store: ReadonlyArray<PatternRow>
  readonly categories: ReadonlyArray<PolicyCategory>
  /** Absent when the model is disabled. */
  readonly model?: PolicyModel | undefined
}

const none = (
  entryId: string,
  candidates: ReadonlyArray<Proposal>,
): Inference => ({
  entryId,
  categoryId: null,
  origin: 'none',
  originRef: null,
  confidence: 0,
  status: 'none',
  excludedFromSpending: false,
  reasons: [],
  candidates,
})

const infer = (
  entryId: string,
  proposals: ReadonlyArray<Proposal>,
): Inference => {
  const [winner, ...candidates] = proposals
  return winner ? { entryId, ...winner, candidates } : none(entryId, [])
}

/**
 * The category of every entry, from facts, the person's decisions and the
 * store; the first rule that applies wins:
 *
 * 1. A confirmed transfer or card payment: reconciliation's system
 *    category on both sides, applied and out of spending. A person's
 *    decision on such an entry stays stored, shadowed.
 * 2. The person's decision, applied; out of spending when it marks a bill
 *    payment reconciliation found no other side of.
 * 3. A decision about an entry that has since split: each part to review.
 * 4. A confirmed refund: the credit takes its purchase's category and
 *    status, so it lowers that category's spending. Nothing is learned.
 *    While the purchase has none, neither has the credit: no lower rule
 *    applies to it.
 * 5. A suggested (or conflicting) transfer or card payment: the system
 *    category, to review, never applied.
 * 6. The merchant's exact pattern, applied; to review when alternative
 *    patterns disagree or the pattern is corrected more than confirmed.
 * 7. The longest prefix covering the merchant, applied.
 * 8. The person's mapping of the provider category, applied; otherwise a
 *    built-in mapping, to review. Observations of the entry whose provider
 *    categories map to different categories send it to review.
 * 9. The model's cached answer: applied from `applyThreshold`, to review
 *    from `suggestFloor`, dropped below. Never written to the store.
 * 10. Nothing.
 *
 * Instalments match through `knowledgePattern`, which drops their suffix.
 */
export const categorize = (input: PolicyInput): ReadonlyArray<Inference> => {
  const categories = new Map(
    input.categories.map((category) => [category.id, category]),
  )
  // Patterns, prefixes and provider categories may only point to categories
  // the person can choose now.
  const usable = (categoryId: string) => {
    const category = categories.get(categoryId)
    return (
      category !== undefined &&
      category.active &&
      !category.system &&
      category.id !== 'uncategorized'
    )
  }
  // A provider category carries no direction: only one that fits the
  // movement's is offered.
  const fits = (categoryId: string, direction: Direction) =>
    (categories.get(categoryId)?.bucket === 'income') ===
    (direction === 'income')

  const store = input.store.filter((row) => usable(row.categoryId))
  const exact = new Map(
    store
      .filter((row) => row.kind === 'merchant' && row.matchMode === 'exact')
      .map((row) => [`${row.pattern}|${row.direction}`, row]),
  )
  const providers = new Map(
    store
      .filter((row) => row.kind === 'provider_category')
      .map((row) => [row.pattern, row]),
  )

  const systemCategory = {
    internal_transfer: 'transfer',
    card_payment: 'card_payment',
  } as const
  const relationsOf = new Map<string, Array<PolicyRelation>>()
  for (const relation of input.relations) {
    for (const entryId of [relation.outflowEntryId, relation.inflowEntryId]) {
      const list = relationsOf.get(entryId) ?? []
      list.push(relation)
      relationsOf.set(entryId, list)
    }
  }

  const reconciled = (
    entry: PolicyEntry,
    confirmed: boolean,
  ): ReadonlyArray<Proposal> =>
    (relationsOf.get(entry.id) ?? []).flatMap(
      (relation): ReadonlyArray<Proposal> => {
        if (relation.kind === 'refund') return []
        if ((relation.status === 'confirmed') !== confirmed) return []
        return [
          {
            categoryId: systemCategory[relation.kind],
            origin: 'reconciliation',
            originRef: relation.key,
            confidence: confirmed ? confidence.reconciliation : relation.score,
            status: confirmed ? 'applied' : 'review',
            excludedFromSpending: confirmed,
            reasons: [
              relation.kind,
              relation.status,
              ...(confirmed && input.decisions.byEntry.has(entry.id)
                ? ['decision_shadowed']
                : []),
            ],
          },
        ]
      },
    )

  // The refund's credit follows its purchase, whose own inference is
  // computed first (a purchase is an outflow, never a refund's credit).
  // While the purchase has no category the credit has none either: an
  // income category from a lower rule would count the refund as earnings.
  // A credit refunding purchases of different categories goes to review.
  const refunded = (
    entry: PolicyEntry,
  ):
    | { readonly key: string; readonly proposals: ReadonlyArray<Proposal> }
    | undefined => {
    const relations = (relationsOf.get(entry.id) ?? []).filter(
      (relation) =>
        relation.kind === 'refund' &&
        relation.status === 'confirmed' &&
        relation.inflowEntryId === entry.id,
    )
    const [first] = relations
    if (first === undefined) return undefined
    const purchases = relations.map((relation) => ({
      relation,
      purchase: inferenceOf(relation.outflowEntryId),
    }))
    const agree =
      new Set(purchases.map(({ purchase }) => purchase?.categoryId ?? null))
        .size === 1
    return {
      key: first.key,
      proposals: purchases.flatMap(
        ({ relation, purchase }): ReadonlyArray<Proposal> =>
          purchase === undefined || purchase.categoryId === null
            ? []
            : [
                {
                  categoryId: purchase.categoryId,
                  origin: 'refund',
                  originRef: relation.key,
                  confidence: purchase.confidence,
                  status:
                    agree && purchase.status === 'applied'
                      ? 'applied'
                      : 'review',
                  excludedFromSpending: purchase.excludedFromSpending,
                  reasons: [
                    'refund',
                    `purchase_${purchase.origin}`,
                    ...(agree ? [] : ['conflicting_purchases']),
                  ],
                },
              ],
      ),
    }
  }

  const decided = (entry: PolicyEntry): ReadonlyArray<Proposal> => {
    const decision = input.decisions.byEntry.get(entry.id)
    const proposals: Array<Proposal> = []
    if (decision) {
      proposals.push(
        {
          categoryId: decision.categoryId,
          origin: 'decision',
          originRef: decision.key,
          confidence: confidence.decision,
          status: 'applied',
          excludedFromSpending:
            categories.get(decision.categoryId)?.system ?? false,
          reasons: ['decision'],
        },
        ...decision.superseded.map((older): Proposal => ({
          categoryId: older.categoryId,
          origin: 'decision',
          originRef: older.key,
          confidence: confidence.decision,
          status: 'review',
          excludedFromSpending: false,
          reasons: ['superseded_decision'],
        })),
      )
    }
    for (const whole of input.decisions.split.get(entry.id) ?? []) {
      proposals.push({
        categoryId: whole.categoryId,
        origin: 'decision',
        originRef: whole.key,
        confidence: confidence.splitDecision,
        status: 'review',
        excludedFromSpending: false,
        reasons: ['decision_split'],
      })
    }
    return proposals
  }

  // Descriptions repeat across a history (every ride, every month of a
  // subscription), so each is read once. A key depends on the description
  // and the amount's sign alone.
  const keys = new Map<string, KnowledgeKey | null>()
  const keyOf = (entry: PolicyEntry) => {
    const id = `${Math.sign(entry.amountCents)}|${entry.description}`
    let key = keys.get(id)
    if (key === undefined) {
      key = knowledgeKey(entry)
      keys.set(id, key)
    }
    return key
  }
  const exactPatterns = new Map<string, ReadonlyArray<string>>()
  const exactPatternsOf = (description: string) => {
    let patterns = exactPatterns.get(description)
    if (patterns === undefined) {
      patterns = knowledgeExactPatterns(description)
      exactPatterns.set(description, patterns)
    }
    return patterns
  }

  const learned = (entry: PolicyEntry): ReadonlyArray<Proposal> => {
    const key = keyOf(entry)
    if (key === null) return []
    const proposals: Array<Proposal> = []
    const hits = exactPatternsOf(entry.description).flatMap((pattern) => {
      const row = exact.get(`${pattern}|${key.direction}`)
      return row ? [row] : []
    })
    const [first] = hits
    if (first) {
      const disagree = hits.some((hit) => hit.categoryId !== first.categoryId)
      const corrected = first.corrections > first.confirmations
      for (const hit of hits) {
        if (hit !== first && hit.categoryId === first.categoryId) continue
        proposals.push({
          categoryId: hit.categoryId,
          origin: 'pattern',
          originRef: hit.id,
          confidence: confidence.exactPattern,
          status:
            hit === first && !disagree && !corrected ? 'applied' : 'review',
          excludedFromSpending: false,
          reasons: [
            'exact_pattern',
            ...(disagree ? ['conflicting_patterns'] : []),
            ...(hit === first && corrected ? ['often_corrected'] : []),
          ],
        })
      }
    }
    const prefix = coveringPrefix(store, key.pattern, key.direction)
    if (prefix) {
      proposals.push({
        categoryId: prefix.categoryId,
        origin: 'prefix',
        originRef: prefix.id,
        confidence: confidence.prefix,
        status: 'applied',
        excludedFromSpending: false,
        reasons: ['prefix'],
      })
    }
    return proposals
  }

  // Each observation's category: the person's mapping of its id, then of
  // its name, then the built-in map. Observations of one entry (a
  // historical and a replacement connection) that land on different
  // categories send it to review: none of them is applied.
  const provided = (entry: PolicyEntry): ReadonlyArray<Proposal> => {
    if (entry.amountCents === 0) return []
    const direction: Direction = entry.amountCents < 0 ? 'expense' : 'income'
    const mapped: Array<Proposal> = []
    const builtIn: Array<Proposal> = []
    const chosen = new Set<string>()
    for (const reported of entry.providerCategories) {
      let first: string | undefined
      for (const value of [reported.id, reported.name]) {
        if (value === null) continue
        const row = providers.get(providerPattern(pluggyProvider, value))
        if (row && fits(row.categoryId, direction)) {
          first ??= row.categoryId
          mapped.push({
            categoryId: row.categoryId,
            origin: 'provider',
            originRef: row.id,
            confidence: confidence.providerMapping,
            status: 'applied',
            excludedFromSpending: false,
            reasons: ['provider_mapping'],
          })
        }
      }
      const categoryId =
        reported.name === null
          ? undefined
          : builtInProviderCategories.get(reported.name)
      if (categoryId && usable(categoryId) && fits(categoryId, direction)) {
        first ??= categoryId
        builtIn.push({
          categoryId,
          origin: 'provider',
          originRef: providerPattern(pluggyProvider, reported.name!),
          confidence: confidence.providerBuiltIn,
          status: 'review',
          excludedFromSpending: false,
          reasons: ['provider_category'],
        })
      }
      if (first !== undefined) chosen.add(first)
    }
    const conflicting = chosen.size > 1
    const seen = new Set<string>()
    return [...mapped, ...builtIn].flatMap(
      (proposal): ReadonlyArray<Proposal> => {
        const key = `${proposal.originRef}|${proposal.categoryId}`
        if (seen.has(key)) return []
        seen.add(key)
        return [
          conflicting
            ? {
                ...proposal,
                status: 'review',
                reasons: [
                  ...proposal.reasons,
                  'conflicting_provider_categories',
                ],
              }
            : proposal,
        ]
      },
    )
  }

  const modelled = (entry: PolicyEntry): ReadonlyArray<Proposal> => {
    const model = input.model
    const key = keyOf(entry)
    if (model === undefined || key === null) return []
    const answer = model.answers.get(`${key.pattern}|${key.direction}`)
    if (
      answer === undefined ||
      answer.categoryId === null ||
      answer.probability < model.suggestFloor ||
      !usable(answer.categoryId) ||
      !fits(answer.categoryId, key.direction)
    )
      return []
    return [
      {
        categoryId: answer.categoryId,
        origin: 'model',
        originRef: model.version,
        confidence: Math.round(answer.probability * 100),
        status:
          answer.probability >= model.applyThreshold ? 'applied' : 'review',
        excludedFromSpending: false,
        reasons: ['model'],
      },
    ]
  }

  const entries = new Map(input.entries.map((entry) => [entry.id, entry]))
  const done = new Map<string, Inference>()
  const visiting = new Set<string>()
  function inferenceOf(entryId: string): Inference | undefined {
    const found = done.get(entryId)
    if (found) return found
    const entry = entries.get(entryId)
    // A cycle cannot happen (see `refunded`); guard rather than loop.
    if (entry === undefined || visiting.has(entryId)) return undefined
    visiting.add(entryId)
    const first = [...reconciled(entry, true), ...decided(entry)]
    const refund = refunded(entry)
    const rest = [
      ...reconciled(entry, false),
      ...learned(entry),
      ...provided(entry),
      ...modelled(entry),
    ]
    const inference =
      first.length === 0 &&
      refund !== undefined &&
      refund.proposals.length === 0
        ? {
            ...none(entry.id, rest),
            origin: 'refund' as const,
            originRef: refund.key,
            reasons: ['refund', 'purchase_uncategorized'],
          }
        : infer(entry.id, [...first, ...(refund?.proposals ?? []), ...rest])
    visiting.delete(entryId)
    done.set(entryId, inference)
    return inference
  }
  return input.entries.map((entry) => inferenceOf(entry.id)!)
}
