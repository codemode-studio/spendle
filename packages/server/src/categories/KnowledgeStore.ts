import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { EventLog } from '../events/EventLog.ts'
import { Categories, uncategorized } from './Categories.ts'
import { knowledgePrefixCandidate } from './Patterns.ts'
import type { MatchMode } from './Patterns.ts'
import { applyEdit, learn as learnPattern } from './Store.ts'
import type { PatternRow, PatternSource, StoreEdit } from './Store.ts'

export const categoryStoreChanged = 'CategoryStoreChanged'

export class KnowledgeStoreError extends Schema.TaggedError<KnowledgeStoreError>()(
  'KnowledgeStoreError',
  {
    reason: Schema.Literals([
      'pattern_not_found',
      /** Provider mappings are edited by mapping the provider category again. */
      'not_a_merchant_pattern',
      /** Patterns need three characters and a letter. */
      'invalid_pattern',
      /** Another pattern already has this text, mode and direction. */
      'pattern_taken',
      /** Only a pattern starting with a known aggregator becomes a prefix. */
      'no_prefix_candidate',
      'category_not_found',
      /** System categories, archived ones and `uncategorized` are never taught. */
      'category_not_assignable',
    ]),
    patternId: Schema.optional(Schema.String),
    categoryId: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return [this.reason, this.patternId ?? this.categoryId]
      .filter((part) => part !== undefined)
      .join(': ')
  }
}

const PatternRowSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(['merchant', 'provider_category']),
  pattern: Schema.String,
  matchMode: Schema.Literals(['exact', 'prefix']),
  direction: Schema.Literals(['income', 'expense', 'any']),
  categoryId: Schema.String,
  signature: Schema.String,
  sampleDescription: Schema.String,
  source: Schema.Literals([
    'transaction_list',
    'review',
    'v1_import',
    'store_edit',
    'provider_mapping',
  ]),
  confirmations: Schema.Int,
  corrections: Schema.Int,
  lastLearnedAt: Schema.String,
})

/** A store row as the person sees it. */
export interface StoreEntry extends PatternRow {
  readonly categoryName: string
  readonly categoryColor: string
  /** The aggregator this exact pattern could become a prefix of. */
  readonly prefixCandidate: string | null
}

