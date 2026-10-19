import * as Effect from 'effect/Effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientError from 'effect/http/HttpClientError'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'
import * as Predicate from 'effect/Predicate'
import { getRequest, setResponseStatus } from '@tanstack/react-start/server'

import { SpaceApi, SpendleApi, memberHeader } from '@spendle/server/api'

import { readViewer } from '#/features/auth/auth.server'
import { apiPlatform } from '#/platform/api.server'
import { signedOutMessage } from '#/features/auth/viewer'

import { apiFailureMessage } from './errors'

export type ApiClient = HttpApiClient.ForApi<typeof SpendleApi>

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
 * An API failure as the browser receives it: the pt-BR message the UI
 * shows, plus the stable `reason` for code that branches on it.
 */
export class ApiRequestError extends Error {
  constructor(
    readonly tag: string,
    readonly reason: string,
    readonly detail: string | null,
  ) {
    super(apiFailureMessage({ tag, reason, detail }))
    this.name = 'ApiRequestError'
  }
}

/**
 * The signed-in email the API scopes the call to. Outside a request (tests,
 * scripts) there is none and the call goes without it; inside one, a session
 * that ended since the middleware's check signs the person out.
 */
async function memberEmail() {
  try {
    getRequest()
  } catch {
    return undefined
  }
  const viewer = await readViewer()
  if (viewer === null) throw new Error(signedOutMessage)
  return viewer.email
}

const toApiRequestError = (error: unknown): ApiRequestError => {
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
    return new ApiRequestError(error._tag, error.reason, detail)
  }
  // The API refuses an upload past its size limit before reading it, so the
  // 413 carries no failure body.
  if (
    HttpClientError.isHttpClientError(error) &&
    'response' in error.reason &&
    error.reason.response.status === 413
  ) {
    return new ApiRequestError('InvalidRequest', 'file_too_large', null)
  }
  // Transport failures (server down, refused connection) and responses the
  // contract cannot decode both mean the app cannot reach a compatible API.
  return new ApiRequestError('Unavailable', 'api_unreachable', null)
}

// Points a client's requests at the API, naming the member and the token.
// Read per call, on the server only: the token never reaches the browser.
function locate(member: string | undefined) {
  const { baseUrl, token } = apiPlatform.settings()
  return HttpClient.mapRequest((request) => {
    let located = HttpClientRequest.prependUrl(request, baseUrl)
    if (member !== undefined) {
      located = HttpClientRequest.setHeader(located, memberHeader, member)
    }
    return token === undefined
      ? located
      : HttpClientRequest.bearerToken(located, token)
  })
}

async function run<TResult, TError>(
  program: Effect.Effect<TResult, TError, HttpClient.HttpClient>,
): Promise<TResult> {
  try {
    return await Effect.runPromise(
      program.pipe(
        Effect.mapError(toApiRequestError),
        Effect.provide(apiPlatform.httpClient),
      ),
    )
  } catch (error) {
    const failure =
      error instanceof ApiRequestError ? error : toApiRequestError(error)
    try {
      setResponseStatus(statusOfTag[failure.tag] ?? 500)
    } catch {
      // Outside a request (tests, scripts) there is no response to annotate.
    }
    throw failure
  }
}

/**
 * Runs one or more typed API calls from a server function handler. Failures
 * reject with a `ApiRequestError` and set the response status, so a mutation's
 * `onError` shows a message the person can act on.
 */
export async function api<TResult, TError>(
  use: (client: ApiClient) => Effect.Effect<TResult, TError>,
): Promise<TResult> {
  return apiAs(await memberEmail(), use)
}

/**
 * `api` for a member identified some other way than the session cookie, such
 * as the person an MCP access token belongs to. The caller has already
 * checked that they may use Spendle.
 */
export function apiAs<TResult, TError>(
  member: string | undefined,
  use: (client: ApiClient) => Effect.Effect<TResult, TError>,
): Promise<TResult> {
  return run(
    Effect.flatMap(
      HttpApiClient.make(SpendleApi, { transformClient: locate(member) }),
      use,
    ),
  )
}

/** `api` for the caller's family space and its members (`SpaceApi`). */
export async function spaceApi<TResult, TError>(
  use: (
    client: HttpApiClient.ForApi<typeof SpaceApi>,
  ) => Effect.Effect<TResult, TError>,
): Promise<TResult> {
  const member = await memberEmail()
  return run(
    Effect.flatMap(
      HttpApiClient.make(SpaceApi, { transformClient: locate(member) }),
      use,
    ),
  )
}

/** Every entry matching the filters, following cursors in pages of 200. */
export function allEntries(
  client: ApiClient,
  filters: Omit<
    Parameters<ApiClient['entries']['list']>[0]['query'],
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
