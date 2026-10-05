import * as Effect from 'effect/Effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'
import * as Predicate from 'effect/Predicate'
import { setResponseStatus } from '@tanstack/react-start/server'

import { SpendleApi } from '@spendle/server/api'

import { apiFailureMessage } from './errors'

export type V2Client = HttpApiClient.ForApi<typeof SpendleApi>

const apiFailureTags = new Set([
  'NotFound',
  'InvalidRequest',
  'Conflict',
  'Rejected',
  'ProviderFailed',
  'Unavailable',
  'Unauthorized',
  'InternalError',
])

const statusOfTag: Record<string, number> = {
  InvalidRequest: 400,
  Unauthorized: 502,
  NotFound: 404,
  Conflict: 409,
  Rejected: 422,
  InternalError: 500,
  ProviderFailed: 502,
  Unavailable: 503,
}

/**
 * A V2 API failure as the browser receives it: the pt-BR message the UI
 * shows, plus the stable `reason` for code that branches on it.
 */
export class V2ApiError extends Error {
  constructor(
    readonly tag: string,
    readonly reason: string,
    readonly detail: string | null,
  ) {
    super(apiFailureMessage({ tag, reason, detail }))
    this.name = 'V2ApiError'
  }
}

/**
 * Where the V2 server listens and the token it expects. Read per call, on the
 * server only: the token never reaches the browser bundle.
 */
function v2Settings() {
  return {
    baseUrl: process.env.SPENDLE_API_URL || 'http://127.0.0.1:4100',
    token: process.env.SPENDLE_API_TOKEN || undefined,
  }
}

const toV2ApiError = (error: unknown): V2ApiError => {
  if (
    Predicate.hasProperty(error, '_tag') &&
    Predicate.isString(error._tag) &&
    apiFailureTags.has(error._tag) &&
    Predicate.hasProperty(error, 'reason') &&
    Predicate.isString(error.reason)
  ) {
    const detail =
      Predicate.hasProperty(error, 'detail') && Predicate.isString(error.detail)
        ? error.detail
        : null
    return new V2ApiError(error._tag, error.reason, detail)
  }
  // Transport failures (server down, refused connection) and responses the
  // contract cannot decode both mean the app cannot reach a compatible API.
  return new V2ApiError('Unavailable', 'v2_unreachable', null)
}

/**
 * Runs one or more typed V2 calls from a server function handler. Failures
 * reject with a `V2ApiError` and set the response status, so a mutation's
 * `onError` shows a message the person can act on.
 */
export async function v2<TResult, TError>(
  use: (client: V2Client) => Effect.Effect<TResult, TError>,
): Promise<TResult> {
  const { baseUrl, token } = v2Settings()
  const program = Effect.gen(function* () {
    const client = yield* HttpApiClient.make(SpendleApi, {
      transformClient: HttpClient.mapRequest((request) => {
        const located = HttpClientRequest.prependUrl(request, baseUrl)
        return token === undefined
          ? located
          : HttpClientRequest.bearerToken(located, token)
      }),
    })
    return yield* use(client)
  }).pipe(Effect.mapError(toV2ApiError), Effect.provide(FetchHttpClient.layer))
  try {
    return await Effect.runPromise(program)
  } catch (error) {
    const failure = error instanceof V2ApiError ? error : toV2ApiError(error)
    try {
      setResponseStatus(statusOfTag[failure.tag] ?? 500)
    } catch {
      // Outside a request (tests, scripts) there is no response to annotate.
    }
    throw failure
  }
}

/** Every entry matching the filters, following cursors in pages of 200. */
export function allEntries(
  client: V2Client,
  filters: Omit<
    Parameters<V2Client['entries']['list']>[0]['query'],
    'cursor' | 'limit'
  >,
) {
  return Effect.gen(function* () {
    const entries = []
    let cursor: string | undefined
    do {
      const page = yield* client.entries.list({
        query: { ...filters, limit: 200, cursor },
      })
      entries.push(...page.entries)
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    return entries
  })
}
