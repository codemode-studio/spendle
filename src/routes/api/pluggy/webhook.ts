import { createFileRoute } from '@tanstack/react-router'

import { handlePluggyWebhookRequest } from '#/features/open-finance/webhook.server'

export const Route = createFileRoute('/api/pluggy/webhook')({
  server: {
    handlers: {
      POST: ({ request }) => handlePluggyWebhookRequest(request),
    },
  },
})
