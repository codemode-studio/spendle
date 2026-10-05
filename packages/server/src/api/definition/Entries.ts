import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

import { EndpointErrors } from './Errors.ts'

/** A calendar day, `YYYY-MM-DD`. */
export const LocalDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
)

export const InferenceOrigin = Schema.Literals([
  'decision',
  'reconciliation',
  'refund',
  'pattern',
  'prefix',
  'provider',
  'model',
  'none',
])

/** An entry's category as the list shows it. */
export const EntryCategory = Schema.Struct({
  categoryId: Schema.NullOr(Schema.String),
  /** `review` asks the person to confirm or correct; `none` has no category. */
  status: Schema.Literals(['applied', 'review', 'none']),
  origin: InferenceOrigin,
  confidence: Schema.Number,
  /** Moves between the person's own accounts, which are not spending. */
  excludedFromSpending: Schema.Boolean,
})

/** A canonical movement: one or more observations of the same transaction. */
export const Entry = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  bookedOn: Schema.String,
  /** Signed centavos: outflows are negative. */
  amountCents: Schema.Int,
  currency: Schema.String,
  description: Schema.String,
  status: Schema.Literals(['pending', 'posted']),
  /** How many observations confirm the movement. */
  sources: Schema.Int,
  /** Null until categorization reaches the entry. */
  category: Schema.NullOr(EntryCategory),
  /** The person's note on the movement. */
  note: Schema.NullOr(Schema.String),
  /** Set when the person typed the movement in: the id to edit or delete it with. */
  manualId: Schema.NullOr(Schema.String),
})
export type Entry = typeof Entry.Type

export const EntryPage = Schema.Struct({
  entries: Schema.Array(Entry),
  /** Pass as `cursor` for the next page; null on the last one. */
  nextCursor: Schema.NullOr(Schema.String),
  /** Entries matching the filters, across every page. */
  total: Schema.Int,
})

export const EntryFilters = Schema.Struct({
  accountId: Schema.optional(Schema.String),
  from: Schema.optional(LocalDate),
  to: Schema.optional(LocalDate),
  status: Schema.optional(Schema.Literals(['pending', 'posted'])),
  categoryId: Schema.optional(Schema.String),
  categoryStatus: Schema.optional(
    Schema.Literals(['applied', 'review', 'none']),
  ),
  /** Words in the description or the note, case-insensitive. */
  text: Schema.optional(Schema.String),
  /** `inflow` keeps credits, `outflow` debits. */
  direction: Schema.optional(Schema.Literals(['inflow', 'outflow'])),
  /** Bounds on the absolute amount, in centavos, both inclusive. */
  minAmountCents: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  maxAmountCents: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })),
  ),
  cursor: Schema.optional(Schema.String),
})
export type EntryFilters = typeof EntryFilters.Type

/** One observation an entry rests on, at its latest version. */
export const Evidence = Schema.Struct({
  sourceId: Schema.String,
  sourceKind: Schema.Literals(['open_finance', 'file', 'manual']),
  sourceLabel: Schema.String,
  externalId: Schema.String,
  version: Schema.Int,
  bookedOn: Schema.String,
  amountCents: Schema.Int,
  description: Schema.String,
  status: Schema.Literals(['pending', 'posted', 'removed']),
  observedAt: Schema.String,
})

export const RelationKind = Schema.Literals([
  'internal_transfer',
  'card_payment',
  'refund',
])
export const RelationStatus = Schema.Literals([
  'suggested',
  'confirmed',
  'conflict',
])

export const Relation = Schema.Struct({
  key: Schema.String,
  kind: RelationKind,
  outflowEntryId: Schema.String,
  inflowEntryId: Schema.String,
  status: RelationStatus,
  /** `person` when the person confirmed or linked it. */
  origin: Schema.Literals(['auto', 'person']),
  score: Schema.Int,
  reasons: Schema.Array(Schema.String),
})
export type Relation = typeof Relation.Type

export const Proposal = Schema.Struct({
  categoryId: Schema.String,
  origin: InferenceOrigin,
  originRef: Schema.NullOr(Schema.String),
  confidence: Schema.Number,
  status: Schema.Literals(['applied', 'review']),
  excludedFromSpending: Schema.Boolean,
  reasons: Schema.Array(Schema.String),
})

/** Why an entry has its category: the winning rule and those that lost. */
export const CategoryExplanation = Schema.Struct({
  entryId: Schema.String,
  categoryId: Schema.NullOr(Schema.String),
  origin: InferenceOrigin,
  /** The decision key, pattern id, relation key or provider category behind it. */
  originRef: Schema.NullOr(Schema.String),
  policyVersion: Schema.Int,
  confidence: Schema.Number,
  status: Schema.Literals(['applied', 'review', 'none']),
  excludedFromSpending: Schema.Boolean,
  reasons: Schema.Array(Schema.String),
  candidates: Schema.Array(Proposal),
})
export type CategoryExplanation = typeof CategoryExplanation.Type

export const EntryDetail = Schema.Struct({
  entry: Entry,
  evidence: Schema.Array(Evidence),
  relations: Schema.Array(Relation),
  category: Schema.NullOr(CategoryExplanation),
})

/** One stretch between two checkpoints: the balance change against the posted movements. */
export const BalanceInterval = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  expectedChangeCents: Schema.Int,
  postedChangeCents: Schema.Int,
  /** Expected minus posted. Zero proves the interval; anything else is a gap to explain. */
  differenceCents: Schema.Int,
})

export const BalanceProof = Schema.Union([
  Schema.Struct({
    supported: Schema.Literal(true),
    intervals: Schema.Array(BalanceInterval),
    /** The balances checked, one per day; `manual` ones the person informed and may withdraw. */
    checkpoints: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        asOf: Schema.String,
        balanceCents: Schema.Int,
        sourceId: Schema.String,
        sourceKind: Schema.Literals(['open_finance', 'file', 'manual']),
      }),
    ),
    /** Days where sources report different balances. */
    conflicts: Schema.Array(
      Schema.Struct({
        asOf: Schema.String,
        balances: Schema.Array(
          Schema.Struct({ sourceId: Schema.String, balanceCents: Schema.Int }),
        ),
      }),
    ),
  }),
  /** Card balances follow statement cycles: see the card's cycles. */
  Schema.Struct({
    supported: Schema.Literal(false),
    reason: Schema.Literal('credit_card'),
  }),
])

export class EntriesApi extends HttpApiGroup.make('entries')
  .add(
    HttpApiEndpoint.get('list', '/entries', {
      query: EntryFilters,
      success: EntryPage,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.get('get', '/entries/:entryId', {
      params: { entryId: Schema.String },
      success: EntryDetail,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.get('balanceProof', '/accounts/:accountId/balance-proof', {
      params: { accountId: Schema.String },
      success: BalanceProof,
      error: EndpointErrors,
    }),
  )
  .prefix('/api/v2') {}
