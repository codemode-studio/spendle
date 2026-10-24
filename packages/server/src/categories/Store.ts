import {
  isValidKnowledgePattern,
  knowledgeAggregators,
  knowledgeKey,
  knowledgePrefixCandidate,
  matchesKnowledgePrefix,
  normalizeKnowledgePattern,
} from './Patterns.ts'
import type { Direction, MatchMode } from './Patterns.ts'

export type PatternKind = 'merchant' | 'provider_category'
export type PatternSource =
  | 'transaction_list'
  | 'review'
  | 'v1_import'
  | 'store_edit'
  | 'provider_mapping'

/** One row of the category store, as the person sees and edits it. */
export interface PatternRow {
  readonly id: string
  readonly kind: PatternKind
  readonly pattern: string
  readonly matchMode: MatchMode
  /** Provider mappings apply to both directions. */
  readonly direction: Direction | 'any'
  readonly categoryId: string
  readonly signature: string
  readonly sampleDescription: string
  readonly source: PatternSource
  readonly confirmations: number
  readonly corrections: number
  readonly lastLearnedAt: string
}

/** A person's edit of the store. */
export type StoreEdit =
  | {
      readonly _tag: 'Recategorize'
      readonly id: string
      readonly categoryId: string
    }
  | {
      readonly _tag: 'EditPattern'
      readonly id: string
      readonly pattern: string
      readonly matchMode: MatchMode
    }
  | {
      readonly _tag: 'AddPattern'
      readonly pattern: string
      readonly matchMode: MatchMode
      readonly direction: Direction
      readonly categoryId: string
    }
  | { readonly _tag: 'Remove'; readonly id: string }
  | { readonly _tag: 'PromoteToPrefix'; readonly id: string }
  | {
      readonly _tag: 'SetProviderMapping'
      readonly provider: string
      readonly providerCategory: string
      readonly categoryId: string
    }

export type StoreEditFailure =
  | 'pattern_not_found'
  | 'not_a_merchant_pattern'
  | 'invalid_pattern'
  | 'pattern_taken'
  | 'no_prefix_candidate'

export type StoreEditResult =
  | {
      readonly ok: true
      readonly rows: ReadonlyArray<PatternRow>
      /** The row the edit is about. */
      readonly patternId: string
    }
  | { readonly ok: false; readonly reason: StoreEditFailure }

/** What a write needs from outside: the time, and an id should it add a row. */
export interface StoreClock {
  readonly now: string
  readonly newId: string
}

/**
 * A provider mapping's id, from its unique key: previewing a new mapping
 * names the row exactly as committing it does.
 */
export const providerMappingId = (pattern: string) =>
  `provider_category:${pattern}:any`

/** The key a provider mapping is stored under: `pluggy:<category id or name>`. */
export const providerPattern = (provider: string, providerCategory: string) =>
  `${provider}:${providerCategory.trim()}`

const sameKey = (
  row: PatternRow,
  kind: PatternKind,
  pattern: string,
  matchMode: MatchMode,
  direction: PatternRow['direction'],
) =>
  row.kind === kind &&
  row.pattern === pattern &&
  row.matchMode === matchMode &&
  row.direction === direction

/** A decision about the same row: reaffirming counts, changing resets and counts a correction. */
const reaffirm = (
  row: PatternRow,
  categoryId: string,
  fields: Partial<PatternRow>,
): PatternRow =>
  row.categoryId === categoryId
    ? { ...row, ...fields, confirmations: row.confirmations + 1 }
    : {
        ...row,
        ...fields,
        categoryId,
        confirmations: 1,
        corrections: row.corrections + 1,
      }

/** The longest merchant prefix in the direction that covers the pattern. */
export const coveringPrefix = (
  rows: ReadonlyArray<PatternRow>,
  pattern: string,
  direction: Direction,
) =>
  rows
    .filter(
      (row) =>
        row.kind === 'merchant' &&
        row.matchMode === 'prefix' &&
        row.direction === direction &&
        matchesKnowledgePrefix(pattern, row.pattern),
    )
    .sort((a, b) => b.pattern.length - a.pattern.length)
    .at(0)

