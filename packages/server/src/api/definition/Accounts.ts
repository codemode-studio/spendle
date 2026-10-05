import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

import { EndpointErrors } from './Errors.ts'

export const OwnerKind = Schema.Literals(['person', 'company', 'household'])
export const AccountKind = Schema.Literals([
  'checking',
  'savings',
  'cash',
  'investment',
  'credit_card',
])
export const AccountPurpose = Schema.Literals([
  'operating',
  'reserve',
  'investment',
])
/** ISO 4217 code, as `BRL`. */
export const Currency = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/))
const DayOfMonth = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 31 }),
)

export const Owner = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: OwnerKind,
})
export type Owner = typeof Owner.Type

export const CardTerms = Schema.Struct({
  closingDay: DayOfMonth,
  dueDay: DayOfMonth,
  limitCents: Schema.NullOr(Schema.Int),
  lastFour: Schema.NullOr(Schema.String),
})
export type CardTerms = typeof CardTerms.Type

/** A balance a source reported. `booked` balances a later read withdrew are left out. */
export const Balance = Schema.Struct({
  kind: Schema.Literals(['booked', 'available', 'statement']),
  asOf: Schema.String,
  balanceCents: Schema.Int,
  sourceId: Schema.String,
  sourceKind: Schema.Literals(['open_finance', 'file', 'manual']),
})
export type Balance = typeof Balance.Type

/** The Open Finance account that feeds a ledger account. */
export const AccountLink = Schema.Struct({
  connectionId: Schema.String,
  providerAccountId: Schema.String,
  historyFrom: Schema.NullOr(Schema.String),
})

export const AccountView = Schema.Struct({
  id: Schema.String,
  ownerId: Schema.String,
  institutionId: Schema.String,
  institutionName: Schema.String,
  name: Schema.String,
  kind: AccountKind,
  purpose: AccountPurpose,
  currency: Schema.String,
  card: Schema.NullOr(CardTerms),
  archived: Schema.Boolean,
  /** The latest balance of each kind. */
  balances: Schema.Array(Balance),
  /** The latest booked balance still standing: where the balance proof starts from. */
  lastCheckpoint: Schema.NullOr(Balance),
  link: Schema.NullOr(AccountLink),
})
export type AccountView = typeof AccountView.Type

export const OpenAccount = Schema.Struct({
  ownerId: Schema.String,
  institutionName: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  kind: AccountKind,
  purpose: AccountPurpose,
  currency: Currency,
  card: Schema.optional(CardTerms),
})

/** Fields a person may change. Currency is fixed once an account exists. */
export const AccountChanges = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyString),
  institutionName: Schema.optional(Schema.NonEmptyString),
  kind: Schema.optional(AccountKind),
  purpose: Schema.optional(AccountPurpose),
  card: Schema.optional(CardTerms),
})

const accountParams = { accountId: Schema.String }

export class OwnersApi extends HttpApiGroup.make('owners')
  .add(
    HttpApiEndpoint.get('list', '/', {
      success: Schema.Array(Owner),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('create', '/', {
      payload: Schema.Struct({
        name: Schema.NonEmptyString,
        kind: OwnerKind,
      }),
      success: Owner,
      error: EndpointErrors,
    }),
  )
  .prefix('/api/v2/owners') {}

export class AccountsApi extends HttpApiGroup.make('accounts')
  .add(
    HttpApiEndpoint.get('list', '/', {
      query: { includeArchived: Schema.optional(Schema.Boolean) },
      success: Schema.Array(AccountView),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.get('get', '/:accountId', {
      params: accountParams,
      success: AccountView,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('open', '/', {
      payload: OpenAccount,
      success: AccountView,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.patch('update', '/:accountId', {
      params: accountParams,
      payload: AccountChanges,
      success: AccountView,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.put('setCardTerms', '/:accountId/card-terms', {
      params: accountParams,
      payload: CardTerms,
      success: AccountView,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('archive', '/:accountId/archive', {
      params: accountParams,
      success: AccountView,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('restore', '/:accountId/restore', {
      params: accountParams,
      success: AccountView,
      error: EndpointErrors,
    }),
  )
  .prefix('/api/v2/accounts') {}
