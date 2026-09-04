import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import * as schema from './schema'

export type AppDatabase = BetterSQLite3Database<typeof schema>

export interface DatabaseConnection {
  db: AppDatabase
  sqlite: Database.Database
  close: () => void
}

function resolveDatabasePath(url: string) {
  return resolve(process.cwd(), url.replace(/^file:/, ''))
}

export function openDatabase(url: string): DatabaseConnection {
  const databasePath = resolveDatabasePath(url)
  mkdirSync(dirname(databasePath), { recursive: true })

  const sqlite = new Database(databasePath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  return {
    db: drizzle(sqlite, { schema }),
    sqlite,
    close: () => {
      if (sqlite.open) sqlite.close()
    },
  }
}
