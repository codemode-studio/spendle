import { createFileRoute } from '@tanstack/react-router'

import { handleMcpRequest } from '#/features/mcp/endpoint.server'

// Stateless MCP: no server-initiated stream to open and no session to end.
const postOnly = () =>
  new Response(null, { status: 405, headers: { Allow: 'POST' } })

/** Spendle's MCP server for AI clients; see `features/mcp`. */
export const Route = createFileRoute('/api/mcp')({
  server: {
    handlers: {
      POST: ({ request }) => handleMcpRequest(request),
      GET: postOnly,
      DELETE: postOnly,
    },
  },
})
