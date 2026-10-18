import { createFileRoute } from '@tanstack/react-router'

import { getAuth } from '#/features/auth/auth.server'

const handle = async (request: Request) => (await getAuth()).handler(request)

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
})
