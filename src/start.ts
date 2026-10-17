import { createMiddleware, createStart } from '@tanstack/react-start'

const signedOut = 'Sua sessão terminou. Entre novamente.'

/**
 * Every server function reads or writes financial data through the V2 API, so
 * each call needs an allowed session. Route guards only cover page rendering.
 */
const requireViewer = createMiddleware({ type: 'function' })
  .client(async ({ next }) => {
    try {
      return await next()
    } catch (error) {
      if (error instanceof Error && error.message === signedOut) {
        window.location.assign('/entrar')
      }
      throw error
    }
  })
  .server(async ({ next }) => {
    const { readViewer } = await import('#/features/auth/auth.server')
    const viewer = await readViewer()
    if (!viewer) throw new Error(signedOut)
    return next({ context: { viewer } })
  })

export const startInstance = createStart(() => ({
  functionMiddleware: [requireViewer],
}))
