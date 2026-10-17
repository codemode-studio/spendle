import { createAuthClient } from 'better-auth/react'

/** Talks to `/api/auth` on the app's own origin. */
export const authClient = createAuthClient()
