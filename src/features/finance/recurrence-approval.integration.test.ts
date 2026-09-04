import { eq } from 'drizzle-orm'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import { isAcceptedRecurrenceMatchStatus } from '#/domain/recurrence-book'
import { resetTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import * as finance from './finance.server'
import { getFinanceSnapshot } from './finance-snapshot.server'
import * as recurrenceServer from './recurrence.server'

describe('aprovação de recorrências detectadas', () => {
  const today = '2026-09-04'
  let database: TestDatabase

  beforeAll(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(`${today}T12:00:00Z`))
  })

  beforeEach(async () => {
    database = await resetTestDatabase()
  })

  afterEach(() => {
    database.close()
  })

  afterAll(() => {
    vi.useRealTimers()
  })

  it('alinha o histórico anual e ignora períodos passados sem pagamento', async () => {
    const { ids } = database
    const payments = await Promise.all(
      [
        { id: 'older', postedAt: '2024-12-31' },
        { id: 'newer', postedAt: '2026-01-01' },
      ].map(({ id, postedAt }) =>
        finance.createManualTransaction({
          targetType: 'account',
          targetId: ids.brlAccount,
          postedAt,
          description: `Seguro anual ${id}`,
          direction: 'outflow',
          amountCents: 12_345,
        }),
      ),
    )

    const approved = await recurrenceServer.approveDetectedRecurrence({
      name: 'Seguro anual',
      categoryId: ids.categories.insurance,
      amountCents: 12_345,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'fixed',
      frequency: 'yearly',
      nextDate: '2027-01-16',
      transactionIds: payments.map((payment) => payment.id),
    })

    const snapshot = await getFinanceSnapshot()
    const recurrence = snapshot.recurrences.find(
      (item) => item.id === approved.id,
    )
    const acceptedMatches =
      recurrence?.occurrences.flatMap((occurrence) =>
        occurrence.matches.filter((match) =>
          isAcceptedRecurrenceMatchStatus(match.status),
        ),
      ) ?? []

    expect(recurrence?.startsOn).toBe('2024-01-16')
    expect(acceptedMatches).toHaveLength(2)
    expect(
      new Set(acceptedMatches.map((match) => match.transactionId)),
    ).toEqual(new Set(payments.map((payment) => payment.id)))
    expect(
      recurrence?.occurrences.filter(
        (occurrence) =>
          occurrence.status === 'expected' && occurrence.expectedDate < today,
      ),
    ).toEqual([])
    expect(snapshot.dashboard.integrity.issues).not.toContainEqual(
      expect.objectContaining({ code: 'overdue_recurrence' }),
    )
  })

  it('bloqueia um reembolso que também pertence a uma transferência ativa', async () => {
    const { db, ids, schema } = database
    const recurrence = await recurrenceServer.createRecurrence({
      name: 'Serviço conciliado',
      categoryId: ids.categories.subscriptions,
      amountCents: 4_321,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'fixed',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: today,
    })
    const payment = await finance.createManualTransaction({
      targetType: 'account',
      targetId: ids.brlAccount,
      postedAt: today,
      description: 'Serviço conciliado',
      direction: 'outflow',
      amountCents: 4_321,
    })
    const occurrence = (
      await db
        .select()
        .from(schema.recurrenceOccurrences)
        .where(eq(schema.recurrenceOccurrences.recurrenceId, recurrence.id))
    ).find((item) => item.expectedDate === today)
    expect(occurrence).toBeDefined()

    await db.insert(schema.reconciliationGroups).values([
      {
        id: 'mixed-refund',
        type: 'refund',
        status: 'confirmed',
        confidence: 100,
      },
      {
        id: 'mixed-transfer',
        type: 'transfer',
        status: 'suggested',
        confidence: 100,
      },
    ])
    await db.insert(schema.reconciliationLinks).values([
      {
        id: 'mixed-refund-link',
        groupId: 'mixed-refund',
        transactionId: payment.id,
        role: 'refund',
      },
      {
        id: 'mixed-transfer-link',
        groupId: 'mixed-transfer',
        transactionId: payment.id,
        role: 'source',
      },
    ])

    const candidates = await recurrenceServer.listLinkCandidates({
      occurrenceId: occurrence!.id,
      today,
    })
    expect(candidates.map((candidate) => candidate.id)).not.toContain(
      payment.id,
    )
    await expect(
      recurrenceServer.linkTransactions({
        occurrenceId: occurrence!.id,
        transactionIds: [payment.id],
      }),
    ).rejects.toThrow('Resolva primeiro a conciliação financeira')
  })
})
