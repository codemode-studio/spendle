import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openDatabase } from '#/db/connection.server'
import type { DatabaseConnection } from '#/db/connection.server'
import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'

const migrationsFolder = resolve(process.cwd(), 'drizzle')

interface JournalEntry {
  tag: string
}

function readJournal() {
  return JSON.parse(
    readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] } & Record<string, unknown>
}

/** Copies the migrations folder as it existed when `lastTag` was the head. */
function migrationsThrough(directory: string, lastTag: string) {
  const journal = readJournal()
  const last = journal.entries.findIndex((entry) => entry.tag === lastTag)
  expect(last).toBeGreaterThanOrEqual(0)
  const entries = journal.entries.slice(0, last + 1)
  const folder = join(directory, `migrations-${lastTag}`)
  mkdirSync(join(folder, 'meta'), { recursive: true })
  for (const entry of entries) {
    copyFileSync(
      join(migrationsFolder, `${entry.tag}.sql`),
      join(folder, `${entry.tag}.sql`),
    )
  }
  writeFileSync(
    join(folder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries }),
  )
  return folder
}

function tableShape(connection: DatabaseConnection) {
  const tables = connection.sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name",
    )
    .all() as Array<{ name: string }>
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      (
        connection.sqlite.pragma(`table_info(${name})`) as Array<{
          name: string
          type: string
          notnull: number
        }>
      )
        .map((column) => `${column.name}:${column.type}:${column.notnull}`)
        .sort(),
    ]),
  )
}

describe('migration order', () => {
  let database: TestDatabase
  const connections: DatabaseConnection[] = []

  beforeEach(async () => {
    database = await openTestDatabase()
  })

  afterEach(() => {
    for (const connection of connections.splice(0)) connection.close()
    database.close()
  })

  function open(name: string) {
    const connection = openDatabase(join(database.directory, name))
    connections.push(connection)
    return connection
  }

  it('upgrades a database migrated at the Pluggy base to the same schema as a fresh one', () => {
    const upgraded = open('base.db')
    migrate(upgraded.db, {
      migrationsFolder: migrationsThrough(
        database.directory,
        '0040_open_finance_pluggy',
      ),
    })
    expect(() => migrate(upgraded.db, { migrationsFolder })).not.toThrow()

    const fresh = open('fresh.db')
    migrate(fresh.db, { migrationsFolder })

    const upgradedShape = tableShape(upgraded)
    expect(upgradedShape).toEqual(tableShape(fresh))
    expect(upgradedShape.open_finance_accounts).toEqual(
      expect.arrayContaining([
        'history_start:TEXT:0',
        'history_bootstrap:TEXT:0',
      ]),
    )
    expect(upgradedShape.card_statement_payments).toBeDefined()
    expect(upgradedShape.investment_positions).toBeDefined()
    // A returning Pluggy payload is observed again as a new version.
    const versionIndex = (
      upgraded.sqlite.pragma(
        'index_list(open_finance_transaction_observations)',
      ) as Array<{ name: string; unique: number }>
    ).find((index) => index.name === 'open_finance_observation_version_idx')
    expect(versionIndex?.unique).toBe(0)
  })
})
