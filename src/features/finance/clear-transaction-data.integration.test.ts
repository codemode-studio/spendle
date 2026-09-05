import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { db } from '#/db/index.server'
import * as schema from '#/db/schema'
import { resetTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import * as finance from './finance.server'
import { clearTransactionData } from './import.server'
import * as recurrence from './recurrence.server'

describe('limpeza de transações e importações', () => {
  let database: TestDatabase

  beforeEach(async () => {
    database = await resetTestDatabase()
  })

  afterEach(() => {
    database.close()
  })

  it('remove parcelamentos vinculados antes de limpar suas transações', async () => {
    const transaction = await finance.createManualTransaction({
      targetType: 'card',
      targetId: database.ids.card,
      postedAt: '2026-08-10',
      description: 'Compra parcelada',
      direction: 'outflow',
      amountCents: 50_000,
    })
    await db.insert(schema.installmentPlans).values({
      id: 'linked-plan',
      creditCardId: database.ids.card,
      sourceTransactionId: transaction.id,
      description: 'Compra parcelada',
      installmentAmountCents: 50_000,
      totalInstallments: 6,
      currentInstallment: 1,
      firstChargeDate: '2026-08-10',
    })
    await clearTransactionData()
    expect(await db.select().from(schema.transactions)).toEqual([])
    expect(await db.select().from(schema.installmentPlans)).toEqual([])
  })

  it('mantém recorrências e conhecimento e reabre ocorrências vinculadas', async () => {
    const created = await recurrence.createRecurrence({
      name: 'Netflix',
      categoryId: database.ids.categories.subscriptions,
      amountCents: 3_990,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'fixed',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2026-08-10',
    })
    const transaction = await finance.createManualTransaction({
      targetType: 'account',
      targetId: database.ids.brlAccount,
      postedAt: '2026-08-10',
      description: 'PG *NETFLIX.COM 847291',
      direction: 'outflow',
      amountCents: 3_990,
    })
    await recurrence.refreshRecurrences()
    const [match] = await db
      .select()
      .from(schema.recurrenceMatches)
      .where(eq(schema.recurrenceMatches.transactionId, transaction.id))
    await db
      .update(schema.recurrenceMatches)
      .set({ status: 'confirmed' })
      .where(eq(schema.recurrenceMatches.id, match.id))
    await db
      .update(schema.recurrenceOccurrences)
      .set({ status: 'matched', resolvedAt: new Date() })
      .where(eq(schema.recurrenceOccurrences.id, match.occurrenceId))
    await db.insert(schema.knowledgeBase).values({
      id: 'knowledge-netflix',
      kind: 'recurrence',
      signature: 'netflix com',
      pattern: 'netflix com',
      direction: 'expense',
      recurrenceId: created.id,
      sampleDescription: 'PG *NETFLIX.COM 847291',
      source: 'recurrence_link',
    })

    await clearTransactionData()

    expect(await db.select().from(schema.transactions)).toEqual([])
    expect(await db.select().from(schema.recurrenceMatches)).toEqual([])
    expect(await db.select().from(schema.recurrences)).toMatchObject([
      { id: created.id, name: 'Netflix' },
    ])
    expect(await db.select().from(schema.recurrenceOccurrences)).toMatchObject([
      { recurrenceId: created.id, status: 'expected', resolvedAt: null },
    ])
    expect(await db.select().from(schema.knowledgeBase)).toMatchObject([
      { id: 'knowledge-netflix', recurrenceId: created.id },
    ])
  })
})
