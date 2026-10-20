import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { fetchClientMetadataResource } from '@better-auth/cimd/node'

import type { AuthPlatform } from './types'

export const authPlatform: AuthPlatform = {
  // A SQLite file; QA runs keep theirs in the run directory.
  database: () => {
    const path =
      process.env.SPENDLE_AUTH_DATABASE_PATH || 'data/auth/auth.sqlite'
    mkdirSync(dirname(path), { recursive: true })
    return new DatabaseSync(path)
  },
  fetchClientMetadataResource,
  // Comparing a local file's schema costs next to nothing; do it each start.
  migrate: (migrate) => migrate(),
}
