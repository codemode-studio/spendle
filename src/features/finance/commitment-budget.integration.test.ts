import { afterEach, expect, it, vi } from 'vitest'
import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import { getFinanceSnapshot } from './finance-snapshot.server'

let database: TestDatabase | undefined
afterEach(() => {
  database?.close()
  vi.useRealTimers()
})
it('a estratégia de setembro inclui a fatura de compras de agosto e preserva os registros', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-06T12:00:00Z'))
  database = await openTestDatabase()
  const { db, schema: s, ids } = database
  await db.insert(s.sourceFiles).values({
    id: 'source',
    sha256: 'synthetic',
    originalName: 'fatura.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 1,
    storagePath: database.directory + '/fatura.pdf',
  })
  await db.insert(s.imports).values({
    id: 'import',
    sourceFileId: 'source',
    creditCardId: ids.card,
    parser: 'pdf_local',
    status: 'committed',
    statementDueDate: '2026-09-09',
    balanceAsOf: '2026-09-02',
  })
  await db.insert(s.cardStatementCycles).values({
    id: 'cycle',
    creditCardId: ids.card,
    importId: 'import',
    periodStart: '2026-08-03',
    periodEnd: '2026-09-02',
    closingDate: '2026-09-02',
    dueDate: '2026-09-09',
    totalCents: 886250,
    status: 'closed',
  })
  await db.insert(s.transactions).values({
    id: 'purchase',
    importId: 'import',
    creditCardId: ids.card,
    categoryId: ids.categories.shopping,
    postedAt: '2026-08-20',
    description: 'Compra de agosto',
    normalizedDescription: 'compra de agosto',
    amountCents: -886250,
    currency: 'BRL',
    fingerprint: 'purchase',
  })
  const before = await db.select().from(s.transactions)
  const snapshot = await getFinanceSnapshot('2026-09')
  expect(snapshot.dashboard.budgetActual.lifestyle).toBe(0)
  expect(
    snapshot.dashboard.monthlyCommitments.buckets.find(
      (b) => b.bucket === 'lifestyle',
    ),
  ).toMatchObject({ dueCents: 886250, paidCents: 0 })
  expect(await db.select().from(s.transactions)).toEqual(before)
  expect(await db.select().from(s.knowledgeBase)).toEqual([])
})

it('leva recorrência de cartão cobrada após o corte para o vencimento seguinte', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-06T12:00:00Z'))
  database = await openTestDatabase()
  const { db, schema: s, ids } = database
  await db.insert(s.recurrences).values({
    id: 'subscription',
    name: 'Assinatura',
    creditCardId: ids.card,
    categoryId: ids.categories.subscriptions,
    amountCents: 7000,
    currency: 'BRL',
    direction: 'expense',
    amountMode: 'fixed',
    frequency: 'monthly',
    startsOn: '2026-09-20',
    scheduleAnchor: '2026-09-20',
    nextDate: '2026-09-20',
  })
  const september = await getFinanceSnapshot('2026-09')
  expect(
    september.dashboard.monthlyCommitments.lines.some(
      (l) => l.description === 'Assinatura',
    ),
  ).toBe(false)
  const october = await getFinanceSnapshot('2026-10')
  expect(
    october.dashboard.monthlyCommitments.lines.find(
      (l) => l.description === 'Assinatura',
    ),
  ).toMatchObject({ date: '2026-10-12', cents: 7000, certainty: 'estimated' })
})
