import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import * as schema from '#/db/schema'
import { shiftDays } from '#/domain/period'
import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import {
  linkCardStatementPayment,
  listCardStatementPaymentCandidates,
  unlinkCardStatementPayment,
} from './card-statement-payment.server'
import { createManualTransaction } from './finance.server'
import { getConfigurationSnapshot } from './finance-snapshot.server'

describe('vínculo manual de pagamento de fatura', () => {
  let database: TestDatabase

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  afterAll(() => database.close())

  it('lista débitos perto do vencimento, vincula, reclassifica e desfaz', async () => {
    const before = await getConfigurationSnapshot()
    const dueDate = before.cards.find((row) => row.id === database.ids.card)!
      .currentStatement.dueDate
    const debit = await createManualTransaction({
      targetType: 'account',
      targetId: database.ids.brlAccount,
      postedAt: shiftDays(dueDate, 1),
      description: 'Débito genérico',
      direction: 'outflow',
      amountCents: 50_000,
      categoryId: 'groceries',
    })

    const candidates = await listCardStatementPaymentCandidates({
      creditCardId: database.ids.card,
      dueDate,
      amountCents: 50_000,
    })
    expect(candidates[0]).toMatchObject({
      id: debit.id,
      amountDifferenceCents: 0,
      daysApart: 1,
      linkedToDueDate: null,
    })

    const link = await linkCardStatementPayment({
      creditCardId: database.ids.card,
      dueDate,
      transactionId: debit.id,
    })
    const [reclassified] = await database.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, debit.id))
    expect(reclassified.categoryId).toBe('card_payment')

    const afterLink = await listCardStatementPaymentCandidates({
      creditCardId: database.ids.card,
      dueDate,
    })
    expect(afterLink.some((row) => row.id === debit.id)).toBe(false)

    const snapshot = await getConfigurationSnapshot()
    const card = snapshot.cards.find((row) => row.id === database.ids.card)
    const statement = card?.statements.find((row) => row.dueDate === dueDate)
    expect(statement?.payments).toEqual([
      expect.objectContaining({
        transactionId: debit.id,
        kind: 'manual',
        linkId: link.id,
      }),
    ])

    await unlinkCardStatementPayment({ id: link.id })
    const [restored] = await database.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, debit.id))
    expect(restored.categoryId).toBe('groceries')
  })

  it('recusa entradas e lançamentos de cartão', async () => {
    const income = await createManualTransaction({
      targetType: 'account',
      targetId: database.ids.brlAccount,
      postedAt: '2026-09-10',
      description: 'Entrada',
      direction: 'inflow',
      amountCents: 1_000,
    })
    await expect(
      linkCardStatementPayment({
        creditCardId: database.ids.card,
        dueDate: '2026-09-09',
        transactionId: income.id,
      }),
    ).rejects.toThrow('débito')
  })
})
