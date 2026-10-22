import * as Clock from 'effect/Clock'
import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Ref from 'effect/Ref'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'

import {
  PluggyAccount,
  PluggyBill,
  PluggyCursorPage,
  PluggyItem,
  PluggyPage,
  PluggyTransaction,
} from './PluggyApi.ts'

export class PluggyError extends Schema.TaggedError<PluggyError>()(
  'PluggyError',
  {
    operation: Schema.String,
    reason: Schema.Literals([
      'not_configured',
      'unauthorized',
      'not_found',
      'unavailable',
      'invalid',
    ]),
    status: Schema.optional(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Pluggy ${this.operation} failed: ${this.reason}${this.status ? ` (${this.status})` : ''}`
  }
}

export interface PluggyCredentials {
  readonly clientId: string
  readonly clientSecret: Redacted.Redacted
}

export interface PluggyClientShape {
  /** A 30-minute token for the Connect widget. With `itemId`, it reconnects that item. */
  readonly createConnectToken: (input: {
    readonly clientUserId: string
    readonly itemId?: string | undefined
    readonly webhookUrl?: string | undefined
  }) => Effect.Effect<string, PluggyError>
  readonly getItem: (itemId: string) => Effect.Effect<PluggyItem, PluggyError>
  readonly deleteItem: (itemId: string) => Effect.Effect<void, PluggyError>
  readonly listAccounts: (
    itemId: string,
  ) => Effect.Effect<ReadonlyArray<PluggyAccount>, PluggyError>
  /**
   * Makes Pluggy deliver every event to `url` with `Authorization: Bearer
   * <secret>`, updating the existing subscription for that URL if there is one.
   */
  readonly ensureWebhook: (input: {
    readonly url: string
    readonly secret: Redacted.Redacted
  }) => Effect.Effect<void, PluggyError>
  /** Every transaction booked in `[dateFrom, dateTo]`, following cursor pages. */
  readonly listTransactions: (
    input: TransactionQuery,
  ) => Effect.Effect<ReadonlyArray<PluggyTransaction>, PluggyError>
  /** The closed bills of a card account. */
  readonly listBills: (
    accountId: string,
  ) => Effect.Effect<ReadonlyArray<PluggyBill>, PluggyError>
}

/**
 * Which transactions of an account to read: those booked in a date range,
 * specific ids (up to 500 per request), or those created since an instant.
 */
export type TransactionQuery =
  | {
      readonly accountId: string
      readonly dateFrom: string
      readonly dateTo: string
    }
  | { readonly accountId: string; readonly ids: ReadonlyArray<string> }
  | { readonly accountId: string; readonly createdAtFrom: string }

// API keys last two hours; refresh a little early so a request never races expiry.
const apiKeyLifetime = Duration.toMillis(Duration.minutes(115))

const AuthResponse = Schema.Struct({ apiKey: Schema.String })
const Webhooks = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      url: Schema.String,
      event: Schema.String,
    }),
  ),
})
const ConnectTokenResponse = Schema.Struct({ accessToken: Schema.String })

const transient = (status: number) => status === 429 || status >= 500

const maxRateLimitWait = Duration.minutes(2)

/** How long Pluggy asks a rate-limited client to wait, from its reset headers. */
export const rateLimitWait = (
  headers: Readonly<Record<string, string | undefined>>,
) => {
  const seconds = [
    headers['retry-after'],
    headers['ratelimit-reset'],
    headers['x-ratelimit-reset'],
  ]
    .map((value) => Number(value))
    .find((value) => Number.isFinite(value) && value >= 0)
  const wait =
    seconds === undefined ? Duration.seconds(1) : Duration.seconds(seconds)
  return Duration.min(wait, maxRateLimitWait)
}

export class PluggyClient extends Context.Service<
  PluggyClient,
  PluggyClientShape
>()('@spendle/server/openfinance/PluggyClient') {
  /** Builds the client from explicit credentials; `None` disables every call. */
  static readonly make = (options: {
    readonly baseUrl: string
    readonly credentials: Option.Option<PluggyCredentials>
  }) =>
    Effect.gen(function* () {
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl(options.baseUrl)),
        HttpClient.mapRequest(HttpClientRequest.acceptJson),
      )
      const cachedKey = yield* Ref.make(
        Option.none<{ apiKey: string; expiresAt: number }>(),
      )

      const fail =
        (operation: string, reason: PluggyError['reason'], status?: number) =>
        (cause?: unknown) =>
          new PluggyError({ operation, reason, status, cause })

      const authenticate = Effect.gen(function* () {
        if (Option.isNone(options.credentials)) {
          return yield* fail('authenticate', 'not_configured')()
        }
        const now = yield* Clock.currentTimeMillis
        const cached = yield* Ref.get(cachedKey)
        if (Option.isSome(cached) && cached.value.expiresAt > now)
          return cached.value.apiKey
        const { clientId, clientSecret } = options.credentials.value
        const response = yield* HttpClientRequest.post('/auth').pipe(
          HttpClientRequest.bodyJsonUnsafe({
            clientId,
            clientSecret: Redacted.value(clientSecret),
          }),
          http.execute,
          Effect.mapError(fail('authenticate', 'unavailable')),
        )
        if (response.status === 429) {
          yield* Effect.sleep(rateLimitWait(response.headers))
          return yield* fail('authenticate', 'unavailable', 429)()
        }
        if (response.status !== 200) {
          return yield* fail(
            'authenticate',
            transient(response.status) ? 'unavailable' : 'unauthorized',
            response.status,
          )()
        }
        const { apiKey } = yield* HttpClientResponse.schemaBodyJson(
          AuthResponse,
        )(response).pipe(Effect.mapError(fail('authenticate', 'invalid')))
        yield* Ref.set(
          cachedKey,
          Option.some({ apiKey, expiresAt: now + apiKeyLifetime }),
        )
        return apiKey
      })

      // Sends an authenticated request, re-authenticating once on 401 and
      // retrying rate limits and server errors with backoff.
      const send = <S extends Schema.Top>(
        operation: string,
        request: HttpClientRequest.HttpClientRequest,
        schema: S,
      ) => {
        const attempt = Effect.gen(function* () {
          const apiKey = yield* authenticate
          const response = yield* http
            .execute(HttpClientRequest.setHeader(request, 'X-API-KEY', apiKey))
            .pipe(Effect.mapError(fail(operation, 'unavailable')))
          if (response.status === 401) {
            yield* Ref.set(cachedKey, Option.none())
            return yield* fail(operation, 'unauthorized', 401)()
          }
          if (response.status === 404)
            return yield* fail(operation, 'not_found', 404)()
          if (response.status === 429) {
            // Retrying before the window resets only burns attempts.
            yield* Effect.sleep(rateLimitWait(response.headers))
            return yield* fail(operation, 'unavailable', 429)()
          }
          if (response.status < 200 || response.status >= 300) {
            return yield* fail(
              operation,
              transient(response.status) ? 'unavailable' : 'invalid',
              response.status,
            )()
          }
          // A 204 has no body; the schema decides whether null is acceptable.
          if (response.status === 204) {
            return yield* Schema.decodeUnknownEffect(schema)(null).pipe(
              Effect.mapError(fail(operation, 'invalid', 204)),
            )
          }
          return yield* HttpClientResponse.schemaBodyJson(schema)(
            response,
          ).pipe(Effect.mapError(fail(operation, 'invalid')))
        })
        return attempt.pipe(
          Effect.retry({
            while: (error) =>
              error.reason === 'unauthorized' && error.status === 401,
            times: 1,
          }),
          Effect.retry({
            while: (error) => error.reason === 'unavailable',
            schedule: Schedule.exponential(Duration.millis(500)),
            times: 4,
          }),
          Effect.withSpan(`PluggyClient.${operation}`),
        )
      }

      const createConnectToken: PluggyClientShape['createConnectToken'] = (
        input,
      ) =>
        send(
          'createConnectToken',
          HttpClientRequest.post('/connect_token').pipe(
            HttpClientRequest.bodyJsonUnsafe({
              ...(input.itemId ? { itemId: input.itemId } : {}),
              options: {
                clientUserId: input.clientUserId,
                ...(input.webhookUrl ? { webhookUrl: input.webhookUrl } : {}),
              },
            }),
          ),
          ConnectTokenResponse,
        ).pipe(Effect.map((response) => response.accessToken))

      const getItem: PluggyClientShape['getItem'] = (itemId) =>
        send('getItem', HttpClientRequest.get(`/items/${itemId}`), PluggyItem)

      const deleteItem: PluggyClientShape['deleteItem'] = (itemId) =>
        send(
          'deleteItem',
          HttpClientRequest.delete(`/items/${itemId}`),
          Schema.Unknown,
        ).pipe(Effect.asVoid)

      const listAccounts: PluggyClientShape['listAccounts'] = (itemId) =>
        send(
          'listAccounts',
          HttpClientRequest.get('/accounts').pipe(
            HttpClientRequest.setUrlParams({ itemId }),
          ),
          PluggyPage(PluggyAccount),
        ).pipe(Effect.map((page) => page.results))

      // A page holds 500 bills, more than forty years of monthly bills.
      const listBills: PluggyClientShape['listBills'] = (accountId) =>
        send(
          'listBills',
          HttpClientRequest.get('/bills').pipe(
            HttpClientRequest.setUrlParams({ accountId }),
          ),
          PluggyPage(PluggyBill),
        ).pipe(Effect.map((page) => page.results))

      const listPages = (params: Record<string, string>) =>
        Effect.gen(function* () {
          const all: Array<PluggyTransaction> = []
          let after: string | undefined
          do {
            const page = yield* send(
              'listTransactions',
              HttpClientRequest.get('/v2/transactions').pipe(
                HttpClientRequest.setUrlParams({
                  ...params,
                  ...(after ? { after } : {}),
                }),
              ),
              PluggyCursorPage(PluggyTransaction),
            )
            all.push(...page.results)
            after = page.next
              ? (new URL(page.next, options.baseUrl).searchParams.get(
                  'after',
                ) ?? undefined)
              : undefined
          } while (after)
          return all
        })

      const listTransactions: PluggyClientShape['listTransactions'] = (
        input,
      ) => {
        if ('ids' in input) {
          const chunks: Array<ReadonlyArray<string>> = []
          for (let index = 0; index < input.ids.length; index += 500)
            chunks.push(input.ids.slice(index, index + 500))
          return Effect.map(
            Effect.forEach(chunks, (ids) =>
              listPages({ accountId: input.accountId, ids: ids.join(',') }),
            ),
            (pages) => pages.flat(),
          )
        }
        if ('createdAtFrom' in input) {
          return listPages({
            accountId: input.accountId,
            createdAtFrom: input.createdAtFrom,
          })
        }
        return listPages({
          accountId: input.accountId,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
        })
      }

      const ensureWebhook: PluggyClientShape['ensureWebhook'] = (input) =>
        Effect.gen(function* () {
          const subscription = {
            url: input.url,
            event: 'all',
            headers: {
              Authorization: `Bearer ${Redacted.value(input.secret)}`,
            },
          }
          // Pluggy answers 204 with no body when there are no subscriptions.
          const listed = yield* send(
            'listWebhooks',
            HttpClientRequest.get('/webhooks'),
            Schema.NullOr(Webhooks),
          )
          const results = listed?.results ?? []
          const existing = results.find((webhook) => webhook.url === input.url)
          yield* existing
            ? send(
                'updateWebhook',
                HttpClientRequest.patch(`/webhooks/${existing.id}`).pipe(
                  HttpClientRequest.bodyJsonUnsafe({
                    ...subscription,
                    enabled: true,
                  }),
                ),
                Schema.Unknown,
              )
            : send(
                'createWebhook',
                HttpClientRequest.post('/webhooks').pipe(
                  HttpClientRequest.bodyJsonUnsafe(subscription),
                ),
                Schema.Unknown,
              )
        })

      return PluggyClient.of({
        createConnectToken,
        ensureWebhook,
        getItem,
        deleteItem,
        listAccounts,
        listTransactions,
        listBills,
      })
    })

  /** Reads `PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET` and `PLUGGY_API_URL`. */
  static readonly layer = Layer.effect(
    PluggyClient,
    Effect.gen(function* () {
      const clientId = yield* Config.option(
        Config.NonEmptyString('PLUGGY_CLIENT_ID'),
      )
      const clientSecret = yield* Config.option(
        Config.Redacted('PLUGGY_CLIENT_SECRET'),
      )
      const baseUrl = yield* Config.String('PLUGGY_API_URL').pipe(
        Config.withDefault('https://api.pluggy.ai'),
      )
      const credentials = Option.zipWith(
        clientId,
        clientSecret,
        (id, secret) => ({
          clientId: id,
          clientSecret: secret,
        }),
      )
      return yield* PluggyClient.make({ baseUrl, credentials })
    }),
  )
}