const samePattern = (a: PatternRow, b: PatternRow) =>
  (Object.keys(a) as ReadonlyArray<keyof PatternRow>).every(
    (key) => a[key] === b[key],
  )

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const log = yield* EventLog
  const categories = yield* Categories
  const crypto = yield* Crypto.Crypto

  const findRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PatternRowSchema,
    execute: () => sql`
      SELECT id, kind, pattern, match_mode AS matchMode, direction, category_id AS categoryId,
        signature, sample_description AS sampleDescription, source, confirmations, corrections,
        last_learned_at AS lastLearnedAt
      FROM category_patterns ORDER BY last_learned_at DESC, pattern, id
    `,
  })

  /** Every row of the store. */
  const rows = findRows(undefined).pipe(Effect.withSpan('KnowledgeStore.rows'))

  const clock = Effect.gen(function* () {
    return {
      now: DateTime.formatIso(yield* DateTime.now),
      newId: yield* crypto.randomUUIDv7.pipe(Effect.orDie),
    }
  })

  // Deletes go first, so a row may take over the key of one it absorbed.
  const persist = Effect.fnUntraced(function* (
    before: ReadonlyArray<PatternRow>,
    after: ReadonlyArray<PatternRow>,
  ) {
    const kept = new Map(after.map((row) => [row.id, row]))
    const previous = new Map(before.map((row) => [row.id, row]))
    for (const row of before) {
      if (!kept.has(row.id))
        yield* sql`DELETE FROM category_patterns WHERE id = ${row.id}`
    }
    for (const row of after) {
      const old = previous.get(row.id)
      if (old && samePattern(old, row)) continue
      yield* sql`
        INSERT INTO category_patterns (id, kind, pattern, match_mode, direction, category_id,
          signature, sample_description, source, confirmations, corrections, last_learned_at)
        VALUES (${row.id}, ${row.kind}, ${row.pattern}, ${row.matchMode}, ${row.direction},
          ${row.categoryId}, ${row.signature}, ${row.sampleDescription}, ${row.source},
          ${row.confirmations}, ${row.corrections}, ${row.lastLearnedAt})
        ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, pattern = excluded.pattern,
          match_mode = excluded.match_mode, direction = excluded.direction,
          category_id = excluded.category_id, signature = excluded.signature,
          sample_description = excluded.sample_description, source = excluded.source,
          confirmations = excluded.confirmations, corrections = excluded.corrections,
          last_learned_at = excluded.last_learned_at
      `
    }
  })

  const changed = (patternId: string) =>
    log.append([
      {
        type: categoryStoreChanged,
        streamId: 'category_patterns',
        payload: { patternId },
      },
    ])

  // Whether the store may point to the category: an active one the person
  // chooses, never reconciliation's or `uncategorized`.
  const assignable = Effect.fnUntraced(function* (categoryId: string) {
    const category = yield* categories.get(categoryId).pipe(Effect.option)
    if (Option.isNone(category))
      return yield* new KnowledgeStoreError({
        reason: 'category_not_found',
        categoryId,
      })
    if (
      category.value.system ||
      !category.value.active ||
      categoryId === uncategorized
    )
      return yield* new KnowledgeStoreError({
        reason: 'category_not_assignable',
        categoryId,
      })
  })

  const editCategory = (edit: StoreEdit) =>
    edit._tag === 'Recategorize' ||
    edit._tag === 'SetProviderMapping' ||
    edit._tag === 'AddPattern'
      ? edit.categoryId
      : null

  /**
   * The store as it would be after the edit, without writing it. Fails as
   * the edit itself would.
   */
  const simulate = Effect.fn('KnowledgeStore.simulate')(function* (
    edit: StoreEdit,
  ) {
    const categoryId = editCategory(edit)
    if (categoryId !== null) yield* assignable(categoryId)
    const before = yield* rows
    const result = applyEdit(before, edit, yield* clock)
    if (!result.ok)
      return yield* new KnowledgeStoreError({
        reason: result.reason,
        patternId: 'id' in edit ? edit.id : undefined,
      })
    return { before, after: result.rows, patternId: result.patternId }
  })

  /** Applies a person's edit; the categorizer reapplies the store to history. */
  const edit = Effect.fn('KnowledgeStore.edit')(function* (change: StoreEdit) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const { before, after, patternId } = yield* simulate(change)
        yield* persist(before, after)
        yield* changed(patternId)
        return patternId
      }),
    )
  })

  /**
   * What a person's category for a movement teaches (V1 `learnCategory`).
   * Only a person's decision calls this; system categories, archived ones
   * and `uncategorized` teach nothing. Returns the pattern it changed.
   */
  const learn = Effect.fn('KnowledgeStore.learn')(function* (
    entry: { readonly description: string; readonly amountCents: number },
    categoryId: string,
    source: PatternSource,
  ) {
    const allowed = yield* assignable(categoryId).pipe(
      Effect.as(true),
      Effect.catchTag('KnowledgeStoreError', () => Effect.succeed(false)),
    )
    if (!allowed) return Option.none<string>()
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const before = yield* rows
        const learned = learnPattern(
          before,
          { ...entry, categoryId, source },
          yield* clock,
        )
        if (learned === null) return Option.none<string>()
        yield* persist(before, learned.rows)
        yield* changed(learned.patternId)
        return Option.some(learned.patternId)
      }),
    )
  })

  /** The store with category names and prefix candidates, latest first. */
  const list = Effect.gen(function* () {
    const byId = new Map(
      (yield* categories.list).map((category) => [category.id, category]),
    )
    return (yield* rows).map((row): StoreEntry => ({
      ...row,
      categoryName: byId.get(row.categoryId)?.name ?? row.categoryId,
      categoryColor: byId.get(row.categoryId)?.color ?? '#64748b',
      prefixCandidate:
        row.kind === 'merchant' && row.matchMode === 'exact'
          ? knowledgePrefixCandidate(row.pattern)
          : null,
    }))
  }).pipe(Effect.withSpan('KnowledgeStore.list'))

  return {
    list,
    rows,
    simulate,
    edit,
    learn,
    recategorize: (id: string, categoryId: string) =>
      edit({ _tag: 'Recategorize', id, categoryId }),
    editPattern: (id: string, pattern: string, matchMode: MatchMode) =>
      edit({ _tag: 'EditPattern', id, pattern, matchMode }),
    remove: (id: string) => edit({ _tag: 'Remove', id }),
    promoteToPrefix: (id: string) => edit({ _tag: 'PromoteToPrefix', id }),
    setProviderMapping: (
      provider: string,
      providerCategory: string,
      categoryId: string,
    ) =>
      edit({
        _tag: 'SetProviderMapping',
        provider,
        providerCategory,
        categoryId,
      }),
  }
})

/** The only writer of `category_patterns`. */
export class KnowledgeStore extends Context.Service<
  KnowledgeStore,
  Effect.Success<typeof make>
>()('@spendle/server/categories/KnowledgeStore') {
  static readonly layer = Layer.effect(KnowledgeStore, make)
}
