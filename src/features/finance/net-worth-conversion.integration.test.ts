import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

describe('patrimônio em moeda-base', () => {
  const directory = mkdtempSync(join(tmpdir(), 'financas-net-worth-'))

  beforeAll(() => {
    process.env.DATABASE_URL = join(directory, 'integration.db')
    vi.resetModules()
  })

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('converte pelo câmbio mais recente e sinaliza saldo sem taxa', async () => {
    const [{ db, ensureDatabase }, schema, finance] = await Promise.all([
      import('#/db/index.server'),
      import('#/db/schema'),
      import('./finance.server'),
    ])
    await ensureDatabase()
    await finance.createAccount({
      name: 'Conta USD de teste',
      institutionName: 'Banco de teste',
      ownershipScopeId: 'household',
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

    const converted = await finance.getFinanceSnapshot('2026-08')
    expect(converted.dashboard.netWorthCents).toBe(50_000)
    expect(
      converted.dashboard.integrity.issues.find(
        (issue) => issue.code === 'missing_balance_conversion',
      ),
    ).toBeUndefined()

    await db
      .delete(schema.exchangeRates)
      .where(eq(schema.exchangeRates.id, 'usd-brl-test'))
    const missing = await finance.getFinanceSnapshot('2026-08')
    expect(missing.dashboard.netWorthCents).toBe(0)
    expect(missing.dashboard.integrity.issues).toContainEqual({
      code: 'missing_balance_conversion',
      count: 1,
      blocksClosing: false,
    })
  })

  it('converte projeções recorrentes para BRL e omite com alerta sem taxa', async () => {
    const [{ db }, schema, finance] = await Promise.all([
      import('#/db/index.server'),
      import('#/db/schema'),
      import('./finance.server'),
    ])
    await db.insert(schema.exchangeRates).values({
      id: 'usd-brl-recurrence',
      date: '2026-08-27',
      fromCurrency: 'USD',
      toCurrency: 'BRL',
      rateMicros: 5_000_000,
      source: 'manual',
    })
    const account = (
      await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(eq(schema.accounts.name, 'Conta USD de teste'))
        .limit(1)
    )[0]
    const crossMonthRecurrence = await finance.createRecurrence({
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

    const converted = await finance.getFinanceSnapshot('2026-08')
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
    const missing = await finance.getFinanceSnapshot('2026-08')
    expect(missing.dashboard.budgetProjected.essential).toBe(0)
    expect(missing.dashboard.integrity.issues).toContainEqual({
      code: 'missing_base_conversion',
      count: 1,
      blocksClosing: true,
    })

    await finance.deleteRecurrence(crossMonthRecurrence.id)
    await finance.createRecurrence({
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

    const sameMonthMissing = await finance.getFinanceSnapshot('2026-08')
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
    const historicalBaseWithoutCurrentRate =
      await finance.getFinanceSnapshot('2026-08')
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
