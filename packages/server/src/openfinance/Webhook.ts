import * as NodeHttpServerRequest from '@effect/platform-node/NodeHttpServerRequest'
import * as NodeStream from '@effect/platform-node/NodeStream'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServerError from 'effect/http/HttpServerError'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'

import { EventLog } from '../events/EventLog.ts'
import * as Reactor from '../events/Reactor.ts'
import { OpenFinance } from './OpenFinance.ts'
import { PluggyClient } from './PluggyClient.ts'
import { WebhookConfig } from './WebhookConfig.ts'

export const webhookPath = '/api/pluggy/webhook'
export const webhookReceived = 'PluggyWebhookReceived'

/**
 * Pluggy's webhook body. Only `eventId` and `event` are common to every event
 * (connector events carry no item), so the rest is optional; unknown events
 * are stored and ignored by the reactor.
 */
export const PluggyWebhook = Schema.Struct({
  eventId: Schema.NonEmptyString,
  event: Schema.String,
  itemId: Schema.optional(Schema.NonEmptyString),
  accountId: Schema.optional(Schema.NonEmptyString),
  transactionIds: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  /** On transactions/created: the earliest creation time of the new transactions. */
  transactionsCreatedAtFrom: Schema.optional(Schema.String),
  triggeredBy: Schema.optional(Schema.NullOr(Schema.String)),
  // Its shape differs between events (item errors carry a code, payment
  // errors a title); nothing here reads it.
  error: Schema.optional(Schema.Unknown),
})
export type PluggyWebhook = typeof PluggyWebhook.Type

const decodeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Json),
)
const decodeStored = Schema.decodeUnknownEffect(PluggyWebhook)

const maximumBodyBytes = 64 * 1024
// Past `maximumBodyBytes`, the rest of a body is discarded while the 413 goes
// out; once this much more arrived, and the 413 is sent, the connection is
// closed.
const maximumDrainBytes = 1024 * 1024

interface BodySource {
  readonly stream: Stream.Stream<
    Uint8Array,
    HttpServerError.HttpServerError | Cause.UnknownError
  >
  /** Discards what the caller still sends, without buffering it. */
  readonly discardRest: Effect.Effect<void>
}

/**
 * Node's own request stream destroys the request, and with it the socket,
 * when reading stops early, so the 413 would never reach the caller. On Node
 * the body is read without that finalizer and the rest is discarded until the
 * response is out. Other runtimes (the web handler) answer independently of
 * the request body.
 */
const bodySource = (
  request: HttpServerRequest.HttpServerRequest,
): BodySource => {
  if (request.source instanceof Request) {
    return { stream: request.stream, discardRest: Effect.void }
  }
  const incoming = NodeHttpServerRequest.toIncomingMessage(request)
  return {
    stream: NodeStream.fromReadable({
      evaluate: () => incoming,
      closeOnDone: false,
    }),
    discardRest: Effect.sync(() => {
      if (incoming.readableEnded) return
      const response = NodeHttpServerRequest.toServerResponse(request)
      const close = () => incoming.destroy()
      let discarded = 0
      const discard = (chunk: Uint8Array) => {
        discarded += chunk.length
        if (discarded <= maximumDrainBytes) return
        incoming.off('data', discard)
        incoming.pause()
        if (response.writableFinished) close()
        else response.once('finish', close)
      }
      incoming.on('data', discard)
      incoming.resume()
    }),
  }
}

/** The body as text, or `None` when it exceeds `maximumBodyBytes`. */
const readBody = (source: BodySource) =>
  Effect.gen(function* () {
    const chunks: Array<Uint8Array> = []
    let size = 0
    yield* Stream.runForEachWhile(source.stream, (chunk) =>
      Effect.sync(() => {
        size += chunk.length
        if (size <= maximumBodyBytes) chunks.push(chunk)
        return size <= maximumBodyBytes
      }),
    )
    if (size > maximumBodyBytes) {
      yield* source.discardRest
      return Option.none<string>()
    }
    const body = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.length
    }
    return Option.some(new TextDecoder().decode(body))
  })

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

