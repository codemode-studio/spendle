import { qaIds, seedQaDatabase } from '#/db/qa-seed.server'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AppDatabase } from '#/db/connection.server'
import { openDatabase } from '#/db/connection.server'
import {
  ensureDatabase,
  installDatabaseForTesting,
  releaseDatabaseForTesting,
} from '#/db/index.server'
import * as schema from '#/db/schema'
import { seedDatabase } from '#/db/seed.server'

export type TestDatabaseSeed = 'production' | 'minimal'

export interface TestDatabaseIds {
  householdScope: string
  personScope: string
  companyScope: string
  institution: string
  brlAccount: string
  card: string
  cardInstrument: string
  categories: {
    housing: string
    food: string
    groceries: string
    restaurants: string
    delivery: string
    shopping: string
    insurance: string
    family: string
    leisure: string
    maintenance: string
    subscriptions: string
    personalCare: string
    profitDistributionIncome: string
    transfer: string
    cardPayment: string
    uncategorized: string
  }
}

export interface TestDatabase {
  directory: string
  db: AppDatabase
  schema: typeof schema
  close: () => void
  ids: TestDatabaseIds
}

interface ActiveTestDatabase {
  database: TestDatabase
  seed: TestDatabaseSeed
}

const productionIds = {
  householdScope: 'household',
  personScope: 'donald-pf',
  companyScope: 'donald-company-br',
  institution: 'nubank',
  brlAccount: 'account-nubank-pf-6607',
  card: 'card-nu-ultravioleta',
  cardInstrument: 'instrument-nu-1889',
  categories: qaIds.categories,
} satisfies TestDatabaseIds

let activeTestDatabase: ActiveTestDatabase | null = null

export async function openTestDatabase(
  options: { seed?: TestDatabaseSeed; onQuery?: (query: string) => void } = {},
): Promise<TestDatabase> {
  activeTestDatabase?.database.close()

  const seed = options.seed ?? 'minimal'
  const directory = mkdtempSync(join(tmpdir(), 'financas-test-'))
  const connection = openDatabase(join(directory, 'integration.db'), {
    onQuery: options.onQuery,
  })

  try {
    installDatabaseForTesting(
      connection,
      seed === 'production' ? seedDatabase : seedQaDatabase,
    )
    await ensureDatabase()
  } catch (error) {
    releaseDatabaseForTesting(connection)
    connection.close()
    rmSync(directory, { recursive: true, force: true })
    throw error
  }

  let closed = false
  const database: TestDatabase = {
    directory,
    db: connection.db,
    schema,
    ids: seed === 'production' ? productionIds : qaIds,
    close() {
      if (closed) return
      closed = true
      releaseDatabaseForTesting(connection)
      connection.close()
      rmSync(directory, { recursive: true, force: true })
      if (activeTestDatabase?.database === database) {
        activeTestDatabase = null
      }
    },
  }
  activeTestDatabase = { database, seed }
  return database
}

export async function resetTestDatabase(): Promise<TestDatabase> {
  const seed = activeTestDatabase?.seed ?? 'minimal'
  activeTestDatabase?.database.close()
  return openTestDatabase({ seed })
}
