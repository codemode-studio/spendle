import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { openDatabase } from '../src/db/connection.server'
import { seedQaDatabase } from '../src/db/qa-seed.server'

const directory = mkdtempSync(join(tmpdir(), 'financas-doctor-'))
const connection = openDatabase(join(directory, 'check.db'))
try {
  const expectedNode = execFileSync('node', ['--version'], {
    encoding: 'utf8',
  }).trim()
  console.log(
    `Node ${expectedNode}; pnpm ${execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim()}`,
  )
  migrate(connection.db, { migrationsFolder: resolve('drizzle') })
  await seedQaDatabase(connection.db)
  if ((connection.sqlite.pragma('foreign_key_check') as unknown[]).length)
    throw new Error('Foreign key violations')
  await import('@firecrawl/pdf-inspector')
  if (!existsSync('src/features/finance/fixtures/synthetic-mercado-pago.pdf'))
    throw new Error('Missing synthetic PDF fixture')
  console.log(
    'SQLite native binding, migrations, synthetic seed, PDF native binding and fixture: OK',
  )
} finally {
  connection.close()
  rmSync(directory, { recursive: true, force: true })
}