// Exact rows of the prefix's category it covers are redundant: they add
// their confirmations to the prefix and go.
const absorbCovered = (
  rows: ReadonlyArray<PatternRow>,
  prefix: PatternRow,
): ReadonlyArray<PatternRow> => {
  const covered = rows.filter(
    (row) =>
      row.id !== prefix.id &&
      row.kind === 'merchant' &&
      row.matchMode === 'exact' &&
      row.direction === prefix.direction &&
      row.categoryId === prefix.categoryId &&
      matchesKnowledgePrefix(row.pattern, prefix.pattern),
  )
  if (covered.length === 0) return rows
  const gone = new Set(covered.map((row) => row.id))
  const extra = covered.reduce((total, row) => total + row.confirmations, 0)
  return rows.flatMap((row) =>
    gone.has(row.id)
      ? []
      : row.id === prefix.id
        ? [{ ...row, confirmations: row.confirmations + extra }]
        : [row],
  )
}

/**
 * What a person's category for a movement teaches, ported from V1
 * `learnCategory`: the merchant's exact pattern gains a confirmation, or
 * changes category with a correction; a prefix of the same category that
 * already covers it is reaffirmed instead and the exact exception dropped.
 * Returns `null` when there is nothing to learn. Callers keep system
 * categories and `uncategorized` out.
 */
export const learn = (
  rows: ReadonlyArray<PatternRow>,
  input: {
    readonly description: string
    readonly amountCents: number
    readonly categoryId: string
    readonly source: PatternSource
  },
  clock: StoreClock,
): {
  readonly rows: ReadonlyArray<PatternRow>
  readonly patternId: string
} | null => {
  const key = knowledgeKey(input)
  if (key === null) return null
  const prefix = coveringPrefix(rows, key.pattern, key.direction)
  if (prefix && prefix.categoryId === input.categoryId) {
    return {
      patternId: prefix.id,
      rows: rows.flatMap((row) =>
        row.id === prefix.id
          ? [
              {
                ...row,
                confirmations: row.confirmations + 1,
                lastLearnedAt: clock.now,
              },
            ]
          : sameKey(row, 'merchant', key.pattern, 'exact', key.direction)
            ? []
            : [row],
      ),
    }
  }
  const fields = {
    signature: key.signature,
    sampleDescription: input.description,
    source: input.source,
    lastLearnedAt: clock.now,
  }
  const existing = rows.find((row) =>
    sameKey(row, 'merchant', key.pattern, 'exact', key.direction),
  )
  if (existing) {
    return {
      patternId: existing.id,
      rows: rows.map((row) =>
        row.id === existing.id ? reaffirm(row, input.categoryId, fields) : row,
      ),
    }
  }
  return {
    patternId: clock.newId,
    rows: [
      ...rows,
      {
        id: clock.newId,
        kind: 'merchant',
        pattern: key.pattern,
        matchMode: 'exact',
        direction: key.direction,
        categoryId: input.categoryId,
        confirmations: 1,
        corrections: 0,
        ...fields,
      },
    ],
  }
}

const merchantRow = (rows: ReadonlyArray<PatternRow>, id: string) => {
  const row = rows.find((found) => found.id === id)
  if (!row) return 'pattern_not_found' as const
  if (row.kind !== 'merchant') return 'not_a_merchant_pattern' as const
  return row
}

/** A pattern the person typed, normalized; null when it cannot match safely. */
const typedPattern = (typed: string, matchMode: MatchMode) => {
  const pattern = normalizeKnowledgePattern(typed)
  // A known aggregator's token is a valid prefix even when short (`mp`).
  const aggregatorPrefix =
    matchMode === 'prefix' && knowledgeAggregators.has(pattern)
  return aggregatorPrefix || isValidKnowledgePattern(pattern) ? pattern : null
}

const editPattern = (
  rows: ReadonlyArray<PatternRow>,
  id: string,
  typed: string,
  matchMode: MatchMode,
  now: string,
): StoreEditResult => {
  const row = merchantRow(rows, id)
  if (typeof row === 'string') return { ok: false, reason: row }
  const pattern = typedPattern(typed, matchMode)
  if (pattern === null) return { ok: false, reason: 'invalid_pattern' }
  if (
    rows.some(
      (other) =>
        other.id !== id &&
        sameKey(other, 'merchant', pattern, matchMode, row.direction),
    )
  )
    return { ok: false, reason: 'pattern_taken' }
  const edited: PatternRow = {
    ...row,
    pattern,
    matchMode,
    source: 'store_edit',
    lastLearnedAt: now,
  }
  const next = rows.map((other) => (other.id === id ? edited : other))
  return {
    ok: true,
    patternId: id,
    rows: matchMode === 'prefix' ? absorbCovered(next, edited) : next,
  }
}

