import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

import { OpenFinance } from '../../openfinance/OpenFinance.ts'
import { SpendleApi } from '../definition/Api.ts'
import { respond } from '../Failures.ts'
import { ReadModel } from '../ReadModel.ts'

export const OpenFinanceHandlers = HttpApiBuilder.group(
  SpendleApi,
  'openFinance',
  Effect.fn(function* (handlers) {
    const openFinance = yield* OpenFinance
    const reads = yield* ReadModel
    return handlers.handleAll({
      createConnectToken: ({ payload }) =>
        openFinance
          .createConnectToken(payload)
          .pipe(respond('openFinance.createConnectToken')),
      connections: () =>
        openFinance.connections.pipe(respond('openFinance.connections')),
      connection: ({ params }) =>
        openFinance
          .connection(params.connectionId)
          .pipe(respond('openFinance.connection')),
      reconnectToken: ({ params }) =>
        openFinance.reconnectToken(params.connectionId).pipe(
          Effect.map((accessToken) => ({ accessToken })),
          respond('openFinance.reconnectToken'),
        ),
      registerItem: ({ params, payload }) =>
        openFinance
          .registerItem({
            connectionId: params.connectionId,
            itemId: payload.itemId,
          })
          .pipe(respond('openFinance.registerItem')),
      refresh: ({ params }) =>
        openFinance
          .refreshConnection(params.connectionId)
          .pipe(respond('openFinance.refresh')),
      providerAccounts: ({ params }) =>
        openFinance
          .connection(params.connectionId)
          .pipe(
            Effect.andThen(openFinance.providerAccounts(params.connectionId)),
            respond('openFinance.providerAccounts'),
          ),
      sync: ({ params, payload }) =>
        openFinance
          .requestSync({
            connectionId: params.connectionId,
            ...(payload.providerAccountId === undefined
              ? {}
              : { providerAccountId: payload.providerAccountId }),
          })
          .pipe(respond('openFinance.sync')),
      disconnect: ({ params }) =>
        openFinance
          .disconnect(params.connectionId)
          .pipe(respond('openFinance.disconnect')),
      link: ({ params, payload }) =>
        openFinance
          .linkAccount({
            providerAccountId: params.providerAccountId,
            target: payload.target,
            historyMonths: payload.historyMonths,
          })
          .pipe(Effect.flatMap(reads.accountView), respond('openFinance.link')),
      unlink: ({ params }) =>
        openFinance
          .unlinkAccount(params.providerAccountId)
          .pipe(respond('openFinance.unlink')),
    })
  }),
)
