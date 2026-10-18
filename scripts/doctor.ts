import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

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
