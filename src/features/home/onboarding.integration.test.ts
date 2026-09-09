import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { openTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import { getOnboardingStatus } from './onboarding.server'

let database: TestDatabase | undefined
afterEach(() => database?.close())

describe('onboarding status', () => {
  it('requires recorded transactions before completing categorization, and ignores excluded rows', async () => {
    database = await openTestDatabase()
    const { db, schema, ids } = database
    expect(await getOnboardingStatus()).toMatchObject({
      accounts: true,
      transactions: false,
      categories: false,
      recurrences: false,
    })
    db.insert(schema.transactions)
      .values({
        id: 'setup-expense',
        accountId: ids.brlAccount,
        fingerprint: 'setup-expense',
        postedAt: '2026-08-15',
        description: 'Despesa de teste',
        normalizedDescription: 'despesa de teste',
        amountCents: -1001,
        baseAmountCents: -1001,
        currency: 'BRL',
        status: 'confirmed',
      })
      .run()
    expect(await getOnboardingStatus()).toMatchObject({
      transactions: true,
      categories: false,
      uncategorizedCount: 1,
    })
    db.update(schema.transactions)
      .set({ categoryId: ids.categories.groceries })
      .where(eq(schema.transactions.id, 'setup-expense'))
      .run()
    expect(await getOnboardingStatus()).toMatchObject({
      categories: true,
      uncategorizedCount: 0,
    })
    db.update(schema.transactions)
      .set({ status: 'excluded', categoryId: null })
      .where(eq(schema.transactions.id, 'setup-expense'))
      .run()
    expect(await getOnboardingStatus()).toMatchObject({
      transactions: false,
      categories: false,
      uncategorizedCount: 0,
    })
  })

  it('counts active setup items, without treating inactive recurrences as complete', async () => {
    database = await openTestDatabase()
    const { db, schema } = database
    db.update(schema.accounts).set({ active: false }).run()
    expect((await getOnboardingStatus()).accounts).toBe(true)
    db.update(schema.creditCards).set({ active: false }).run()
    expect((await getOnboardingStatus()).accounts).toBe(false)
    db.insert(schema.recurrences)
      .values({
        id: 'setup-recurring',
        name: 'Internet QA',
        amountCents: 10000,
        frequency: 'monthly',
        nextDate: '2026-10-01',
        active: false,
      })
      .run()
    expect((await getOnboardingStatus()).recurrences).toBe(false)
    db.update(schema.recurrences).set({ active: true }).run()
    expect((await getOnboardingStatus()).recurrences).toBe(true)
  })
})
