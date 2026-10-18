import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

const vp = execFileSync('vp', ['--version'], { encoding: 'utf8' })
console.log(`Node ${process.version}; ${vp.split('\n')[0]}`)

// The API server stores everything in SQLite through `node:sqlite`.
const sqlite = new DatabaseSync(':memory:')
try {
  const row = sqlite.prepare('select sqlite_version() as version').get()
  console.log(`SQLite ${String(row?.version)} (node:sqlite): OK`)
} finally {
  sqlite.close()
}

// PDF statements are read by a native binding the server depends on.
const serverRequire = createRequire(resolve('packages/server/package.json'))
await import(
  pathToFileURL(serverRequire.resolve('@firecrawl/pdf-inspector')).href
)
console.log('PDF native binding: OK')
