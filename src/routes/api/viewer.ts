import { createFileRoute } from '@tanstack/react-router'

import { readViewerWithSpace } from '#/features/auth/viewer.server'

/** The browser's view of the session; null when signed out or not allowed. */
export const Route = createFileRoute('/api/viewer')({
  server: {
    handlers: {
      GET: async () => Response.json(await readViewerWithSpace()),
    },
  },
})
