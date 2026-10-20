import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'
import type * as HttpServerError from 'effect/http/HttpServerError'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'

import { OpenFinance } from '../openfinance/OpenFinance.ts'
import * as Webhook from '../openfinance/Webhook.ts'

/** A space that could not answer: its database failed to open, or its object is unreachable. */
export class SpaceUnavailable extends Schema.TaggedError<SpaceUnavailable>()(
  'SpaceUnavailable',
  { spaceId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Space ${this.spaceId} is unavailable`
  }
}

/**
 * What the server asks of one space: to answer an API request, and the
 * questions webhook routing needs. Spaces are either built in this process
 * (`LocalSpaces.gateway`) or run elsewhere, one Durable Object each (`remote`).
 */
export interface SpaceGatewayShape {
  /** Answers the current `/api` request from the space. */
  readonly serve: (
    spaceId: string,
  ) => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    SpaceUnavailable | HttpServerError.HttpServerError,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >
  /** Whether one of the space's connections holds Pluggy item `itemId`. */
  readonly holdsItem: (
    spaceId: string,
    itemId: string,
  ) => Effect.Effect<boolean, SpaceUnavailable>
  /** Whether the space has the connection a new Pluggy item was requested for. */
  readonly hasConnection: (
    spaceId: string,
    connectionId: string,
  ) => Effect.Effect<boolean, SpaceUnavailable>
  /** Stores a validated Pluggy delivery in the space's event log. */
  readonly storeWebhook: (
    spaceId: string,
    body: string,
  ) => Effect.Effect<void, SpaceUnavailable>
}

// The questions, as a space answers them over its own services.
export const holdsItem = (itemId: string) =>
  OpenFinance.use((openFinance) => openFinance.connectionByItem(itemId)).pipe(
    Effect.map(Option.isSome),
  )

export const hasConnection = (connectionId: string) =>
  OpenFinance.use((openFinance) => openFinance.connection(connectionId)).pipe(
    Effect.as(true),
    Effect.catchTag('OpenFinanceError', () => Effect.succeed(false)),
  )

// The control server validated the body before keeping it.
export const storeWebhook = (body: string) =>
  Webhook.decodeDelivery(body).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die(`Unreadable webhook body: ${body}`),
        onSome: (delivery) => Webhook.storeWebhook(delivery),
      }),
    ),
    Effect.asVoid,
  )

// Any failure but interruption means the space could not answer.
export const unavailable =
  (spaceId: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, SpaceUnavailable, R> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.fail(
              new SpaceUnavailable({ spaceId, cause: Cause.squash(cause) }),
            ),
      ),
    )

/** How a process reaches spaces that run elsewhere, one Durable Object each. */
export interface RemoteSpaces {
  readonly fetch: (spaceId: string, request: Request) => Promise<Response>
  readonly holdsItem: (spaceId: string, itemId: string) => Promise<boolean>
  readonly hasConnection: (
    spaceId: string,
    connectionId: string,
  ) => Promise<boolean>
  readonly storeWebhook: (spaceId: string, body: string) => Promise<void>
}

export class SpaceGateway extends Context.Service<
  SpaceGateway,
  SpaceGatewayShape
>()('@spendle/server/spaces/SpaceGateway') {
  /** Spaces that answer elsewhere, through `spaces`. */
  static readonly remote = (spaces: RemoteSpaces) =>
    Layer.succeed(
      SpaceGateway,
      SpaceGateway.of({
        serve: (spaceId) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const web = yield* HttpServerRequest.toWeb(request)
            const response = yield* Effect.promise(() =>
              spaces.fetch(spaceId, web),
            )
            // Handed back as the runtime's own response, so its body streams
            // straight to the caller. Re-streaming it through Effect here
            // held finished answers in this object for up to a minute.
            // The copy makes the headers writable for whatever wraps it.
            return HttpServerResponse.raw(new Response(response.body, response))
          }).pipe(unavailable(spaceId)),
        holdsItem: (spaceId, itemId) =>
          Effect.promise(() => spaces.holdsItem(spaceId, itemId)).pipe(
            unavailable(spaceId),
          ),
        hasConnection: (spaceId, connectionId) =>
          Effect.promise(() =>
            spaces.hasConnection(spaceId, connectionId),
          ).pipe(unavailable(spaceId)),
        storeWebhook: (spaceId, body) =>
          Effect.promise(() => spaces.storeWebhook(spaceId, body)).pipe(
            unavailable(spaceId),
          ),
      }),
    )
}
