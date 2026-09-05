import type { AppDatabase } from './connection.server'
import * as schema from './schema'

export const qaIds = {
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
    groceries: 'groceries',
    restaurants: 'restaurants',
    delivery: 'delivery',
    shopping: 'shopping',
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
}

export async function seedQaDatabase(db: AppDatabase) {
  if (db.select().from(schema.ownershipScopes).limit(1).get()) return
  await db.insert(schema.ownershipScopes).values([
    {
      id: qaIds.householdScope,
      name: 'Família de teste',
      type: 'household',
    },
    {
      id: qaIds.personScope,
      name: 'Pessoa de teste',
      type: 'person',
    },
    {
      id: qaIds.companyScope,
      name: 'Empresa de teste',
      type: 'company_br',
    },
  ])
  await db.insert(schema.institutions).values({
    id: qaIds.institution,
    name: 'Instituição de teste',
  })
  await db.insert(schema.accounts).values({
    id: qaIds.brlAccount,
    ownershipScopeId: qaIds.personScope,
    institutionId: qaIds.institution,
    name: 'Conta BRL de teste',
    kind: 'checking',
    purpose: 'operating',
    currency: 'BRL',
  })
  await db.insert(schema.creditCards).values({
    id: qaIds.card,
    ownershipScopeId: qaIds.personScope,
    institutionId: qaIds.institution,
    name: 'Cartão BRL de teste',
    currency: 'BRL',
    lastFour: '1234',
    closingDay: 5,
  })
  await db.insert(schema.creditCardInstruments).values({
    id: qaIds.cardInstrument,
    creditCardId: qaIds.card,
    lastFour: '1234',
    kind: 'physical',
  })
  await db
    .insert(schema.categories)
    .values([
      {
        id: qaIds.categories.housing,
        name: 'Moradia',
        bucket: 'essential',
        color: '#2563eb',
      },
      {
        id: qaIds.categories.groceries,
        name: 'Mercado',
        bucket: 'essential',
        color: '#0d9488',
      },
      {
        id: qaIds.categories.restaurants,
        name: 'Restaurantes',
        bucket: 'lifestyle',
        color: '#d97706',
      },
      {
        id: qaIds.categories.delivery,
        name: 'Delivery',
        bucket: 'lifestyle',
        color: '#f97316',
      },
      {
        id: qaIds.categories.shopping,
        name: 'Compras',
        bucket: 'lifestyle',
        color: '#ea580c',
      },
      {
        id: qaIds.categories.food,
        name: 'Alimentação',
        bucket: 'essential',
        color: '#0d9488',
        active: false,
      },
      {
        id: qaIds.categories.insurance,
        name: 'Seguros',
        bucket: 'essential',
        color: '#0369a1',
      },
      {
        id: qaIds.categories.family,
        name: 'Família e filhos',
        bucket: 'essential',
        color: '#9333ea',
      },
      {
        id: qaIds.categories.maintenance,
        name: 'Manutenção e reparos',
        bucket: 'essential',
        color: '#64748b',
      },
      {
        id: qaIds.categories.leisure,
        name: 'Lazer',
        bucket: 'lifestyle',
        color: '#db2777',
      },
      {
        id: qaIds.categories.subscriptions,
        name: 'Assinaturas',
        bucket: 'lifestyle',
        color: '#c026d3',
      },
      {
        id: qaIds.categories.personalCare,
        name: 'Cuidados pessoais',
        bucket: 'lifestyle',
        color: '#e11d48',
      },
      {
        id: qaIds.categories.profitDistributionIncome,
        name: 'Distribuição de lucros',
        bucket: 'income',
        incomeBaseEligible: true,
        color: '#166534',
      },
      {
        id: qaIds.categories.transfer,
        name: 'Transferência interna',
        bucket: 'excluded',
        color: '#64748b',
      },
      {
        id: qaIds.categories.cardPayment,
        name: 'Pagamento de cartão',
        bucket: 'excluded',
        color: '#64748b',
      },
      {
        id: qaIds.categories.uncategorized,
        name: 'Sem categoria',
        bucket: 'excluded',
        color: '#94a3b8',
      },
    ])
    .onConflictDoNothing()
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
