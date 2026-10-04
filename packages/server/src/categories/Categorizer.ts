import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { EventLog } from '../events/EventLog.ts'
import * as Reactor from '../events/Reactor.ts'
import { entriesResolved } from '../ledger/Entries.ts'
import { categoryChanged, uncategorized } from './Categories.ts'
import { followCategoryDecisions } from './FollowDecisions.ts'
import { categoryStoreChanged, KnowledgeStore } from './KnowledgeStore.ts'
import { categorize, POLICY_VERSION } from './Policy.ts'
import type { Inference, PolicyInput } from './Policy.ts'
import type { PatternRow, StoreEdit } from './Store.ts'

export const categoriesChanged = 'CategoriesChanged'
export const categoryDecided = 'CategoryDecided'
export const categoryDecisionUndone = 'CategoryDecisionUndone'

export type DecisionOrigin = 'transaction_list' | 'review' | 'v1_import'

export class CategorizerError extends Schema.TaggedError<CategorizerError>()(
  'CategorizerError',
  {
    reason: Schema.Literals([
      'entry_not_found',
      'category_not_found',
      /** System categories come from reconciliation; archived ones are not offered. */
      'category_not_assignable',
      'decision_not_found',
      /** The entry has no suggestion to confirm; choose a category instead. */
      'nothing_to_confirm',
    ]),
    entryId: Schema.optional(Schema.String),
    categoryId: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return [this.reason, this.entryId, this.categoryId]
      .filter((part) => part !== undefined)
      .join(': ')
  }
}

export const Proposal = Schema.Struct({
  categoryId: Schema.String,
  origin: Schema.Literals([
    'decision',
    'reconciliation',
    'refund',
    'pattern',
    'prefix',
    'provider',
    'model',
  ]),
  originRef: Schema.NullOr(Schema.String),
  confidence: Schema.Number,
  status: Schema.Literals(['applied', 'review']),
  excludedFromSpending: Schema.Boolean,
  reasons: Schema.Array(Schema.String),
})

export class CategoryInference extends Schema.Class<CategoryInference>(
  'CategoryInference',
)({
  entryId: Schema.String,
  categoryId: Schema.NullOr(Schema.String),
  origin: Schema.Literals([
    'decision',
    'reconciliation',
    'refund',
    'pattern',
    'prefix',
    'provider',
    'model',
    'none',
  ]),
  originRef: Schema.NullOr(Schema.String),
  policyVersion: Schema.Int,
  confidence: Schema.Number,
  status: Schema.Literals(['applied', 'review', 'none']),
  /** Moves between the person's own accounts, which are not spending. */
  excludedFromSpending: Schema.Boolean,
  reasons: Schema.Array(Schema.String),
  /** What the rules that lost said, for the explanation. */
  candidates: Schema.Array(Proposal),
}) {}

const Reasons = Schema.fromJsonString(Schema.Array(Schema.String))
const Candidates = Schema.fromJsonString(Schema.Array(Proposal))

const InferenceRow = Schema.Struct({
  entryId: Schema.String,
  categoryId: Schema.NullOr(Schema.String),
  origin: CategoryInference.fields.origin,
  originRef: Schema.NullOr(Schema.String),
  policyVersion: Schema.Int,
  confidence: Schema.Number,
  status: CategoryInference.fields.status,
  excludedFromSpending: Schema.BooleanFromBit,
  reasons: Reasons,
  candidates: Candidates,
}).pipe(Schema.decodeTo(CategoryInference))

/** An inference with what the person needs to recognise the movement. */
export interface ReviewItem {
  readonly inference: CategoryInference
  readonly accountId: string
  readonly bookedOn: string
  readonly amountCents: number
  readonly description: string
}

/** An inference a store edit would change. */
export interface PreviewChange {
  readonly entryId: string
  readonly before: Inference
  readonly after: Inference
}

const EntryRow = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  bookedOn: Schema.String,
  amountCents: Schema.Int,
  description: Schema.String,
  providerCategories: Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        id: Schema.NullOr(Schema.String),
        name: Schema.NullOr(Schema.String),
      }),
    ),
  ),
})

const encodeReasons = Schema.encodeEffect(Reasons)
const encodeCandidates = Schema.encodeEffect(Candidates)

