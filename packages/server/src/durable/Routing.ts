import { webhookPath } from '../openfinance/WebhookPath.ts'

// What the Worker needs to route a request without loading the server.

export { webhookPath }

/**
 * Whether a member's space answers `pathname` itself, so a caller that knows
 * the space can skip the control object. The control object keeps the space
 * directory (`/api/space`), the health check, the API document and Pluggy's
 * webhook.
 */
export const servedBySpace = (pathname: string) =>
  pathname.startsWith('/api/') &&
  pathname !== '/api/space' &&
  !pathname.startsWith('/api/space/') &&
  pathname !== '/api/health' &&
  pathname !== '/api/openapi.json' &&
  pathname !== webhookPath
