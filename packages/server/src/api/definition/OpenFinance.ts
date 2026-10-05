import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'

import {
  AccountKind,
  AccountPurpose,
  AccountView,
  CardTerms,
} from './Accounts.ts'
import { EndpointErrors } from './Errors.ts'

export const Connection = Schema.Struct({
  id: Schema.String,
  ownerId: Schema.String,
  itemId: Schema.NullOr(Schema.String),
  sourceId: Schema.NullOr(Schema.String),
  connectorName: Schema.NullOr(Schema.String),
  /** `attention` means Pluggy needs the person: reconnect with a new token. */
  status: Schema.Literals(['pending', 'active', 'attention', 'disconnected']),
  providerStatus: Schema.NullOr(Schema.String),
  errorCode: Schema.NullOr(Schema.String),
  lastSyncedAt: Schema.NullOr(Schema.String),
})
export type Connection = typeof Connection.Type

/** An account as Pluggy describes it, and the ledger account it feeds. */
export const ProviderAccount = Schema.Struct({
  providerAccountId: Schema.String,
  connectionId: Schema.String,
  type: Schema.Literals(['BANK', 'CREDIT']),
  subtype: Schema.NullOr(Schema.String),
  name: Schema.String,
  lastFour: Schema.NullOr(Schema.String),
  currency: Schema.String,
  accountId: Schema.NullOr(Schema.String),
  /** First day copied; null while not linked. */
  historyFrom: Schema.NullOr(Schema.String),
})
export type ProviderAccount = typeof ProviderAccount.Type

/** Link to an existing ledger account, or open a new one from the provider account. */
export const LinkTarget = Schema.Union([
  Schema.Struct({ accountId: Schema.String }),
  Schema.Struct({
    name: Schema.optional(Schema.NonEmptyString),
    kind: AccountKind,
    purpose: AccountPurpose,
    card: Schema.optional(CardTerms),
  }),
])

const connectionParams = { connectionId: Schema.String }
const providerAccountParams = { providerAccountId: Schema.String }

export class OpenFinanceApi extends HttpApiGroup.make('openFinance')
  .add(
    HttpApiEndpoint.post('createConnectToken', '/connect-token', {
      payload: Schema.Struct({ ownerId: Schema.String }),
      success: Schema.Struct({
        connectionId: Schema.String,
        /** For the Pluggy Connect widget; valid for 30 minutes. */
        accessToken: Schema.String,
      }),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.get('connections', '/connections', {
      success: Schema.Array(Connection),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.get('connection', '/connections/:connectionId', {
      params: connectionParams,
      success: Connection,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post(
      'reconnectToken',
      '/connections/:connectionId/reconnect-token',
      {
        params: connectionParams,
        success: Schema.Struct({ accessToken: Schema.String }),
        error: EndpointErrors,
      },
    ),
    HttpApiEndpoint.post('registerItem', '/connections/:connectionId/item', {
      params: connectionParams,
      /** The item id the widget's `onSuccess` reported. */
      payload: Schema.Struct({ itemId: Schema.NonEmptyString }),
      success: Schema.Array(ProviderAccount),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('refresh', '/connections/:connectionId/refresh', {
      params: connectionParams,
      success: Connection,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.get(
      'providerAccounts',
      '/connections/:connectionId/accounts',
      {
        params: connectionParams,
        success: Schema.Array(ProviderAccount),
        error: EndpointErrors,
      },
    ),
    HttpApiEndpoint.post('sync', '/connections/:connectionId/sync', {
      params: connectionParams,
      /** Without an account, every linked account of the connection syncs. */
      payload: Schema.Struct({
        providerAccountId: Schema.optional(Schema.String),
      }),
      success: HttpApiSchema.Accepted,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.delete('disconnect', '/connections/:connectionId', {
      params: connectionParams,
      success: HttpApiSchema.NoContent,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.put('link', '/provider-accounts/:providerAccountId/link', {
      params: providerAccountParams,
      payload: Schema.Struct({
        target: LinkTarget,
        /** Months of history to copy on the first sync. */
        historyMonths: Schema.Literals([3, 6]),
      }),
      success: AccountView,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.delete(
      'unlink',
      '/provider-accounts/:providerAccountId/link',
      {
        params: providerAccountParams,
        success: HttpApiSchema.NoContent,
        error: EndpointErrors,
      },
    ),
  )
  .prefix('/api/v2/open-finance') {}
