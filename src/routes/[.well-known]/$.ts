import { createFileRoute } from '@tanstack/react-router'

import { getAuth } from '#/features/auth/auth.server'

/**
 * OAuth discovery at the origin root, where MCP clients look: the protected
 * resource metadata for `/api/mcp` (RFC 9728) and the authorization server
 * metadata for the `/api/auth` issuer (RFC 8414). Better Auth's plugins
 * answer both; anything else under `/.well-known` is not found.
 */
export const Route = createFileRoute('/.well-known/$')({
  server: {
    handlers: {
      GET: async ({ request }) => (await getAuth()).handler(request),
    },
  },
})
