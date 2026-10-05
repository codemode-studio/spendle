import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import * as finance from './finance.server'
import { getFinanceSnapshot } from './finance-snapshot.server'
import * as recurrence from './recurrence.server'

describe('patrimônio em moeda-base', () => {
  let database: TestDatabase

  beforeEach(async () => {
    database = await resetTestDatabase()
  })

  afterEach(() => {
    database.close()
  })

  it('converte pelo câmbio mais recente e sinaliza saldo sem taxa', async () => {
    const { db, ids, schema } = database
    await finance.createAccount({
      name: 'Conta USD de teste',
      institutionName: 'Banco de teste',
      ownershipScopeId: ids.householdScope,
      kind: 'checking',
      purpose: 'operating',
      currency: 'USD',
      initialBalanceCents: 10_000,
    })
    await db.insert(schema.exchangeRates).values({
      id: 'usd-brl-test',
      date: '2026-08-27',
      fromCurrency: 'USD',
      toCurrency: 'BRL',
      rateMicros: 5_000_000,
      source: 'manual',
    })

    const converted = await getFinanceSnapshot('2026-08')
    expect(converted.dashboard.netWorthCents).toBe(50_000)
    expect(
      converted.dashboard.integrity.issues.find(
        (issue) => issue.code === 'missing_balance_conversion',
      ),
    ).toBeUndefined()

    await db
      .delete(schema.exchangeRates)
      .where(eq(schema.exchangeRates.id, 'usd-brl-test'))
    const missing = await getFinanceSnapshot('2026-08')
    expect(missing.dashboard.netWorthCents).toBe(0)
    expect(missing.dashboard.integrity.issues).toContainEqual({
      code: 'missing_balance_conversion',
      count: 1,
      blocksClosing: false,
    })
  })

  it('converte projeções recorrentes para BRL e omite com alerta sem taxa', async () => {
    const { db, ids, schema } = database
    const account = await finance.createAccount({
      name: 'Conta USD de teste',
      institutionName: 'Banco de teste',
      ownershipScopeId: ids.householdScope,
      kind: 'checking',
      purpose: 'operating',
      currency: 'USD',
      initialBalanceCents: 10_000,
    })
    await db.insert(schema.exchangeRates).values({
      id: 'usd-brl-recurrence',
      date: '2026-08-27',
      fromCurrency: 'USD',
      toCurrency: 'BRL',
      rateMicros: 5_000_000,
      source: 'manual',
    })
    const crossMonthRecurrence = await recurrence.createRecurrence({
      name: 'Despesa em dólar',
      categoryId: 'housing',
      amountCents: 10_000,
      currency: 'USD',
      direction: 'expense',
      amountMode: 'fixed',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2026-08-01',
    })
    await db.insert(schema.transactions).values({
      id: 'pending-usd-july',
      accountId: account.id,
      categoryId: 'housing',
      fingerprint: 'pending-usd-july',
      postedAt: '2026-07-31',
      description: 'Despesa em dólar',
      normalizedDescription: 'despesa em dolar',
      amountCents: -10_000,
      currency: 'USD',
      status: 'pending',
    })

    const converted = await getFinanceSnapshot('2026-08')
    expect(converted.dashboard.budgetProjected.essential).toBe(50_000)
    expect(
      converted.recurrences.find((item) => item.name === 'Despesa em dólar')
        ?.baseAmountCents,
    ).toBe(50_000)
    expect(
      converted.dashboard.integrity.issues.find(
        (issue) => issue.code === 'missing_base_conversion',
      ),
    ).toBeUndefined()

    await db
      .delete(schema.exchangeRates)
      .where(eq(schema.exchangeRates.id, 'usd-brl-recurrence'))
    const missing = await getFinanceSnapshot('2026-08')
    expect(missing.dashboard.budgetProjected.essential).toBe(0)
    expect(missing.dashboard.integrity.issues).toContainEqual({
      code: 'missing_base_conversion',
      count: 1,
      blocksClosing: true,
    })

    await recurrence.deleteRecurrence(crossMonthRecurrence.id)
    await recurrence.createRecurrence({
      name: 'Despesa em dólar no mês',
      categoryId: 'housing',
      amountCents: 20_000,
      currency: 'USD',
      direction: 'expense',
      amountMode: 'fixed',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2026-08-15',
    })
    await db.insert(schema.transactions).values({
      id: 'pending-usd-august',
      accountId: account.id,
      categoryId: 'housing',
      fingerprint: 'pending-usd-august',
      postedAt: '2026-08-15',
      description: 'Despesa em dólar no mês',
      normalizedDescription: 'despesa em dolar no mes',
      amountCents: -20_000,
      currency: 'USD',
      status: 'pending',
    })

    const sameMonthMissing = await getFinanceSnapshot('2026-08')
    expect(sameMonthMissing.dashboard.budgetProjected.essential).toBe(0)
    expect(
      sameMonthMissing.dashboard.integrity.issues.find(
        (issue) => issue.code === 'missing_base_conversion',
      ),
    ).toEqual({
      code: 'missing_base_conversion',
      count: 1,
      blocksClosing: true,
    })

    await db
      .update(schema.transactions)
      .set({ baseAmountCents: -100_000, exchangeRateMicros: 5_000_000 })
      .where(eq(schema.transactions.id, 'pending-usd-august'))
    const historicalBaseWithoutCurrentRate = await getFinanceSnapshot('2026-08')
    expect(
      historicalBaseWithoutCurrentRate.dashboard.budgetProjected.essential,
    ).toBe(0)
    expect(
      historicalBaseWithoutCurrentRate.dashboard.integrity.issues.find(
        (issue) => issue.code === 'missing_base_conversion',
      ),
    ).toEqual({
      code: 'missing_base_conversion',
      count: 1,
      blocksClosing: true,
    })
  })
})
