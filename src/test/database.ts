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
  db: AppDatabase
  schema: typeof schema
  close: () => void
  ids: TestDatabaseIds
}

interface ActiveTestDatabase {
  database: TestDatabase
  seed: TestDatabaseSeed
}

const minimalIds = {
  householdScope: 'test-scope-household',
  personScope: 'test-scope-person',
  companyScope: 'test-scope-company',
  institution: 'test-institution',
  brlAccount: 'test-account-brl',
  card: 'test-card-brl',
  cardInstrument: 'test-card-instrument',
  categories: {
    housing: 'housing',
    food: 'food',
    insurance: 'insurance',
    family: 'family',
    leisure: 'leisure',
    maintenance: 'maintenance',
    subscriptions: 'subscriptions',
    personalCare: 'personal_care',
    profitDistributionIncome: 'profit_distribution_income',
    transfer: 'transfer',
    cardPayment: 'card_payment',
    uncategorized: 'uncategorized',
  },
} satisfies TestDatabaseIds

const productionIds = {
  householdScope: 'household',
  personScope: 'donald-pf',
  companyScope: 'donald-company-br',
  institution: 'nubank',
  brlAccount: 'account-nubank-pf-6607',
  card: 'card-nu-ultravioleta',
  cardInstrument: 'instrument-nu-1889',
  categories: minimalIds.categories,
} satisfies TestDatabaseIds

let activeTestDatabase: ActiveTestDatabase | null = null

async function seedMinimalDatabase(db: AppDatabase) {
  await db.insert(schema.ownershipScopes).values([
    {
      id: minimalIds.householdScope,
      name: 'Família de teste',
      type: 'household',
    },
    {
      id: minimalIds.personScope,
      name: 'Pessoa de teste',
      type: 'person',
    },
    {
      id: minimalIds.companyScope,
      name: 'Empresa de teste',
      type: 'company_br',
    },
  ])
  await db.insert(schema.institutions).values({
    id: minimalIds.institution,
    name: 'Instituição de teste',
  })
  await db.insert(schema.accounts).values({
    id: minimalIds.brlAccount,
    ownershipScopeId: minimalIds.personScope,
    institutionId: minimalIds.institution,
    name: 'Conta BRL de teste',
    kind: 'checking',
    purpose: 'operating',
    currency: 'BRL',
  })
  await db.insert(schema.creditCards).values({
    id: minimalIds.card,
    ownershipScopeId: minimalIds.personScope,
    institutionId: minimalIds.institution,
    name: 'Cartão BRL de teste',
    currency: 'BRL',
    lastFour: '1234',
    closingDay: 5,
  })
  await db.insert(schema.creditCardInstruments).values({
    id: minimalIds.cardInstrument,
    creditCardId: minimalIds.card,
    lastFour: '1234',
    kind: 'physical',
  })
  await db.insert(schema.categories).values([
    {
      id: minimalIds.categories.housing,
      name: 'Moradia',
      bucket: 'essential',
      color: '#2563eb',
    },
    {
      id: minimalIds.categories.food,
      name: 'Alimentação',
      bucket: 'essential',
      color: '#0d9488',
    },
    {
      id: minimalIds.categories.insurance,
      name: 'Seguros',
      bucket: 'essential',
      color: '#0369a1',
    },
    {
      id: minimalIds.categories.family,
      name: 'Família e filhos',
      bucket: 'essential',
      color: '#9333ea',
    },
    {
      id: minimalIds.categories.maintenance,
      name: 'Manutenção e reparos',
      bucket: 'essential',
      color: '#64748b',
    },
    {
      id: minimalIds.categories.leisure,
      name: 'Lazer',
      bucket: 'lifestyle',
      color: '#db2777',
    },
    {
      id: minimalIds.categories.subscriptions,
      name: 'Assinaturas',
      bucket: 'lifestyle',
      color: '#c026d3',
    },
    {
      id: minimalIds.categories.personalCare,
      name: 'Cuidados pessoais',
      bucket: 'lifestyle',
      color: '#e11d48',
    },
    {
      id: minimalIds.categories.profitDistributionIncome,
      name: 'Distribuição de lucros',
      bucket: 'income',
      incomeBaseEligible: true,
      color: '#166534',
    },
    {
      id: minimalIds.categories.transfer,
      name: 'Transferência interna',
      bucket: 'excluded',
      color: '#64748b',
    },
    {
      id: minimalIds.categories.cardPayment,
      name: 'Pagamento de cartão',
      bucket: 'excluded',
      color: '#64748b',
    },
    {
      id: minimalIds.categories.uncategorized,
      name: 'Sem categoria',
      bucket: 'excluded',
      color: '#94a3b8',
    },
  ])
  await db.insert(schema.budgetStrategies).values({
    id: 'test-strategy-balanced',
    template: 'balanced',
    name: 'Estratégia de teste',
    essentialBps: 4_000,
    lifestyleBps: 2_000,
    investmentBps: 3_000,
    reserveBps: 1_000,
    isDefault: true,
  })
  await db.insert(schema.appSettings).values({ id: 'default' })
}

export async function openTestDatabase(
  options: { seed?: TestDatabaseSeed } = {},
): Promise<TestDatabase> {
  activeTestDatabase?.database.close()

  const seed = options.seed ?? 'minimal'
  const directory = mkdtempSync(join(tmpdir(), 'financas-test-'))
  const connection = openDatabase(join(directory, 'integration.db'))

  try {
    installDatabaseForTesting(
      connection,
      seed === 'production' ? seedDatabase : seedMinimalDatabase,
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
    db: connection.db,
    schema,
    ids: seed === 'production' ? productionIds : minimalIds,
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
