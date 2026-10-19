import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Result from 'effect/Result'
import * as Semaphore from 'effect/Semaphore'

import { PluggyClient } from '../openfinance/PluggyClient.ts'
import * as Webhook from '../openfinance/Webhook.ts'
import type { PluggyWebhook } from '../openfinance/Webhook.ts'
import type { PendingWebhook, Space } from './SpaceDirectory.ts'
import { SpaceDirectory } from './SpaceDirectory.ts'
import { SpaceGateway } from './SpaceGateway.ts'
import type { SpaceUnavailable } from './SpaceGateway.ts'

// What routing could decide: the spaces an event belongs to, and whether that
// answer is final. An answer is not final while a space or Pluggy could not
// be asked; the event is then kept and routed again.
interface Destination {
  readonly spaces: ReadonlyArray<Space>
  readonly final: boolean
}

const make = Effect.gen(function* () {
  const directory = yield* SpaceDirectory
  const pluggy = yield* PluggyClient
  const gateway = yield* SpaceGateway
  const wake = yield* Queue.unbounded<void>()
  const lock = yield* Semaphore.make(1)

  // Asks every space; a space that fails counts as unknown, not as "no".
  const ask = (
    spaces: ReadonlyArray<Space>,
    question: (spaceId: string) => Effect.Effect<boolean, SpaceUnavailable>,
  ) =>
    Effect.forEach(spaces, (space) =>
      question(space.id).pipe(
        Effect.map((yes) => ({ space, answer: Option.some(yes) })),
        Effect.catchCause((cause) =>
          Effect.logError(`Space ${space.id} could not be asked`, cause).pipe(
            Effect.as({ space, answer: Option.none<boolean>() }),
          ),
        ),
      ),
    ).pipe(
      Effect.map((answers) => ({
        yes: answers
          .filter((entry) => Option.getOrElse(entry.answer, () => false))
          .map((entry) => entry.space),
        complete: answers.every((entry) => Option.isSome(entry.answer)),
      })),
    )

  /**
   * - events without an item concern no space
   * - a deletion goes to every space, as before: it is kept even for an item
   *   no connection holds yet, so a late registration cannot attach it
   * - other item events go to the space whose connection holds the item, or,
   *   for an item not attached yet, to the space whose pending connection
   *   requested it (Pluggy's `clientUserId` is that connection's id)
   */
  const destinationOf = Effect.fnUntraced(function* (
    webhook: PluggyWebhook,
  ): Effect.fn.Return<Destination> {
    const itemId = webhook.itemId
    if (itemId === undefined) return { spaces: [], final: true }
    const spaces = yield* directory.list
    if (webhook.event === 'item/deleted') return { spaces, final: true }

    const holding = yield* ask(spaces, (spaceId) =>
      gateway.holdsItem(spaceId, itemId),
    )
    // Item ids are Pluggy's, so a holder found is the only one.
    if (holding.yes.length > 0) return { spaces: holding.yes, final: true }

    // Asked even when a space could not answer: a healthy space's pending
    // connection must still receive its new item.
    const item = yield* pluggy.getItem(itemId).pipe(Effect.result)
    if (Result.isFailure(item)) {
      // Only a missing item is a final answer; credentials, configuration
      // and outages can recover, so the event waits for them.
      return {
        spaces: [],
        final: holding.complete && item.failure.reason === 'not_found',
      }
    }
    const requester = item.success.clientUserId
    if (!requester) return { spaces: [], final: holding.complete }
    const requesting = yield* ask(spaces, (spaceId) =>
      gateway.hasConnection(spaceId, requester),
    )
    // Connection ids are unique, so a requester found is the only one.
    return {
      spaces: requesting.yes,
      final:
        requesting.yes.length > 0 || (holding.complete && requesting.complete),
    }
  })

  // Stores the event in each space it belongs to; true when it is done with.
  const route = Effect.fnUntraced(function* (pending: PendingWebhook) {
    const delivery = yield* Webhook.decodeDelivery(pending.payload)
    // Validated before it was stored; kept only for a payload edited by hand.
    if (Option.isNone(delivery)) {
      yield* Effect.logWarning(`Dropping unreadable webhook ${pending.eventId}`)
      yield* directory.webhookRouted(pending.eventId)
      return true
    }
    const destination = yield* destinationOf(delivery.value.webhook)
    // Each space independently: one that fails keeps the event for a retry
    // without holding back the others. Stores are idempotent by event id.
    const stored = yield* Effect.forEach(destination.spaces, (space) =>
      gateway.storeWebhook(space.id, pending.payload).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logError(
            `Webhook ${pending.eventId} not stored in space ${space.id}`,
            cause,
          ).pipe(Effect.as(false)),
        ),
      ),
    )
    const done = destination.final && stored.every(Boolean)
    if (done) yield* directory.webhookRouted(pending.eventId)
    return done
  })

  /** Routes every pending delivery it can, oldest first. */
  const drain = lock.withPermit(
    Effect.gen(function* () {
      // The data from before spaces may hold the connections these events
      // are for: they wait in the inbox until it is claimed.
      if (Option.isSome(yield* directory.unclaimedLegacy)) return
      // An event waits while an earlier one for its item does, keeping the
      // order Pluggy sent them in.
      const waiting = new Set<string>()
      for (const pending of yield* directory.pendingWebhooks) {
        if (pending.itemId !== null && waiting.has(pending.itemId)) continue
        const done = yield* route(pending).pipe(
          Effect.catchCause((cause) =>
            Effect.logError(
              `Webhook ${pending.eventId} not routed`,
              cause,
            ).pipe(Effect.as(false)),
          ),
        )
        if (!done && pending.itemId !== null) waiting.add(pending.itemId)
      }
    }),
  )

  /** Validates a delivery and keeps it in the inbox; routing happens after. */
  const accept = Effect.fn('SpaceWebhooks.accept')(function* (input: {
    readonly authorization: string | undefined
    readonly body: string
  }) {
    const parsed = yield* Webhook.parseWebhook(input)
    if (Result.isFailure(parsed)) return parsed.failure
    const received = yield* directory.receiveWebhook({
      eventId: parsed.success.webhook.eventId,
      itemId: parsed.success.webhook.itemId ?? null,
      payload: input.body,
    })
    yield* Queue.offer(wake, undefined)
    return {
      status: 202,
      body: { accepted: true, duplicate: !received },
    } satisfies Webhook.WebhookResult
  })

  // Routes on each delivery, and again every minute for what had to wait. A
  // pass that fails (the control database busy, say) is logged and the next
  // one runs as usual; only interruption stops the loop.
  yield* drain.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logError('Webhook routing failed; retrying', cause),
    ),
    Effect.andThen(Queue.take(wake).pipe(Effect.timeoutOption('1 minute'))),
    Effect.forever,
    Effect.forkScoped,
  )

  return { accept, drain }
})

/** Pluggy deliveries: kept in the control database, then routed to spaces. */
export class SpaceWebhooks extends Context.Service<
  SpaceWebhooks,
  Effect.Success<typeof make>
>()('@spendle/server/spaces/SpaceWebhooks') {
  static readonly layer = Layer.effect(SpaceWebhooks, make)
}

/** `POST /api/pluggy/webhook` for a server with one database per space. */
export const webhookRoutes = Webhook.routesWith((input) =>
  SpaceWebhooks.use((webhooks) => webhooks.accept(input)),
)
