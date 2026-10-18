import * as Effect from 'effect/Effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'
import * as Predicate from 'effect/Predicate'
import { getRequest, setResponseStatus } from '@tanstack/react-start/server'

import { SpaceApi, SpendleApi, memberHeader } from '@spendle/server/api'

import { readViewer } from '#/features/auth/auth.server'
import { signedOutMessage } from '#/features/auth/viewer'

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

// Points a client's requests at the API, naming the member and the token.
function locate(member: string | undefined) {
  const { baseUrl, token } = v2Settings()
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
        Effect.mapError(toV2ApiError),
        Effect.provide(FetchHttpClient.layer),
      ),
    )
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

/**
 * Runs one or more typed V2 calls from a server function handler. Failures
 * reject with a `V2ApiError` and set the response status, so a mutation's
 * `onError` shows a message the person can act on.
 */
export async function v2<TResult, TError>(
  use: (client: V2Client) => Effect.Effect<TResult, TError>,
): Promise<TResult> {
  return v2As(await memberEmail(), use)
}

/**
 * `v2` for a member identified some other way than the session cookie, such
 * as the person an MCP access token belongs to. The caller has already
 * checked that they may use Spendle.
 */
export function v2As<TResult, TError>(
  member: string | undefined,
  use: (client: V2Client) => Effect.Effect<TResult, TError>,
): Promise<TResult> {
  return run(
    Effect.flatMap(
      HttpApiClient.make(SpendleApi, { transformClient: locate(member) }),
      use,
    ),
  )
}

/** `v2` for the caller's family space and its members (`SpaceApi`). */
export async function v2Space<TResult, TError>(
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
