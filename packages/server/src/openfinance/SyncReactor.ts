import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import * as Reactor from '../events/Reactor.ts'
import { OpenFinance, SyncRequest, syncRequested } from './OpenFinance.ts'

const decodeRequest = Schema.decodeUnknownEffect(SyncRequest)

// Conditions a retry cannot fix; the request is dropped with a log line.
const permanent = new Set([
  'connection_not_found',
  'connection_disconnected',
  'not_linked',
])

/**
 * Runs queued Pluggy syncs. A request for one account syncs it; a request for
 * a connection refreshes the item and syncs every linked account. Pluggy
 * outages fail the event so the reactor retries it with backoff.
 */
export const layer = Reactor.layer({
  name: 'open-finance-sync',
  types: [syncRequested],
  handle: (event) =>
    Effect.gen(function* () {
      const openFinance = yield* OpenFinance
      const request = yield* decodeRequest(event.payload)
      if (request.providerAccountId !== undefined) {
        yield* openFinance.syncAccount(request.providerAccountId)
        return
      }
      yield* openFinance.refreshConnection(request.connectionId)
      const linked = (yield* openFinance.providerAccounts(
        request.connectionId,
      )).filter((account) => account.accountId !== null)
      yield* Effect.forEach(
        linked,
        (account) => openFinance.syncAccount(account.providerAccountId),
        {
          discard: true,
        },
      )
    }).pipe(
      Effect.catchTag('OpenFinanceError', (error) =>
        permanent.has(error.reason)
          ? Effect.logWarning(`Skipping sync request: ${error.message}`)
          : Effect.fail(error),
      ),
      // Only an outage is worth retrying; holding the event for anything else
      // would block every later sync behind it.
      Effect.catchTag('PluggyError', (error) =>
        error.reason === 'unavailable'
          ? Effect.fail(error)
          : error.reason === 'not_found'
            ? Effect.gen(function* () {
                const request = yield* decodeRequest(event.payload)
                yield* Effect.logWarning(
                  `Pluggy no longer has the item of connection ${request.connectionId}; disconnecting`,
                )
                yield* (yield* OpenFinance).disconnect(request.connectionId)
              })
            : Effect.logWarning(`Skipping sync request: ${error.message}`),
      ),
    ),
})
