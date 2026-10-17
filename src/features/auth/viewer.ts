import { queryOptions } from '@tanstack/react-query'
import { createIsomorphicFn } from '@tanstack/react-start'
import * as Schema from 'effect/Schema'

const PersonSchema = Schema.Struct({
  name: Schema.String,
  email: Schema.String,
  image: Schema.NullOr(Schema.String),
})

/** Who signed in, as the session says. */
export type Person = typeof PersonSchema.Type

const ViewerSchema = Schema.Struct({
  ...PersonSchema.fields,
  /** The family space they see; null while it cannot be read. */
  spaceId: Schema.NullOr(Schema.String),
})

/** Why a server function refused a call; the browser then signs in again. */
export const signedOutMessage = 'Sua sessão terminou. Entre novamente.'

/** The signed-in person and their space, as the UI needs them. */
export type Viewer = typeof ViewerSchema.Type

const decodeViewer = Schema.decodeUnknownPromise(Schema.NullOr(ViewerSchema))

/**
 * Reads the session directly during SSR and through `/api/viewer` in the
 * browser, so both sides apply the same allowlist and QA rules.
 */
const getViewer = createIsomorphicFn()
  .server(async () => (await import('./viewer.server')).readViewerWithSpace())
  .client(async () => {
    const response = await fetch('/api/viewer')
    return decodeViewer(await response.json())
  })

/**
 * Loaded with the page and read again when the tab regains focus, so a tab
 * notices a sign-out or a move to another family space (see `app-shell`).
 * Navigation reuses the cached value.
 */
export const viewerOptions = () =>
  queryOptions({
    queryKey: ['auth', 'viewer'],
    queryFn: () => getViewer(),
    staleTime: 0,
    gcTime: Infinity,
    refetchOnWindowFocus: true,
  })