/** Applies a person's edit. Pure, so a preview and the write agree. */
export const applyEdit = (
  rows: ReadonlyArray<PatternRow>,
  edit: StoreEdit,
  clock: StoreClock,
): StoreEditResult => {
  switch (edit._tag) {
    case 'Recategorize': {
      const row = rows.find((found) => found.id === edit.id)
      if (!row) return { ok: false, reason: 'pattern_not_found' }
      return {
        ok: true,
        patternId: row.id,
        rows: rows.map((other) =>
          other.id === row.id
            ? reaffirm(other, edit.categoryId, {
                source: 'store_edit',
                lastLearnedAt: clock.now,
              })
            : other,
        ),
      }
    }
    case 'EditPattern':
      return editPattern(rows, edit.id, edit.pattern, edit.matchMode, clock.now)
    case 'AddPattern': {
      const pattern = typedPattern(edit.pattern, edit.matchMode)
      if (pattern === null) return { ok: false, reason: 'invalid_pattern' }
      const fields = { source: 'store_edit' as const, lastLearnedAt: clock.now }
      // The same rule typed again teaches its category to the existing row.
      const existing = rows.find((row) =>
        sameKey(row, 'merchant', pattern, edit.matchMode, edit.direction),
      )
      if (existing)
        return {
          ok: true,
          patternId: existing.id,
          rows: rows.map((row) =>
            row.id === existing.id
              ? reaffirm(row, edit.categoryId, fields)
              : row,
          ),
        }
      const added: PatternRow = {
        id: clock.newId,
        kind: 'merchant',
        pattern,
        matchMode: edit.matchMode,
        direction: edit.direction,
        categoryId: edit.categoryId,
        signature: pattern,
        sampleDescription: edit.pattern.trim(),
        confirmations: 1,
        corrections: 0,
        ...fields,
      }
      const next = [...rows, added]
      return {
        ok: true,
        patternId: added.id,
        rows: edit.matchMode === 'prefix' ? absorbCovered(next, added) : next,
      }
    }
    case 'PromoteToPrefix': {
      const row = merchantRow(rows, edit.id)
      if (typeof row === 'string') return { ok: false, reason: row }
      const candidate =
        row.matchMode === 'exact' ? knowledgePrefixCandidate(row.pattern) : null
      if (candidate === null)
        return { ok: false, reason: 'no_prefix_candidate' }
      return editPattern(rows, row.id, candidate, 'prefix', clock.now)
    }
    case 'Remove': {
      if (!rows.some((row) => row.id === edit.id))
        return { ok: false, reason: 'pattern_not_found' }
      return {
        ok: true,
        patternId: edit.id,
        rows: rows.filter((row) => row.id !== edit.id),
      }
    }
    case 'SetProviderMapping': {
      const pattern = providerPattern(edit.provider, edit.providerCategory)
      if (edit.providerCategory.trim() === '')
        return { ok: false, reason: 'invalid_pattern' }
      const fields = {
        source: 'provider_mapping' as const,
        lastLearnedAt: clock.now,
      }
      const existing = rows.find((row) =>
        sameKey(row, 'provider_category', pattern, 'exact', 'any'),
      )
      if (existing)
        return {
          ok: true,
          patternId: existing.id,
          rows: rows.map((row) =>
            row.id === existing.id
              ? reaffirm(row, edit.categoryId, fields)
              : row,
          ),
        }
      const id = providerMappingId(pattern)
      return {
        ok: true,
        patternId: id,
        rows: [
          ...rows,
          {
            id,
            kind: 'provider_category',
            pattern,
            matchMode: 'exact',
            direction: 'any',
            categoryId: edit.categoryId,
            signature: pattern,
            sampleDescription: edit.providerCategory.trim(),
            confirmations: 1,
            corrections: 0,
            ...fields,
          },
        ],
      }
    }
  }
}
