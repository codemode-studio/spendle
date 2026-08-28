import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

describe('reconciliação de recorrências', () => {
  const directory = mkdtempSync(join(tmpdir(), 'financas-recurrence-match-'))

  beforeAll(() => {
    process.env.DATABASE_URL = join(directory, 'integration.db')
    vi.resetModules()
  })

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('confirma e desfaz um vínculo restaurando a categoria anterior', async () => {
    const [{ ensureDatabase }, finance, recurrenceMatching] = await Promise.all(
      [
        import('#/db/index.server'),
        import('./finance.server'),
        import('./recurrence-refresh.server'),
      ],
    )
    await ensureDatabase()
    const recurrence = await finance.createRecurrence({
      name: 'Netflix',
      categoryId: 'subscriptions',
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
      targetId: 'account-nubank-pf-6607',
      postedAt: '2026-08-10',
      description: 'PG *NETFLIX.COM 847291',
      direction: 'outflow',
      amountCents: 3_990,
    })

    const suggestedSnapshot = await finance.getFinanceSnapshot('2026-08')
    const suggestedMatch = suggestedSnapshot.recurrences
      .find((item) => item.id === recurrence.id)
      ?.occurrences.flatMap((occurrence) => occurrence.matches)
      .find((match) => match.status === 'suggested')
    expect(suggestedMatch).toMatchObject({
      transactionId: transaction.id,
      score: 90,
    })

    await recurrenceMatching.confirmRecurrenceMatch(suggestedMatch!.id)
    const confirmedSnapshot = await finance.getFinanceSnapshot('2026-08')
    expect(
      confirmedSnapshot.recurrences.find((item) => item.id === recurrence.id)
        ?.nextDate,
    ).toBe('2026-09-10')
    expect(
      confirmedSnapshot.transactions.find((item) => item.id === transaction.id)
        ?.categoryId,
    ).toBe('subscriptions')
    expect(confirmedSnapshot.dashboard.budgetActual.lifestyle).toBe(3_990)
    await expect(
      recurrenceMatching.rejectRecurrenceMatch(suggestedMatch!.id),
    ).rejects.toThrow('Somente sugestões abertas')
    await expect(finance.deleteRecurrence(recurrence.id)).rejects.toThrow(
      'Desvincule os pagamentos confirmados',
    )

    await recurrenceMatching.unlinkRecurrenceMatch(suggestedMatch!.id)
    const unlinkedSnapshot = await finance.getFinanceSnapshot('2026-08')
    expect(
      unlinkedSnapshot.transactions.find((item) => item.id === transaction.id)
        ?.categoryId,
    ).toBe('uncategorized')
    expect(unlinkedSnapshot.dashboard.budgetActual.lifestyle).toBe(0)
    expect(
      unlinkedSnapshot.recurrences.find((item) => item.id === recurrence.id)
        ?.nextDate,
    ).toBe('2026-08-10')
    await expect(
      recurrenceMatching.refreshRecurrenceSuggestions(),
    ).resolves.toBeDefined()
    const refreshedSnapshot = await finance.getFinanceSnapshot('2026-08')
    expect(
      refreshedSnapshot.recurrences
        .find((item) => item.id === recurrence.id)
        ?.occurrences.flatMap((item) => item.matches)
        .filter((match) => match.status === 'suggested'),
    ).toHaveLength(0)
    await expect(finance.deleteRecurrence(recurrence.id)).resolves.toEqual({
      id: recurrence.id,
    })
  })

  it('avança o calendário ao ignorar a próxima ocorrência', async () => {
    const [finance, recurrenceMatching] = await Promise.all([
      import('./finance.server'),
      import('./recurrence-refresh.server'),
    ])
    const recurrence = await finance.createRecurrence({
      name: 'Compromisso sem pagamento',
      categoryId: 'housing',
      amountCents: 20_000,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'fixed',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2026-08-31',
    })
    const snapshot = await finance.getFinanceSnapshot('2026-08')
    const occurrence = snapshot.recurrences
      .find((item) => item.id === recurrence.id)
      ?.occurrences.find((item) => item.expectedDate === '2026-08-31')

    await recurrenceMatching.skipRecurrenceOccurrence(occurrence!.id)

    const skippedSnapshot = await finance.getFinanceSnapshot('2026-08')
    expect(
      skippedSnapshot.recurrences.find((item) => item.id === recurrence.id)
        ?.nextDate,
    ).toBe('2026-09-30')
  })

  it('não duplica uma pendência categorizada na projeção recorrente', async () => {
    const [finance, database, schema] = await Promise.all([
      import('./finance.server'),
      import('#/db/index.server'),
      import('#/db/schema'),
    ])
    await finance.createRecurrence({
      name: 'Netflix',
      categoryId: 'subscriptions',
      amountCents: 20_000,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'variable',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2026-08-10',
    })
    await database.db.insert(schema.transactions).values({
      id: 'pending-netflix',
      accountId: 'account-nubank-pf-6607',
      categoryId: 'subscriptions',
      fingerprint: 'pending-netflix',
      postedAt: '2026-08-10',
      description: 'Netflix',
      normalizedDescription: 'netflix',
      amountCents: -20_800,
      currency: 'BRL',
      status: 'pending',
    })

    const snapshot = await finance.getFinanceSnapshot('2026-08')

    expect(snapshot.dashboard.budgetProjected.lifestyle).toBe(20_800)
  })

  it('pausa sugestões e resolve conflito quando a categoria é corrigida', async () => {
    const [finance, recurrenceMatching] = await Promise.all([
      import('./finance.server'),
      import('./recurrence-refresh.server'),
    ])
    const recurrence = await finance.createRecurrence({
      name: 'Spotify',
      categoryId: 'subscriptions',
      amountCents: 2_190,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'fixed',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2026-08-15',
    })
    await finance.createManualTransaction({
      targetType: 'account',
      targetId: 'account-nubank-pf-6607',
      postedAt: '2026-08-15',
      description: 'Spotify',
      direction: 'outflow',
      amountCents: 2_190,
      categoryId: 'food',
    })
    const suggested = await finance.getFinanceSnapshot('2026-08')
    const match = suggested.recurrences
      .find((item) => item.id === recurrence.id)
      ?.occurrences.flatMap((item) => item.matches)
      .find((item) => item.status === 'suggested')

    await finance.setRecurrenceActive({ id: recurrence.id, active: false })
    const paused = await finance.getFinanceSnapshot('2026-08')
    expect(paused.dashboard.budgetProjected.lifestyle).toBe(
      suggested.dashboard.budgetProjected.lifestyle - 2_190,
    )
    await expect(
      recurrenceMatching.confirmRecurrenceMatch(match!.id),
    ).rejects.toThrow('Reative a recorrência')
    await finance.setRecurrenceActive({ id: recurrence.id, active: true })
    await recurrenceMatching.confirmRecurrenceMatch(match!.id)

    const conflicted = await finance.getFinanceSnapshot('2026-08')
    expect(
      conflicted.recurrences
        .find((item) => item.id === recurrence.id)
        ?.occurrences.flatMap((item) => item.matches)
        .find((item) => item.id === match!.id)?.categoryConflict,
    ).toBe(true)

    await finance.updateTransactionCategory({
      transactionId: match!.transactionId,
      categoryId: 'subscriptions',
      saveRule: false,
    })
    const resolved = await finance.getFinanceSnapshot('2026-08')
    expect(
      resolved.recurrences
        .find((item) => item.id === recurrence.id)
        ?.occurrences.flatMap((item) => item.matches)
        .find((item) => item.id === match!.id)?.categoryConflict,
    ).toBe(false)

    await finance.updateTransactionCategory({
      transactionId: match!.transactionId,
      categoryId: 'food',
      saveRule: false,
    })
    const divergentAgain = await finance.getFinanceSnapshot('2026-08')
    expect(
      divergentAgain.recurrences
        .find((item) => item.id === recurrence.id)
        ?.occurrences.flatMap((item) => item.matches)
        .find((item) => item.id === match!.id)?.categoryConflict,
    ).toBe(true)
  })

  it('continua gerando ocorrências depois de dois anos', async () => {
    const finance = await import('./finance.server')
    const recurrence = await finance.createRecurrence({
      name: 'Recorrência longa',
      categoryId: 'housing',
      amountCents: 1_000,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'fixed',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2023-01-15',
    })
    const snapshot = await finance.getFinanceSnapshot('2026-08')

    expect(
      snapshot.recurrences.find((item) => item.id === recurrence.id)
        ?.occurrences.length,
    ).toBeGreaterThan(24)
  })
})
