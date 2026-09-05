import { dirname, resolve } from 'node:path'

import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

import { openDatabase } from './connection.server'
import type { AppDatabase, DatabaseConnection } from './connection.server'
import { repairImportProvenance } from './import-provenance-repair.server'
import { seedDatabase } from './seed.server'
import { seedQaDatabase } from './qa-seed.server'

type DatabaseSeeder = (db: AppDatabase) => Promise<void>

interface DatabaseState {
  connection: DatabaseConnection
  initialization: Promise<void> | null
  seed: DatabaseSeeder
}

let productionState: DatabaseState | null = null
let testState: DatabaseState | null = null

function createState(connection: DatabaseConnection, seed: DatabaseSeeder) {
  return { connection, initialization: null, seed }
}

function getProductionState() {
  if (process.env.VITEST) {
    throw new Error(
      'Tests must install an isolated database with openTestDatabase().',
    )
  }
  productionState ??= createState(
    openDatabase(process.env.DATABASE_URL || './data/financas.db'),
    process.env.FINANCAS_QA === '1' ? seedQaDatabase : seedDatabase,
  )
  return productionState
}

function getActiveState() {
  return testState ?? getProductionState()
}

function getActiveDatabase() {
  return getActiveState().connection.db
}

export const db = new Proxy({} as AppDatabase, {
  get(_target, property) {
    const activeDatabase = getActiveDatabase()
    const value = Reflect.get(activeDatabase, property, activeDatabase)
    return typeof value === 'function' ? value.bind(activeDatabase) : value
  },
})

export function getImportsDirectory() {
  return resolve(dirname(getActiveState().connection.sqlite.name), 'imports')
}

export function ensureDatabase() {
  const state = getActiveState()
  state.initialization ??= (async () => {
    migrate(state.connection.db, {
      migrationsFolder: resolve(process.cwd(), 'drizzle'),
    })
    await state.seed(state.connection.db)
    await repairImportProvenance(state.connection.db)
    const foreignKeyErrors = state.connection.sqlite.pragma(
      'foreign_key_check',
    ) as Array<unknown>
    if (foreignKeyErrors.length) {
      throw new Error('A migração deixou referências inválidas no banco local.')
    }
  })().catch((error) => {
    state.initialization = null
    throw error
  })
  return state.initialization
}

export function installDatabaseForTesting(
  connection: DatabaseConnection,
  seed: DatabaseSeeder,
) {
  if (testState) {
    throw new Error('Já existe um banco de teste ativo neste processo.')
  }
  testState = createState(connection, seed)
}

export function releaseDatabaseForTesting(connection: DatabaseConnection) {
  if (testState?.connection === connection) testState = null
}
