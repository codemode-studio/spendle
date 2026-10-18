import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

import { LocalDate } from './Entries.ts'
import { EndpointErrors } from './Errors.ts'

const EntryStatus = Schema.Literals(['pending', 'posted'])

export const AssetClass = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.String,
})

export const Quote = Schema.Struct({
  /** Reais per unit × 1 000 000. */
  rateMicros: Schema.Int,
  date: Schema.String,
  source: Schema.String,
})

/** A movement the person put into a position. */
export const PositionMovement = Schema.Struct({
  entryId: Schema.String,
  bookedOn: Schema.String,
  description: Schema.String,
  /** Signed as the account saw it: inflows are contributions. */
  amountCents: Schema.Int,
  status: EntryStatus,
  /** False while pending or dated after the reference date. */
  counted: Schema.Boolean,
})

export const Position = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  symbol: Schema.NullOr(Schema.String),
  accountId: Schema.String,
  accountName: Schema.String,
  institutionName: Schema.String,
  /** The account's; every amount of the position is in it. */
  currency: Schema.String,
  assetClassId: Schema.String,
  assetClassName: Schema.String,
  color: Schema.String,
  /** Counts toward the emergency reserve. */
  reserve: Schema.Boolean,
  openingCents: Schema.Int,
  /** Opening plus the counted movements. */
  contributedCents: Schema.Int,
  currentCents: Schema.Int,
  resultCents: Schema.Int,
  /** `valuation`: the latest value entered plus movements since; `contributions`: no value entered yet. */
  valueKind: Schema.Literals(['valuation', 'contributions']),
  valuedOn: Schema.NullOr(Schema.String),
  /** Null when the currency has no quote now. */
  currentBrlCents: Schema.NullOr(Schema.Int),
  quote: Schema.NullOr(Quote),
  movements: Schema.Array(PositionMovement),
  /** Latest first. */
  valuations: Schema.Array(
    Schema.Struct({ asOf: Schema.String, amountCents: Schema.Int }),
  ),
})
export type Position = typeof Position.Type

export const InvestmentsSnapshot = Schema.Struct({
  /** Values are at the end of this day. */
  referenceDate: Schema.String,
  /** Largest value in reais first. */
  positions: Schema.Array(Position),
  classes: Schema.Array(AssetClass),
  /** Active brokerage accounts. */
  accounts: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      institutionName: Schema.String,
      currency: Schema.String,
    }),
  ),
  /** Latest 100 brokerage movements not in any position. */
  available: Schema.Array(
    Schema.Struct({
      entryId: Schema.String,
      accountId: Schema.String,
      bookedOn: Schema.String,
      description: Schema.String,
      amountCents: Schema.Int,
      currency: Schema.String,
      status: EntryStatus,
    }),
  ),
  summary: Schema.Struct({
    /** Positions with a quote, in reais. */
    totalBrlCents: Schema.Int,
    byCurrency: Schema.Array(
      Schema.Struct({
        currency: Schema.String,
        currentCents: Schema.Int,
        contributedCents: Schema.Int,
      }),
    ),
    positionCount: Schema.Int,
    accountCount: Schema.Int,
    reserveBrlCents: Schema.Int,
    reservePositionCount: Schema.Int,
    missingQuoteCount: Schema.Int,
  }),
})
export type InvestmentsSnapshot = typeof InvestmentsSnapshot.Type

const PositionName = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(100),
)

const PositionFields = {
  assetClassId: Schema.String,
  name: PositionName,
  symbol: Schema.optional(Schema.String.check(Schema.isMaxLength(20))),
  reserve: Schema.Boolean,
}

export class InvestmentsApi extends HttpApiGroup.make('investments')
  .add(
    HttpApiEndpoint.get('snapshot', '/investments', {
      /** Defaults to today in São Paulo. */
      query: { on: Schema.optional(LocalDate) },
      success: InvestmentsSnapshot,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('createPosition', '/investments/positions', {
      payload: Schema.Struct({ accountId: Schema.String, ...PositionFields }),
      success: Schema.Struct({ id: Schema.String }),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('classify', '/investments/movements', {
      /** Exactly one of `positionId` and `newPosition`; classifying again moves the movement. */
      payload: Schema.Struct({
        entryId: Schema.String,
        positionId: Schema.optional(Schema.String),
        newPosition: Schema.optional(Schema.Struct(PositionFields)),
      }),
      success: Schema.Struct({
        entryId: Schema.String,
        positionId: Schema.String,
      }),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.delete('unclassify', '/investments/movements/:entryId', {
      params: { entryId: Schema.String },
      /** A position left with nothing is removed with the movement. */
      success: Schema.Struct({
        entryId: Schema.String,
        positionDeleted: Schema.Boolean,
      }),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post(
      'recordValuation',
      '/investments/positions/:positionId/valuations',
      {
        params: { positionId: Schema.String },
        /** The position's total at the end of `asOf`, in its currency. */
        payload: Schema.Struct({
          asOf: LocalDate,
          amountCents: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        }),
        success: Schema.Struct({
          id: Schema.String,
          positionId: Schema.String,
        }),
        error: EndpointErrors,
      },
    ),
  )
  .prefix('/api') {}
