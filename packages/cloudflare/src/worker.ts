import { webhookPath } from '@spendle/server/durable'
import handler from '@tanstack/react-start/server-entry'
import { env } from 'cloudflare:workers'

export { Control } from './Control.ts'
export { Space } from './Space.ts'

/**
 * The Worker: the web app answers every request but Pluggy's webhook, the
 * one API route the internet reaches, which goes to the control object.
 */
export default {
  fetch(request) {
    if (new URL(request.url).pathname === webhookPath) {
      return env.CONTROL.getByName('control').fetch(request)
    }
    return handler.fetch(request)
  },
} satisfies ExportedHandler<Cloudflare.Env>
