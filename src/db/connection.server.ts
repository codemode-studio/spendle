import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from './schema'
import { normalizeDescription } from '#/domain/finance'
import { knowledgePattern } from '#/domain/knowledge-pattern'
import { merchantSignature } from '#/domain/recurrence-book'

export type AppDatabase = BetterSQLite3Database<typeof schema>

export interface DatabaseConnection {
  db: AppDatabase
  sqlite: Database.Database
  close: () => void
}

function resolveDatabasePath(url: string) {
  return resolve(process.cwd(), url.replace(/^file:/, ''))
}

export function openDatabase(
  url: string,
  options: { onQuery?: (query: string) => void } = {},
): DatabaseConnection {
  const databasePath = resolveDatabasePath(url)
  mkdirSync(dirname(databasePath), { recursive: true })

  const sqlite = new Database(databasePath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.function('normalize_description', { deterministic: true }, (value) =>
    normalizeDescription(String(value ?? '')),
  )
  // Usada pela migração 0034 e por consultas da base de conhecimento.
  sqlite.function('merchant_signature', { deterministic: true }, (value) =>
    merchantSignature(String(value ?? '')),
  )
  // Usada pela migração 0036 (padrões da base de conhecimento).
  sqlite.function('knowledge_pattern', { deterministic: true }, (value) =>
    knowledgePattern(String(value ?? '')),
  )

  return {
    db: drizzle(sqlite, {
      schema,
      logger: options.onQuery ? { logQuery: options.onQuery } : undefined,
    }),
    sqlite,
    close: () => {
      if (sqlite.open) sqlite.close()
    },
  }
}