// What readers see of an inference, as one comparable string.
const fingerprint = (inference: {
  readonly categoryId: string | null
  readonly origin: string
  readonly originRef: string | null
  readonly confidence: number
  readonly status: string
  readonly excludedFromSpending: boolean
  readonly reasons: ReadonlyArray<string>
  readonly candidates: ReadonlyArray<typeof Proposal.Type>
}) =>
  [
    inference.categoryId,
    inference.origin,
    inference.originRef,
    inference.confidence,
    inference.status,
    inference.excludedFromSpending,
    inference.reasons.join('|'),
    inference.candidates
      .map((candidate) =>
        [
          candidate.categoryId,
          candidate.origin,
          candidate.originRef,
          candidate.confidence,
          candidate.status,
          candidate.excludedFromSpending,
          candidate.reasons.join('|'),
        ].join(','),
      )
      .join(';'),
  ].join('\u0000')

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const log = yield* EventLog
  const store = yield* KnowledgeStore
  const crypto = yield* Crypto.Crypto
  // Rebuilds and decisions run one at a time, each from reading state to
  // replacing inferences: a rebuild never writes inferences computed before
  // a decision that committed meanwhile.
  const lock = yield* Semaphore.make(1)
  const serialized = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    lock.withPermit(effect).pipe(Effect.withSpan('Categorizer.serialize'))

  // The provider category each current observation of the entry reports.
  const providerCategories = sql.literal(`(
    SELECT json_group_array(json_object(
      'id', json_extract(t.raw, '$.categoryId'), 'name', json_extract(t.raw, '$.category')))
    FROM entry_evidence v JOIN transaction_observations t
      ON t.source_id = v.source_id AND t.account_id = v.account_id AND t.external_id = v.external_id
    WHERE v.entry_id = e.id
      AND (json_type(t.raw, '$.categoryId') = 'text' OR json_type(t.raw, '$.category') = 'text')
      AND t.version = (
        SELECT max(version) FROM transaction_observations l
        WHERE l.source_id = t.source_id AND l.account_id = t.account_id
          AND l.external_id = t.external_id
      ))`)
  const selectEntries = sql`
    SELECT e.id, e.account_id AS accountId, e.booked_on AS bookedOn, e.amount_cents AS amountCents,
      e.description, ${providerCategories} AS providerCategories
    FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
  `

  const findEntries = SqlSchema.findAll({
    Request: Schema.Void,
    Result: EntryRow,
    execute: () =>
      sql`${selectEntries} WHERE a.archived_at IS NULL ORDER BY e.id`,
  })
  const findEntry = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: EntryRow,
    execute: (id) => sql`${selectEntries} WHERE e.id = ${id}`,
  })
  const findDecisions = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      key: Schema.String,
      categoryId: Schema.String,
      revision: Schema.Int,
    }),
    execute: () =>
      sql`SELECT key, category_id AS categoryId, revision FROM category_decisions`,
  })
  // The entries now holding the observations each decision's entry had. A
  // withdrawn observation points to the entry it last belonged to, or the
  // one that entry merged into (see `Entries.resolveAccount`).
  const findHolders = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ key: Schema.String, entryId: Schema.String }),
    execute: () => sql`
      SELECT DISTINCT p.key, e.id AS entryId
      FROM category_decision_endpoints p
      LEFT JOIN entry_evidence v ON v.source_id = p.source_id AND v.account_id = p.account_id
        AND v.external_id = p.external_id
      LEFT JOIN entry_identity i ON i.source_id = p.source_id AND i.account_id = p.account_id
        AND i.external_id = p.external_id
      JOIN ledger_entries e ON e.id = coalesce(v.entry_id, i.entry_id)
    `,
  })
  const findCategories = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      id: Schema.String,
      bucket: Schema.String,
      active: Schema.BooleanFromBit,
      system: Schema.BooleanFromBit,
    }),
    execute: () => sql`SELECT id, bucket, active, system FROM categories`,
  })
  const selectInferences = sql`
    SELECT entry_id AS entryId, category_id AS categoryId, origin, origin_ref AS originRef,
      policy_version AS policyVersion, confidence, status,
      excluded_from_spending AS excludedFromSpending, reasons, candidates
    FROM category_inferences
  `
  const findInferences = SqlSchema.findAll({
    Request: Schema.Void,
    Result: InferenceRow,
    execute: () => sql`${selectInferences} ORDER BY entry_id`,
  })
  const findInference = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: InferenceRow,
    execute: (entryId) => sql`${selectInferences} WHERE entry_id = ${entryId}`,
  })
  const findState = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Schema.Struct({ sequence: Schema.Int, policyVersion: Schema.Int }),
    execute: () => sql`
      SELECT sequence, policy_version AS policyVersion FROM categorization_state WHERE id = 1
    `,
  })

  const followed = Effect.gen(function* () {
    const entries = yield* findEntries(undefined)
    const holders = new Map<string, Array<string>>()
    for (const row of yield* findHolders(undefined)) {
      const list = holders.get(row.key) ?? []
      list.push(row.entryId)
      holders.set(row.key, list)
    }
    const decisions = followCategoryDecisions(
      (yield* findDecisions(undefined)).map((row) => ({
        ...row,
        holders: holders.get(row.key) ?? [],
      })),
      new Set(entries.map((entry) => entry.id)),
    )
    return { entries, decisions }
  })

  const load = Effect.gen(function* () {
    const { entries, decisions } = yield* followed
    const input: PolicyInput = {
      entries,
      decisions,
      store: yield* store.rows,
      categories: yield* findCategories(undefined),
    }
    return input
  })

  const toStored = (inference: Inference) =>
    new CategoryInference({
      ...inference,
      policyVersion: POLICY_VERSION,
    })

  const markRebuilt = (sequence: number) =>
    sql`
      INSERT INTO categorization_state (id, sequence, policy_version)
      VALUES (1, ${sequence}, ${POLICY_VERSION})
      ON CONFLICT (id) DO UPDATE SET sequence = excluded.sequence,
        policy_version = excluded.policy_version
    `

  // Callers hold `lock`. Reads and the replacement share one transaction.
  const replaceInferences = sql.withTransaction(
    Effect.gen(function* () {
      const sequence = yield* log.latestSequence
      const computed = categorize(yield* load).map(toStored)
      const stored = new Map(
        (yield* findInferences(undefined)).map((row) => [row.entryId, row]),
      )
      const changed = computed.filter((inference) => {
        const found = stored.get(inference.entryId)
        return (
          found === undefined ||
          found.policyVersion !== inference.policyVersion ||
          fingerprint(found) !== fingerprint(inference)
        )
      })
      if (changed.length === 0 && stored.size === computed.length) {
        yield* markRebuilt(sequence)
        return false
      }
      yield* sql`DELETE FROM category_inferences`
      for (const inference of computed) {
        yield* sql`
          INSERT INTO category_inferences (entry_id, category_id, origin, origin_ref,
            policy_version, confidence, status, excluded_from_spending, reasons, candidates)
          VALUES (${inference.entryId}, ${inference.categoryId}, ${inference.origin},
            ${inference.originRef}, ${inference.policyVersion}, ${inference.confidence},
            ${inference.status}, ${inference.excludedFromSpending ? 1 : 0},
            ${yield* encodeReasons(inference.reasons)},
            ${yield* encodeCandidates(inference.candidates)})
        `
      }
      yield* log.append([
        {
          type: categoriesChanged,
          streamId: 'category_inferences',
          payload: { entries: computed.length, changed: changed.length },
        },
      ])
      yield* markRebuilt(sequence)
      return true
    }),
  )

  /** Recomputes every inference; emits `CategoriesChanged` on change. */
  const rebuild = Effect.fn('Categorizer.rebuild')(function* () {
    return yield* serialized(replaceInferences)
  })

  /** Whether inferences already reflect events up to `sequence` under this policy. */
  const rebuiltThrough = Effect.fn('Categorizer.rebuiltThrough')(function* (
    sequence: number,
  ) {
    const state = yield* findState(undefined)
    return (
      Option.isSome(state) &&
      state.value.policyVersion === POLICY_VERSION &&
      state.value.sequence >= sequence
    )
  })

  const assignable = Effect.fnUntraced(function* (categoryId: string) {
    const category = (yield* findCategories(undefined)).find(
      (found) => found.id === categoryId,
    )
    if (!category)
      return yield* new CategorizerError({
        reason: 'category_not_found',
        categoryId,
      })
    if (category.system || !category.active)
      return yield* new CategorizerError({
        reason: 'category_not_assignable',
        categoryId,
      })
  })

  const entry = Effect.fnUntraced(function* (entryId: string) {
    const found = yield* findEntry(entryId)
    if (Option.isNone(found))
      return yield* new CategorizerError({ reason: 'entry_not_found', entryId })
    return found.value
  })

  // A decision about an entry updates the stored decisions that cover that
  // entry alone, instead of sitting beside them: their observations stay
  // with them, so an old category cannot resurface once entries diverge.
  // Endpoints are only added, never replaced.
  const write = Effect.fnUntraced(function* (
    entryId: string,
    categoryId: string,
    origin: DecisionOrigin,
  ) {
    const { decisions } = yield* followed
    const covering = [...decisions.entriesOf]
      .filter(([, ids]) => ids.length === 1 && ids[0] === entryId)
      .map(([key]) => key)
    const keys =
      covering.length > 0
        ? covering
        : [yield* crypto.randomUUIDv7.pipe(Effect.orDie)]
    const decidedAt = DateTime.formatIso(yield* DateTime.now)
    for (const key of keys) {
      yield* sql`
        INSERT INTO category_decisions (key, category_id, origin, decided_at, revision)
        VALUES (${key}, ${categoryId}, ${origin}, ${decidedAt},
          (SELECT coalesce(max(revision), 0) + 1 FROM category_decisions))
        ON CONFLICT (key) DO UPDATE SET category_id = excluded.category_id,
          origin = excluded.origin, decided_at = excluded.decided_at,
          revision = excluded.revision
      `
      yield* sql`
        INSERT OR IGNORE INTO category_decision_endpoints (key, source_id, account_id, external_id)
        SELECT ${key}, source_id, account_id, external_id
        FROM entry_evidence WHERE entry_id = ${entryId}
      `
    }
    return keys
  })

  const decideUnlocked = Effect.fnUntraced(function* (
    entryId: string,
    categoryId: string,
    options: { readonly learn: boolean; readonly origin: DecisionOrigin },
  ) {
    yield* assignable(categoryId)
    const decided = yield* entry(entryId)
    const keys = yield* write(entryId, categoryId, options.origin)
    if (options.learn && categoryId !== uncategorized)
      yield* store.learn(decided, categoryId, options.origin)
    yield* log.append([
      {
        type: categoryDecided,
        streamId: entryId,
        payload: { entryId, categoryId, keys },
      },
    ])
    yield* replaceInferences
  })

  /**
   * The person's category for an entry, or `uncategorized` to leave it
   * without one. The decision, what it teaches the store and the
   * inferences it changes commit together.
   */
  const decide = Effect.fn('Categorizer.decide')(
    (
      entryId: string,
      categoryId: string,
      options: {
        readonly learn?: boolean
        readonly origin?: DecisionOrigin
      } = {},
    ) =>
      serialized(
        sql.withTransaction(
          decideUnlocked(entryId, categoryId, {
            learn: options.learn ?? true,
            origin: options.origin ?? 'transaction_list',
          }),
        ),
      ),
  )

  /** Withdraws the person's decision about the entry; what it taught stays. */
  const undo = Effect.fn('Categorizer.undo')((entryId: string) =>
    serialized(
      sql.withTransaction(
        Effect.gen(function* () {
          const { decisions } = yield* followed
          const keys = [...decisions.entriesOf]
            .filter(([, ids]) => ids.length === 1 && ids[0] === entryId)
            .map(([key]) => key)
          if (keys.length === 0)
            return yield* new CategorizerError({
              reason: 'decision_not_found',
              entryId,
            })
          for (const key of keys)
            yield* sql`DELETE FROM category_decisions WHERE key = ${key}`
          yield* log.append([
            {
              type: categoryDecisionUndone,
              streamId: entryId,
              payload: { entryId, keys },
            },
          ])
          yield* replaceInferences
        }),
      ),
    ),
  )

  /** Accepts the suggestion under review (or the applied one) as the person's decision. */
  const confirm = Effect.fn('Categorizer.confirm')(function* (entryId: string) {
    const inference = yield* findInference(entryId)
    if (Option.isNone(inference) || inference.value.categoryId === null)
      return yield* new CategorizerError({
        reason: 'nothing_to_confirm',
        entryId,
      })
    return yield* decide(entryId, inference.value.categoryId, {
      origin: 'review',
    })
  })

  /** Replaces the suggestion with the person's category. */
  const correct = Effect.fn('Categorizer.correct')(
    (entryId: string, categoryId: string) =>
      decide(entryId, categoryId, { origin: 'review' }),
  )

  /** Every inference, or those of the given entries. */
  const inferences = Effect.fn('Categorizer.inferences')(function* (
    entryIds?: ReadonlyArray<string>,
  ) {
    const all = yield* findInferences(undefined)
    if (entryIds === undefined) return all
    const wanted = new Set(entryIds)
    return all.filter((inference) => wanted.has(inference.entryId))
  })

  /** Why the entry has its category: winning origin, reference, confidence, reasons and losing candidates. */
  const explain = Effect.fn('Categorizer.explain')(function* (entryId: string) {
    const found = yield* findInference(entryId)
    if (Option.isNone(found))
      return yield* new CategorizerError({ reason: 'entry_not_found', entryId })
    return found.value
  })

  const reviewRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ entryId: Schema.String }),
    execute: () => sql`
      SELECT c.entry_id AS entryId FROM category_inferences c
      JOIN ledger_entries e ON e.id = c.entry_id
      WHERE c.status = 'review' ORDER BY e.booked_on DESC, e.id
    `,
  })

  /** What waits for the person, latest first. Leaving it always takes a decision. */
  const reviewQueue = Effect.gen(function* () {
    const byId = new Map(
      (yield* findInferences(undefined)).map((row) => [row.entryId, row]),
    )
    const items: Array<ReviewItem> = []
    for (const { entryId } of yield* reviewRows(undefined)) {
      const inference = byId.get(entryId)
      const found = yield* findEntry(entryId)
      if (inference && Option.isSome(found))
        items.push({
          inference,
          accountId: found.value.accountId,
          bookedOn: found.value.bookedOn,
          amountCents: found.value.amountCents,
          description: found.value.description,
        })
    }
    return items
  }).pipe(Effect.withSpan('Categorizer.reviewQueue'))

  /**
   * The entries whose category, status or origin a store edit would change,
   * computed over the store with the edit applied; writes nothing. Committing the same edit through
   * `KnowledgeStore` produces exactly these once the categorizer rebuilds.
   */
  const previewStoreEdit = Effect.fn('Categorizer.previewStoreEdit')(function* (
    edit: StoreEdit,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const input = yield* load
        const { after } = yield* store.simulate(edit)
        return diff(input, after)
      }),
    )
  })

  return {
    rebuild,
    rebuiltThrough,
    storedPolicyVersion: findState(undefined).pipe(
      Effect.map(Option.map((state) => state.policyVersion)),
    ),
    decide,
    undo,
    confirm,
    correct,
    inferences,
    explain,
    reviewQueue,
    previewStoreEdit,
  }
})

