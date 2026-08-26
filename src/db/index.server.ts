import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

import { strategyPresets } from '#/domain/finance'
import { repairImportProvenance } from './import-provenance-repair.server'
import * as schema from './schema'

const configuredPath = process.env.DATABASE_URL || './data/financas.db'
const databasePath = resolve(
  process.cwd(),
  configuredPath.replace(/^file:/, ''),
)
mkdirSync(dirname(databasePath), { recursive: true })

const sqlite = new Database(databasePath)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')

export const db = drizzle(sqlite, { schema })

let initialization: Promise<void> | null = null

export function ensureDatabase() {
  initialization ??= (async () => {
    migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') })
    await seedDatabase()
    await repairImportProvenance(db)
    const foreignKeyErrors = sqlite.pragma(
      'foreign_key_check',
    ) as Array<unknown>
    if (foreignKeyErrors.length) {
      throw new Error('A migração deixou referências inválidas no banco local.')
    }
  })().catch((error) => {
    initialization = null
    throw error
  })
  return initialization
}

async function seedDatabase() {
  await db
    .insert(schema.ownershipScopes)
    .values([
      { id: 'household', name: 'Família', type: 'household' },
      { id: 'donald-pf', name: 'Donald PF', type: 'person' },
      {
        id: 'donald-company-br',
        name: 'Donald Lourenço Silveira Consultoria de Informática LTDA',
        type: 'company_br',
      },
    ])
    .onConflictDoNothing()

  await db
    .insert(schema.institutions)
    .values([
      { id: 'nubank', name: 'Nubank' },
      { id: 'inter', name: 'Inter' },
      { id: 'mercado-pago', name: 'Mercado Pago' },
      { id: 'btg', name: 'BTG' },
    ])
    .onConflictDoNothing()

  await db
    .insert(schema.accounts)
    .values([
      {
        id: 'account-nubank-pf-6607',
        ownershipScopeId: 'donald-pf',
        institutionId: 'nubank',
        name: 'Nubank PF •6607',
        kind: 'checking',
        purpose: 'operating',
        currency: 'BRL',
        externalId: '6607',
      },
      {
        id: 'account-inter-pf-0532',
        ownershipScopeId: 'donald-pf',
        institutionId: 'inter',
        name: 'Inter PF •0532',
        kind: 'checking',
        purpose: 'operating',
        currency: 'BRL',
        externalId: '0532',
      },
      {
        id: 'account-mercado-pago-pf-9508',
        ownershipScopeId: 'donald-pf',
        institutionId: 'mercado-pago',
        name: 'Mercado Pago PF •9508',
        kind: 'checking',
        purpose: 'operating',
        currency: 'BRL',
        externalId: '9508',
      },
      {
        id: 'account-inter-pj-2673',
        ownershipScopeId: 'donald-company-br',
        institutionId: 'inter',
        name: 'Inter PJ •2673',
        kind: 'checking',
        purpose: 'operating',
        currency: 'BRL',
        externalId: '2673',
      },
      {
        id: 'account-btg-joint-investment',
        ownershipScopeId: 'household',
        institutionId: 'btg',
        name: 'BTG compartilhada',
        kind: 'investment',
        purpose: 'investment',
        currency: 'BRL',
      },
      {
        id: 'account-inter-investments',
        ownershipScopeId: 'donald-pf',
        institutionId: 'inter',
        name: 'Inter investimentos',
        kind: 'investment',
        purpose: 'investment',
        currency: 'BRL',
      },
    ])
    .onConflictDoNothing()

  await db
    .insert(schema.creditCards)
    .values([
      {
        id: 'card-nu-ultravioleta',
        ownershipScopeId: 'donald-pf',
        institutionId: 'nubank',
        name: 'Nu Ultravioleta •1889',
        currency: 'BRL',
        lastFour: '1889',
        closingDay: 2,
      },
      {
        id: 'card-inter-black',
        ownershipScopeId: 'donald-pf',
        institutionId: 'inter',
        name: 'Inter Black •3879',
        currency: 'BRL',
        lastFour: '3879',
        closingDay: 9,
      },
    ])
    .onConflictDoNothing()

  await db
    .insert(schema.creditCardInstruments)
    .values([
      {
        id: 'instrument-nu-1889',
        creditCardId: 'card-nu-ultravioleta',
        lastFour: '1889',
        kind: 'physical',
      },
      {
        id: 'instrument-nu-2923',
        creditCardId: 'card-nu-ultravioleta',
        lastFour: '2923',
        kind: 'virtual',
      },
      {
        id: 'instrument-nu-8590',
        creditCardId: 'card-nu-ultravioleta',
        lastFour: '8590',
        kind: 'virtual',
      },
      {
        id: 'instrument-inter-3879',
        creditCardId: 'card-inter-black',
        lastFour: '3879',
        kind: 'physical',
      },
      {
        id: 'instrument-inter-1574',
        creditCardId: 'card-inter-black',
        lastFour: '1574',
        kind: 'virtual',
      },
    ])
    .onConflictDoNothing()

  await db
    .insert(schema.appSettings)
    .values({ id: 'default' })
    .onConflictDoNothing()

  const categorySeeds = [
    ['housing', 'Moradia', 'essential', '#2563eb'],
    ['utilities', 'Contas e serviços', 'essential', '#0284c7'],
    ['food', 'Alimentação', 'essential', '#0d9488'],
    ['transport', 'Transporte', 'essential', '#0891b2'],
    ['health', 'Saúde', 'essential', '#dc2626'],
    ['education', 'Educação', 'essential', '#7c3aed'],
    ['insurance', 'Seguros', 'essential', '#0369a1'],
    ['family', 'Família e filhos', 'essential', '#9333ea'],
    ['leisure', 'Lazer', 'lifestyle', '#db2777'],
    ['shopping', 'Compras', 'lifestyle', '#ea580c'],
    ['travel', 'Viagens', 'lifestyle', '#4f46e5'],
    ['subscriptions', 'Assinaturas', 'lifestyle', '#c026d3'],
    ['personal_care', 'Cuidados pessoais', 'lifestyle', '#e11d48'],
    ['pets', 'Pets', 'lifestyle', '#ca8a04'],
    ['gifts_donations', 'Presentes e doações', 'lifestyle', '#be123c'],
    ['maintenance', 'Manutenção e reparos', 'essential', '#64748b'],
    ['fees_interest', 'Tarifas e juros', 'tax', '#9f1239'],
    ['other_expense', 'Outras despesas', 'lifestyle', '#78716c'],
    ['investment', 'Investimentos', 'investment', '#16a34a'],
    ['reserve', 'Reserva', 'reserve', '#059669'],
    ['salary', 'Renda familiar', 'income', '#15803d'],
    [
      'profit_distribution_income',
      'Distribuição de lucros',
      'income',
      '#166534',
    ],
    ['services_income', 'Serviços e trabalhos extras', 'income', '#047857'],
    ['rental_income', 'Aluguéis recebidos', 'income', '#0f766e'],
    ['investment_income', 'Rendimentos de investimentos', 'income', '#166534'],
    ['reimbursements', 'Reembolsos e restituições', 'income', '#15803d'],
    ['asset_sales', 'Venda de bens', 'income', '#4d7c0f'],
    ['other_income', 'Outras receitas', 'income', '#3f6212'],
    ['business', 'Empresa', 'business', '#475569'],
    ['tax', 'Impostos', 'tax', '#b91c1c'],
    ['transfer', 'Transferência interna', 'excluded', '#64748b'],
    ['card_payment', 'Pagamento de cartão', 'excluded', '#64748b'],
    ['uncategorized', 'Sem categoria', 'excluded', '#94a3b8'],
  ] as const

  await db
    .insert(schema.categories)
    .values(
      categorySeeds.map(([id, name, bucket, color]) => ({
        id,
        name,
        bucket,
        color,
      })),
    )
    .onConflictDoNothing()

  for (const [template, preset] of Object.entries(strategyPresets)) {
    await db
      .insert(schema.budgetStrategies)
      .values({
        id: `strategy-${template}`,
        template: template as keyof typeof strategyPresets,
        name: preset.name,
        essentialBps: preset.allocation.essential,
        lifestyleBps: preset.allocation.lifestyle,
        investmentBps: preset.allocation.investment,
        reserveBps: preset.allocation.reserve,
        isDefault: template === 'balanced',
      })
      .onConflictDoNothing()
  }

  const emergencyGoal = await db
    .select({ id: schema.investmentGoals.id })
    .from(schema.investmentGoals)
    .where(eq(schema.investmentGoals.type, 'emergency_reserve'))
    .limit(1)

  if (!emergencyGoal.length) {
    await db.insert(schema.investmentGoals).values({
      id: 'goal-emergency-reserve',
      name: 'Reserva de emergência',
      type: 'emergency_reserve',
      targetCents: 0,
      priority: 1,
    })
  }

  await db
    .update(schema.accounts)
    .set({ ownershipScopeId: 'household' })
    .where(eq(schema.accounts.ownershipScopeId, 'donald-dayane-joint'))
  await db
    .update(schema.creditCards)
    .set({ ownershipScopeId: 'household' })
    .where(eq(schema.creditCards.ownershipScopeId, 'donald-dayane-joint'))
  await db
    .delete(schema.ownershipScopes)
    .where(eq(schema.ownershipScopes.id, 'donald-dayane-joint'))
}
