import { oauthProviderClient } from '@better-auth/oauth-provider/client'
import { createAuthClient } from 'better-auth/react'

/**
 * Talks to `/api/auth` on the app's own origin. The OAuth provider plugin
 * sends the signed authorization request of the page (`/entrar`,
 * `/autorizar`) along with sign-in and consent, so an MCP client's sign-in
 * continues where it started.
 */
export const authClient = createAuthClient({
  plugins: [oauthProviderClient()],
})