/** Checks the bearer secret; `None` means authorized. Runs before the body is read. */
export const authorizeWebhook = Effect.fn('PluggyWebhook.authorize')(function* (
  authorization: string | undefined,
) {
  const settings = yield* WebhookConfig
  if (Option.isNone(settings))
    return Option.some({ status: 503, body: { error: 'webhook_disabled' } })
  const expected = `Bearer ${Redacted.value(settings.value.secret)}`
  return authorization !== undefined &&
    constantTimeEquals(authorization, expected)
    ? Option.none()
    : Option.some({ status: 401, body: { error: 'unauthorized' } })
})

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
    const refused = yield* authorizeWebhook(input.authorization)
    if (Option.isSome(refused)) return refused.value
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
        streamId: webhook.value.itemId ?? webhook.value.event,
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
        // Nothing is read from an unauthenticated caller.
        const refused = yield* authorizeWebhook(request.headers.authorization)
        if (Option.isSome(refused)) {
          return HttpServerResponse.jsonUnsafe(refused.value.body, {
            status: refused.value.status,
          })
        }
        const declared = Number(request.headers['content-length'] ?? '0')
        if (declared > maximumBodyBytes) {
          return HttpServerResponse.jsonUnsafe(
            { error: 'too_large' },
            { status: 413 },
          )
        }
        // The limit also applies while streaming, for bodies without Content-Length.
        const read = yield* readBody(bodySource(request)).pipe(Effect.result)
        if (read._tag === 'Failure') {
          return HttpServerResponse.jsonUnsafe(
            { error: 'invalid_event' },
            { status: 400 },
          )
        }
        const body = read.success
        if (Option.isNone(body)) {
          return HttpServerResponse.jsonUnsafe(
            { error: 'too_large' },
            { status: 413 },
          )
        }
        const result = yield* acceptWebhook({
          authorization: request.headers.authorization,
          body: body.value,
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
 * - item created or updated: refresh the item and sync every linked account;
 *   an unknown item attaches to the pending connection that created it
 * - item errors and waiting states: refresh so the connection shows attention
 * - item deleted: remember the deletion, even of an item no connection holds
 *   yet, and mark the connection holding it disconnected
 * - transactions created or updated: read exactly those transactions (by id,
 *   or created since the given time), whatever their dates; without those
 *   details, sync the account or the whole item
 * - transactions deleted: record removed versions for those ids
 */
// Conditions a retry cannot fix; the event is dropped with a log line.
const permanent = new Set([
  'connection_not_found',
  'connection_disconnected',
  'provider_account_not_found',
  'not_linked',
])

// Attaches an unknown item to the pending connection that created it, then
// syncs it. Items of no pending connection here are ignored.
const adopt = (event: string, itemId: string) =>
  Effect.gen(function* () {
    const openFinance = yield* OpenFinance
    const adopted = yield* openFinance.adoptItem(itemId)
    if (Option.isNone(adopted)) {
      yield* Effect.logWarning(`Ignoring ${event} for unknown item ${itemId}`)
      return
    }
    yield* openFinance.requestSync({ connectionId: adopted.value })
  }).pipe(
    // The connection was disconnected or took another item meanwhile.
    Effect.catchTag('OpenFinanceError', (error) =>
      Effect.logWarning(
        `Ignoring ${event} for item ${itemId}: ${error.message}`,
      ),
    ),
    Effect.catchTag('PluggyError', (error) =>
      error.reason === 'unavailable'
        ? Effect.fail(error)
        : Effect.logWarning(
            `Ignoring ${event} for item ${itemId}: ${error.message}`,
          ),
    ),
  )

export const reactor = Reactor.layer({
  name: 'pluggy-webhooks',
  types: [webhookReceived],
  handle: (event) =>
    Effect.gen(function* () {
      const webhook = yield* decodeStored(event.payload)
      const openFinance = yield* OpenFinance
      // Connector-wide events (e.g. connector/status_updated) concern no item.
      if (webhook.itemId === undefined) {
        yield* Effect.logDebug(`Ignoring Pluggy event ${webhook.event}`)
        return
      }
      const itemId = webhook.itemId
      // Kept even for an item no connection holds yet: a registration that
      // fetched it before the deletion must not attach it afterwards.
      if (webhook.event === 'item/deleted') {
        yield* openFinance.itemDeleted(itemId)
        return
      }
      const connection = yield* openFinance.connectionByItem(itemId)
      if (Option.isNone(connection)) {
        // The widget callback may never have arrived: Pluggy's item events
        // are the recovery, attaching the item to the connection that
        // requested it.
        if (
          webhook.event === 'item/created' ||
          webhook.event === 'item/updated'
        )
          yield* adopt(webhook.event, itemId)
        else
          yield* Effect.logWarning(
            `Ignoring ${webhook.event} for unknown item ${itemId}`,
          )
        return
      }
      const connectionId = connection.value.id
      if (connection.value.status === 'disconnected') return

      yield* Effect.gen(function* () {
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
          case 'transactions/updated':
            if (webhook.accountId && webhook.transactionIds) {
              yield* openFinance.refreshTransactions(webhook.accountId, {
                ids: webhook.transactionIds,
              })
              return
            }
            yield* openFinance.requestSync({
              connectionId,
              ...(webhook.accountId
                ? { providerAccountId: webhook.accountId }
                : {}),
            })
            return
          case 'transactions/created':
            if (webhook.accountId && webhook.transactionsCreatedAtFrom) {
              yield* openFinance.refreshTransactions(webhook.accountId, {
                createdAtFrom: webhook.transactionsCreatedAtFrom,
              })
              return
            }
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
      }).pipe(
        Effect.catchTag('OpenFinanceError', (error) =>
          permanent.has(error.reason)
            ? Effect.logWarning(`Skipping ${webhook.event}: ${error.message}`)
            : Effect.fail(error),
        ),
        // Only an outage is worth retrying; holding the event for anything
        // else would block every later webhook behind it.
        Effect.catchTag('PluggyError', (error) =>
          Effect.gen(function* () {
            if (error.reason === 'unavailable') return yield* error
            if (error.reason !== 'not_found') {
              yield* Effect.logWarning(
                `Skipping ${webhook.event}: ${error.message}`,
              )
              return
            }
            yield* Effect.logWarning(
              `Pluggy no longer has item ${itemId}; disconnecting`,
            )
            // Pluggy already removed the item: nothing to delete there, and a
            // provider call here could hold the event forever.
            yield* openFinance.markItemDeleted(connectionId)
          }),
        ),
      )
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
