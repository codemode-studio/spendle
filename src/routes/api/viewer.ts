import { createFileRoute } from '@tanstack/react-router'

import { readViewer } from '#/features/auth/auth.server'

/** The browser's view of the session; null when signed out or not allowed. */
export const Route = createFileRoute('/api/viewer')({
  server: {
    handlers: {
      GET: async () => Response.json(await readViewer()),
    },
  },
})
