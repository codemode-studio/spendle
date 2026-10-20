import { webhookPath } from '@spendle/server/routing'
import handler from '@tanstack/react-start/server-entry'
import { env } from 'cloudflare:workers'

export { Control } from './Control.ts'
export { Space } from './Space.ts'

/**
 * The Worker: the web app answers every request but Pluggy's webhook, the
 * one API route the internet reaches, which goes to the control object.
 * Only its POST: any other method would fall through to the control
 * object's `/api` routes, which trust the member header the web app sets.
 */
export default {
  fetch(request) {
    if (
      request.method === 'POST' &&
      new URL(request.url).pathname === webhookPath
    ) {
      return env.CONTROL.getByName('control').fetch(request)
    }
    return handler.fetch(request)
  },
} satisfies ExportedHandler<Cloudflare.Env>
