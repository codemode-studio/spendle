import type { FollowedCategoryDecisions } from './FollowDecisions.ts'
import { knowledgeExactPatterns, knowledgeKey } from './Patterns.ts'
import type { Direction } from './Patterns.ts'
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
  providerBuiltIn: 60,
} as const

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

export interface PolicyInput {
  readonly entries: ReadonlyArray<PolicyEntry>
  readonly decisions: FollowedCategoryDecisions
  readonly store: ReadonlyArray<PatternRow>
  readonly categories: ReadonlyArray<PolicyCategory>
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
 * 1. The person's decision, applied.
 * 2. A decision about an entry that has since split: each part to review.
 * 3. The merchant's exact pattern, applied; to review when alternative
 *    patterns disagree or the pattern is corrected more than confirmed.
 * 4. The longest prefix covering the merchant, applied.
 * 5. The person's mapping of the provider category, applied; otherwise a
 *    built-in mapping, to review.
 * 6. Nothing.
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
          excludedFromSpending: false,
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

  const learned = (entry: PolicyEntry): ReadonlyArray<Proposal> => {
    const key = knowledgeKey(entry)
    if (key === null) return []
    const proposals: Array<Proposal> = []
    const hits = knowledgeExactPatterns(entry.description).flatMap(
      (pattern) => {
        const row = exact.get(`${pattern}|${key.direction}`)
        return row ? [row] : []
      },
    )
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

  const provided = (entry: PolicyEntry): ReadonlyArray<Proposal> => {
    if (entry.amountCents === 0) return []
    const direction: Direction = entry.amountCents < 0 ? 'expense' : 'income'
    const mapped: Array<Proposal> = []
    const builtIn: Array<Proposal> = []
    for (const reported of entry.providerCategories) {
      for (const value of [reported.id, reported.name]) {
        if (value === null) continue
        const row = providers.get(providerPattern(pluggyProvider, value))
        if (row && fits(row.categoryId, direction))
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
      const categoryId =
        reported.name === null
          ? undefined
          : builtInProviderCategories.get(reported.name)
      if (categoryId && usable(categoryId) && fits(categoryId, direction))
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
    const seen = new Set<string>()
    return [...mapped, ...builtIn].filter((proposal) => {
      const key = `${proposal.originRef}|${proposal.categoryId}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  return input.entries.map((entry) =>
    infer(entry.id, [...decided(entry), ...learned(entry), ...provided(entry)]),
  )
}
