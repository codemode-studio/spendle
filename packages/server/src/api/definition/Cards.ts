import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

import { EndpointErrors } from './Errors.ts'

/** The part of one payment applied to a cycle. Amounts are positive centavos. */
export const CyclePayment = Schema.Struct({
  /** The payment's entry, or `statement:<closing>` when only a statement shows it. */
  entryId: Schema.String,
  paidOn: Schema.String,
  creditedOn: Schema.NullOr(Schema.String),
  amountCents: Schema.Int,
  /** The card's own credit, only the bank debit, or credit an earlier cycle left. */
  via: Schema.Literals(['card', 'bank', 'credit']),
  /** The closing of the bill it was identified as paying. */
  settles: Schema.NullOr(Schema.String),
  statementClosing: Schema.NullOr(Schema.String),
})

export const CardCycle = Schema.Struct({
  startsOn: Schema.String,
  closingOn: Schema.String,
  dueOn: Schema.String,
  /** Whether an issued statement set the date, or only the card's configured day. */
  closing: Schema.Literals(['statement', 'forecast']),
  due: Schema.Literals(['statement', 'forecast']),
  payableUntil: Schema.String,
  status: Schema.Literals(['open', 'due', 'paid', 'partially_paid', 'overdue']),
  /** Purchases and credits of the cycle; negative when something is owed. */
  totalCents: Schema.Int,
  /** What the cycle bills; positive when owed. */
  billedCents: Schema.Int,
  /** Earlier cycles' debt a balance statement carries in `billedCents`. */
  carriedCents: Schema.Int,
  paidCents: Schema.Int,
  entryIds: Schema.Array(Schema.String),
  payments: Schema.Array(CyclePayment),
  /** The issued statement's total and how far the entries are from it. */
  statement: Schema.NullOr(
    Schema.Struct({
      observedCents: Schema.Int,
      deductedCents: Schema.Int,
      differenceCents: Schema.Int,
    }),
  ),
})

export const CardCycles = Schema.Struct({
  cycles: Schema.Array(CardCycle),
  /** Credit on the card beyond everything billed so far. */
  unappliedCents: Schema.Int,
  /** Payments a statement prints for bills from before the history. */
  beforeHistoryCents: Schema.Int,
})

export const InstallmentPlan = Schema.Struct({
  /** Stable for the purchase. */
  key: Schema.String,
  description: Schema.String,
  amountCents: Schema.Int,
  total: Schema.Int,
  /** Instalment numbers charged on the open or earlier bills. */
  seen: Schema.Array(Schema.Int),
  /** Of `seen`, those still pending on the open bill. */
  pending: Schema.Array(Schema.Int),
  /** Instalment numbers already reported for later bills. */
  scheduled: Schema.Array(Schema.Int),
  entryIds: Schema.Array(Schema.String),
  remaining: Schema.Int,
  /** What the remaining instalments add to later bills; negative. */
  remainingCents: Schema.Int,
  lastBookedOn: Schema.String,
})

const cardParams = { accountId: Schema.String }

export class CardsApi extends HttpApiGroup.make('cards')
  .add(
    HttpApiEndpoint.get('cycles', '/:accountId/cycles', {
      params: cardParams,
      success: CardCycles,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.get('installments', '/:accountId/installments', {
      params: cardParams,
      success: Schema.Array(InstallmentPlan),
      error: EndpointErrors,
    }),
  )
  .prefix('/api/v2/cards') {}
