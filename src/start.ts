import { createMiddleware, createStart } from '@tanstack/react-start'

import { signedOutMessage } from '#/features/auth/viewer'

/**
 * Every server function reads or writes financial data through the API, so
 * each call needs an allowed session. Route guards only cover page rendering.
 */
const requireViewer = createMiddleware({ type: 'function' })
  .client(async ({ next }) => {
    try {
      return await next()
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
