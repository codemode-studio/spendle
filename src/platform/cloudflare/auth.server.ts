import { env } from 'cloudflare:workers'

import type { AuthPlatform } from '../types'

export const authPlatform: AuthPlatform = {
  // A D1 database; Better Auth creates its tables there on first use.
  database: () => env.AUTH_DB,
  // CIMD's Node transport pins the resolved address so a metadata URL cannot
  // reach a private network. A Worker has no private network to reach: its
  // fetches leave through Cloudflare to the public internet. The rest of the
  // contract (HTTPS, GET or HEAD, redirects returned unfollowed) holds here.
  fetchClientMetadataResource: (input, init) => {
    const request = new Request(input, init)
    if (new URL(request.url).protocol !== 'https:') {
      throw new TypeError('CIMD metadata must be fetched over HTTPS')
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      throw new TypeError('CIMD metadata is fetched with GET or HEAD only')
    }
    return fetch(request, { redirect: 'manual' })
  },
  // Comparing the schema takes four D1 round trips, and every new isolate
  // would pay them before reading a session. The configuration only changes
  // with a deployment, so the first isolate of each version compares and
  // records the version; the others find it in one query.
  migrate: async (migrate) => {
    const version = env.CF_VERSION_METADATA.id
    const done = await env.AUTH_DB.prepare(
      'SELECT 1 FROM spendle_auth_migrations WHERE version = ?',
    )
      .bind(version)
      .first()
      // Missing until the first migration of all.
      .catch(() => null)
    if (done !== null) return
    await migrate()
    await env.AUTH_DB.batch([
      env.AUTH_DB.prepare(
        'CREATE TABLE IF NOT EXISTS spendle_auth_migrations (version TEXT PRIMARY KEY, migrated_at TEXT NOT NULL)',
      ),
      env.AUTH_DB.prepare(
        'INSERT OR IGNORE INTO spendle_auth_migrations (version, migrated_at) VALUES (?, ?)',
      ).bind(version, new Date().toISOString()),
    ])
  },
}