// What the person sees change: the category, whether it applies, where it
// comes from. Explanations of entries that keep all three are not changes.
const outcome = (inference: Inference) =>
  [
    inference.categoryId,
    inference.status,
    inference.origin,
    inference.excludedFromSpending,
  ].join('\u0000')

const diff = (
  input: PolicyInput,
  after: ReadonlyArray<PatternRow>,
): ReadonlyArray<PreviewChange> => {
  const before = categorize(input)
  const next = new Map(
    categorize({ ...input, store: after }).map((inference) => [
      inference.entryId,
      inference,
    ]),
  )
  return before.flatMap((inference) => {
    const changed = next.get(inference.entryId)!
    return outcome(inference) === outcome(changed)
      ? []
      : [{ entryId: inference.entryId, before: inference, after: changed }]
  })
}

export class Categorizer extends Context.Service<
  Categorizer,
  Effect.Success<typeof make>
>()('@spendle/server/categories/Categorizer') {
  static readonly layer = Layer.effect(Categorizer, make)
}

/**
 * Recategorizes whenever what the policy reads changes: an account's
 * entries, the account itself, the store or a category. A rebuild reads
 * current state, so events it already covers are skipped.
 */
export const reactor = Reactor.layer({
  name: 'categorizer',
  types: [
    entriesResolved,
    'AccountUpdated',
    categoryStoreChanged,
    categoryChanged,
  ],
  handle: (event) =>
    Effect.gen(function* () {
      const categorizer = yield* Categorizer
      if (yield* categorizer.rebuiltThrough(event.sequence)) return
      yield* categorizer.rebuild()
    }),
})
