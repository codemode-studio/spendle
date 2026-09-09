import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import {
  getFinanceSnapshot,
  getStrategyHistory,
} from './finance-snapshot.server'
import { stageImport } from './import-stage.server'
import { commitImport, confirmImportCoverage } from './import-commit.server'

let testDb: TestDatabase | undefined
afterEach(() => {
  testDb?.close()
  vi.useRealTimers()
})
describe('family month across reads', () => {
  it('projects cash using balances and unpaid commitments, never the budget base or paid expenses twice', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-08T12:00:00Z'))
    testDb = await openTestDatabase()
    const { db, schema: s, ids } = testDb
    await db
      .update(s.accounts)
      .set({ statementBalanceCents: 100000, statementBalanceAt: '2026-08-31' })
      .where(eq(s.accounts.id, ids.brlAccount))
    await db.insert(s.transactions).values([
      {
        id: 'income',
        accountId: ids.brlAccount,
        categoryId: ids.categories.uncategorized,
        postedAt: '2026-09-07',
        description: 'Entrada recebida',
        normalizedDescription: 'entrada recebida',
        amountCents: 20000,
        currency: 'BRL',
        status: 'confirmed',
        fingerprint: 'income',
      },
      {
        id: 'paid',
        accountId: ids.brlAccount,
        categoryId: ids.categories.groceries,
        postedAt: '2026-09-07',
        description: 'Mercado pago',
        normalizedDescription: 'mercado pago',
        amountCents: -3000,
        currency: 'BRL',
        status: 'confirmed',
        fingerprint: 'paid',
      },
    ])
    await db.insert(s.recurrences).values([
      {
        id: 'future-income',
        name: 'Recebimento futuro',
        accountId: ids.brlAccount,
        categoryId: ids.categories.uncategorized,
        amountCents: 10000,
        currency: 'BRL',
        direction: 'income',
        amountMode: 'fixed',
        frequency: 'monthly',
        startsOn: '2026-09-20',
        scheduleAnchor: '2026-09-20',
        nextDate: '2026-09-20',
      },
      {
        id: 'future-expense',
        name: 'Internet',
        accountId: ids.brlAccount,
        categoryId: ids.categories.housing,
        amountCents: 5000,
        currency: 'BRL',
        direction: 'expense',
        amountMode: 'fixed',
        frequency: 'monthly',
        startsOn: '2026-09-20',
        scheduleAnchor: '2026-09-20',
        nextDate: '2026-09-20',
      },
    ])
    const before = db.select().from(s.transactions).all()
    const dashboard = (await getFinanceSnapshot('2026-09')).dashboard
    expect(dashboard.familyMonth.cashFlow).toMatchObject({
      cashCents: 117000,
      expectedIncomeCents: 10000,
      remainingExpenseCents: 5000,
      closingCashCents: 122000,
    })
    expect(dashboard.baseIncomeCents).toBe(6000000)
    expect(db.select().from(s.transactions).all()).toEqual(before)
    expect(db.select().from(s.knowledgeBase).all()).toEqual([])
  })
  it('separates confirmed account receipts from the budget base and eligible income without changing records', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-08T12:00:00Z'))
    testDb = await openTestDatabase()
    const { db, schema, ids } = testDb
    await db.insert(schema.transactions).values([
      {
        id: 'external',
        accountId: ids.brlAccount,
        categoryId: ids.categories.uncategorized,
        postedAt: '2026-09-07',
        description: 'Recebimento externo',
        normalizedDescription: 'recebimento externo',
        amountCents: 12345,
        currency: 'BRL',
        status: 'confirmed',
        fingerprint: 'external',
      },
      {
        id: 'transfer',
        accountId: ids.brlAccount,
        categoryId: ids.categories.transfer,
        postedAt: '2026-09-07',
        description: 'Transferência própria',
        normalizedDescription: 'transferencia propria',
        amountCents: 67890,
        currency: 'BRL',
        status: 'confirmed',
        fingerprint: 'transfer',
      },
    ])
    const before = db.select().from(schema.transactions).all()
    const current = (await getFinanceSnapshot('2026-09')).dashboard
    expect(current.confirmedIncomeCents).toBe(12345)
    expect(current.familyMonth.incomeCents).toBe(12345)
    expect(current.currentIncomeCents).toBe(0)
    expect(current.baseIncomeCents).toBe(6000000)
    expect(current.familyMonth.plannedIncomeCents).toBe(6000000)
    vi.setSystemTime(new Date('2026-10-08T12:00:00Z'))
    const history = await getStrategyHistory({ months: 1 })
    expect(history[0].familyMonth.incomeCents).toBe(12345)
    expect(db.select().from(schema.transactions).all()).toEqual(before)
    expect(db.select().from(schema.knowledgeBase).all()).toEqual([])
  })
  it('counts an open card CSV once in its due month and shares totals with history', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-08T12:00:00Z'))
    testDb = await openTestDatabase()
    const { db, schema, ids } = testDb
    const { importId } = await stageImport({
      file: new File(
        [
          'Data,Descrição,Débito,Crédito\n2026-08-20,Compra teste,123.45,\n2026-08-21,Estorno teste,,1.01',
        ],
        'compras.csv',
      ),
      targetType: 'card',
      targetId: ids.card,
      aiConsent: false,
    })
    await confirmImportCoverage({
      importId,
      periodStart: '2026-08-06',
      periodEnd: '2026-09-05',
    })
    await commitImport(importId)
    const originalTransactions = db.select().from(schema.transactions).all()
    const originalImports = db.select().from(schema.imports).all()
    const september = (await getFinanceSnapshot('2026-09')).dashboard
      .familyMonth
    expect(september.knownExpenseCents).toBe(12244)
    expect(september.expenseCents).toBe(12244)
    expect(
      (await getFinanceSnapshot('2026-08')).dashboard.familyMonth.expenseCents,
    ).toBe(0)
    expect(
      db
        .select()
        .from(schema.transactions)
        .all()
        .every((t) => t.status === 'pending'),
    ).toBe(true)
    vi.setSystemTime(new Date('2026-10-08T12:00:00Z'))
    const history = await getStrategyHistory({ months: 1 })
    const historical = (await getFinanceSnapshot('2026-09')).dashboard
      .familyMonth
    expect(history[0].familyMonth).toEqual({ ...historical, lines: [] })
    expect(historical.expenseCents).toBe(12244)
    expect(db.select().from(schema.transactions).all()).toEqual(
      originalTransactions,
    )
    expect(db.select().from(schema.imports).all()).toEqual(originalImports)
    expect(db.select().from(schema.knowledgeBase).all()).toEqual([])
  })
})
