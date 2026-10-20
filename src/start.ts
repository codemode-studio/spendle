import { createMiddleware, createStart } from '@tanstack/react-start'
import type { CustomFetch } from '@tanstack/react-start'

import { signedOutMessage } from '#/features/auth/viewer'

/**
 * Reads answer in well under a second. One that has not answered in ten is
 * stuck on an isolate, not slow: abort it so the query retries on another
 * instead of holding the page. Writes keep waiting, since one that timed
 * out may still have been applied.
 */
const readTimeout = 10_000
const fetchWithReadTimeout: CustomFetch = (url, init) =>
  fetch(
    url,
    init?.method === 'GET'
      ? {
          ...init,
          signal: AbortSignal.any([
            ...(init.signal ? [init.signal] : []),
            AbortSignal.timeout(readTimeout),
          ]),
        }
      : init,
  )

/**
 * Every server function reads or writes financial data through the API, so
 * each call needs an allowed session. Route guards only cover page rendering.
 */
const requireViewer = createMiddleware({ type: 'function' })
  .client(async ({ next }) => {
    try {
      return await next({ fetch: fetchWithReadTimeout })
    } catch (error) {
      if (error instanceof Error && error.message === signedOutMessage) {
        window.location.assign('/entrar')
      }
      throw error
    }
  })
  .server(async ({ next }) => {
    const { readViewer } = await import('#/features/auth/auth.server')
    const viewer = await readViewer()
    if (!viewer) throw new Error(signedOutMessage)
    return next({ context: { viewer } })
  })

export const startInstance = createStart(() => ({
  functionMiddleware: [requireViewer],
}))
