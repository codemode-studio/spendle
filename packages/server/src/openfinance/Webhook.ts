import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'

import { EventLog } from '../events/EventLog.ts'
import * as Reactor from '../events/Reactor.ts'
import { OpenFinance } from './OpenFinance.ts'
import { PluggyClient } from './PluggyClient.ts'
import { WebhookConfig } from './WebhookConfig.ts'

export const webhookPath = '/api/pluggy/webhook'
export const webhookReceived = 'PluggyWebhookReceived'

/** Pluggy's webhook body. Unknown events are stored and ignored by the reactor. */
export const PluggyWebhook = Schema.Struct({
  eventId: Schema.NonEmptyString,
  event: Schema.String,
  itemId: Schema.NonEmptyString,
  accountId: Schema.optional(Schema.NonEmptyString),
  transactionIds: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  triggeredBy: Schema.optional(Schema.NullOr(Schema.String)),
  error: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        code: Schema.String,
        message: Schema.optional(Schema.String),
      }),
    ),
  ),
})
export type PluggyWebhook = typeof PluggyWebhook.Type

const decodeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Json),
)
const decodeStored = Schema.decodeUnknownEffect(PluggyWebhook)

const maximumBodyBytes = 64 * 1024

// Compares every byte so the time taken does not reveal how much matched.
const constantTimeEquals = (a: string, b: string) => {
  const left = new TextEncoder().encode(a)
  const right = new TextEncoder().encode(b)
  let difference = left.length ^ right.length
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

/**
 * Validates a delivery and stores it as an event. Pluggy's `eventId` is the
 * event id, so a retried delivery is stored once. The work happens in the
 * reactor; Pluggy only needs a fast 2xx.
 */
export const acceptWebhook = Effect.fn('PluggyWebhook.accept')(
  function* (input: {
    readonly authorization: string | undefined
    readonly body: string
  }) {
    const settings = yield* WebhookConfig
    if (Option.isNone(settings))
      return { status: 503, body: { error: 'webhook_disabled' } }
    const expected = `Bearer ${Redacted.value(settings.value.secret)}`
    if (
      input.authorization === undefined ||
      !constantTimeEquals(input.authorization, expected)
    ) {
      return { status: 401, body: { error: 'unauthorized' } }
    }
    if (new TextEncoder().encode(input.body).length > maximumBodyBytes) {
      return { status: 413, body: { error: 'too_large' } }
    }
    // Store the body as Pluggy sent it, once it is known to be a valid event.
    const json = yield* decodeJson(input.body).pipe(Effect.option)
    const webhook = Option.isSome(json)
      ? yield* decodeStored(json.value).pipe(Effect.option)
      : Option.none<PluggyWebhook>()
    if (Option.isNone(json) || Option.isNone(webhook)) {
      return { status: 400, body: { error: 'invalid_event' } }
    }

    const log = yield* EventLog
    const stored = yield* log.append([
      {
        type: webhookReceived,
        streamId: webhook.value.itemId,
        eventId: `pluggy:${webhook.value.eventId}`,
        payload: json.value,
      },
    ])
    return {
      status: 202,
      body: { accepted: true, duplicate: stored.length === 0 },
    }
  },
)

/** `POST /api/pluggy/webhook`, the only route meant to be reachable from the internet. */
export const routes = HttpRouter.use(
  Effect.fn(function* (router) {
    yield* router.add(
      'POST',
      webhookPath,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const declared = Number(request.headers['content-length'] ?? '0')
        if (declared > maximumBodyBytes) {
          return HttpServerResponse.jsonUnsafe(
            { error: 'too_large' },
            { status: 413 },
          )
        }
        const body = yield* request.text.pipe(Effect.orElseSucceed(() => ''))
        const result = yield* acceptWebhook({
          authorization: request.headers.authorization,
          body,
        })
        return HttpServerResponse.jsonUnsafe(result.body, {
          status: result.status,
        })
      }),
    )
  }),
)

/**
 * Turns Pluggy events into ledger work:
 * - item created or updated: refresh the item and sync every linked account
 * - item errors and waiting states: refresh so the connection shows attention
 * - item deleted: mark the connection disconnected
 * - transactions created or updated: sync the account (or the whole item)
 * - transactions deleted: record removed versions for those ids
 */
export const reactor = Reactor.layer({
  name: 'pluggy-webhooks',
  types: [webhookReceived],
  handle: (event) =>
    Effect.gen(function* () {
      const webhook = yield* decodeStored(event.payload)
      const openFinance = yield* OpenFinance
      const connection = yield* openFinance.connectionByItem(webhook.itemId)
      if (Option.isNone(connection)) {
        yield* Effect.logWarning(
          `Ignoring ${webhook.event} for unknown item ${webhook.itemId}`,
        )
        return
      }
      const connectionId = connection.value.id
      if (connection.value.status === 'disconnected') return

      switch (webhook.event) {
        case 'item/created':
        case 'item/updated':
          yield* openFinance.requestSync({ connectionId })
          return
        case 'item/error':
        case 'item/waiting_user_input':
        case 'item/waiting_user_action':
        case 'item/login_succeeded':
          yield* openFinance.refreshConnection(connectionId)
          return
        case 'item/deleted':
          yield* openFinance.markItemDeleted(connectionId)
          return
        case 'transactions/created':
        case 'transactions/updated':
          yield* openFinance.requestSync({
            connectionId,
            ...(webhook.accountId
              ? { providerAccountId: webhook.accountId }
              : {}),
          })
          return
        case 'transactions/deleted':
          if (webhook.accountId && webhook.transactionIds) {
            yield* openFinance.removeTransactions(
              webhook.accountId,
              webhook.transactionIds,
            )
          }
          return
        default:
          yield* Effect.logDebug(`Ignoring Pluggy event ${webhook.event}`)
      }
    }),
})

/** Subscribes the configured URL at Pluggy on startup. Failure is logged, not fatal. */
export const registration = Layer.effectDiscard(
  Effect.gen(function* () {
    const settings = yield* WebhookConfig
    if (Option.isNone(settings)) return
    const pluggy = yield* PluggyClient
    yield* pluggy.ensureWebhook(settings.value).pipe(
      Effect.tap(() =>
        Effect.logInfo(`Pluggy webhook registered at ${settings.value.url}`),
      ),
      Effect.catch((error) =>
        Effect.logError('Pluggy webhook registration failed', error),
      ),
      Effect.forkScoped,
    )
  }),
)
