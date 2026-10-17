import { queryOptions } from '@tanstack/react-query'
import { createIsomorphicFn } from '@tanstack/react-start'
import * as Schema from 'effect/Schema'

const ViewerSchema = Schema.Struct({
  name: Schema.String,
  email: Schema.String,
  image: Schema.NullOr(Schema.String),
})

/** Why a server function refused a call; the browser then signs in again. */
export const signedOutMessage = 'Sua sessão terminou. Entre novamente.'

/** The signed-in person, as the UI needs them. */
export type Viewer = typeof ViewerSchema.Type

const decodeViewer = Schema.decodeUnknownPromise(Schema.NullOr(ViewerSchema))

/**
 * Reads the session directly during SSR and through `/api/viewer` in the
 * browser, so both sides apply the same allowlist and QA rules.
 */
const getViewer = createIsomorphicFn()
  .server(async () => (await import('./auth.server')).readViewer())
  .client(async () => {
    const response = await fetch('/api/viewer')
    return decodeViewer(await response.json())
  })

/**
 * Loaded once per page load and kept: sign-in and sign-out reload the page,
 * and an expired session surfaces through the server-function middleware.
 */
export const viewerOptions = () =>
  queryOptions({
    queryKey: ['auth', 'viewer'],
    queryFn: () => getViewer(),
    staleTime: Infinity,
    gcTime: Infinity,
  })
