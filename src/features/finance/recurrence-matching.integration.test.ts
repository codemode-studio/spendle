import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { db } from '#/db/index.server'
import * as schema from '#/db/schema'
import { isAcceptedRecurrenceMatchStatus } from '#/domain/recurrence-book'
import { resetTestDatabase } from '#/test/database'
import type { TestDatabase } from '#/test/database'
import * as finance from './finance.server'
import { getFinanceSnapshot } from './finance-snapshot.server'
import * as recurrenceMatching from './recurrence.server'

const recurrenceServer = recurrenceMatching
const detection = recurrenceMatching

describe('reconciliação de recorrências', () => {
  let testDatabase: TestDatabase

  beforeEach(async () => {
    testDatabase = await resetTestDatabase()
  })

  afterEach(() => {
    testDatabase.close()
  })

  it('confirma e desfaz um vínculo restaurando a categoria anterior', async () => {
    const recurrence = await recurrenceMatching.createRecurrence({
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
      targetId: testDatabase.ids.brlAccount,
      postedAt: '2026-08-10',
      description: 'PG *NETFLIX.COM 847291',
      direction: 'outflow',
      amountCents: 3_990,
    })

    const suggestedSnapshot = await getFinanceSnapshot('2026-08')
    const suggestedMatch = suggestedSnapshot.recurrences
      .find((item) => item.id === recurrence.id)
      ?.occurrences.flatMap((occurrence) => occurrence.matches)
      .find((match) => match.status === 'suggested')
    expect(suggestedMatch).toMatchObject({
      transactionId: transaction.id,
      score: 90,
    })

    await recurrenceMatching.confirmMatch(suggestedMatch!.id)
    const confirmedSnapshot = await getFinanceSnapshot('2026-08')
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
      recurrenceMatching.rejectMatch(suggestedMatch!.id),
    ).rejects.toThrow('Somente sugestões abertas')
    await expect(
      recurrenceMatching.deleteRecurrence(recurrence.id),
    ).rejects.toThrow('Desvincule os pagamentos confirmados')

    await recurrenceMatching.unlinkMatch(suggestedMatch!.id)
    const unlinkedSnapshot = await getFinanceSnapshot('2026-08')
    expect(
      unlinkedSnapshot.transactions.find((item) => item.id === transaction.id)
        ?.categoryId,
    ).toBe('uncategorized')
    expect(unlinkedSnapshot.dashboard.budgetActual.lifestyle).toBe(0)
    expect(
      unlinkedSnapshot.recurrences.find((item) => item.id === recurrence.id)
        ?.nextDate,
    ).toBe('2026-08-10')
    await expect(recurrenceMatching.refreshRecurrences()).resolves.toBeDefined()
    const refreshedSnapshot = await getFinanceSnapshot('2026-08')
    expect(
      refreshedSnapshot.recurrences
        .find((item) => item.id === recurrence.id)
        ?.occurrences.flatMap((item) => item.matches)
        .filter((match) => match.status === 'suggested'),
    ).toHaveLength(0)
    await expect(
      recurrenceMatching.deleteRecurrence(recurrence.id),
    ).resolves.toEqual({ id: recurrence.id })
  })

  it('avança o calendário ao ignorar a próxima ocorrência', async () => {
    const recurrence = await recurrenceMatching.createRecurrence({
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
    const snapshot = await getFinanceSnapshot('2026-08')
    const occurrence = snapshot.recurrences
      .find((item) => item.id === recurrence.id)
      ?.occurrences.find((item) => item.expectedDate === '2026-08-31')

    await recurrenceMatching.skipOccurrence(occurrence!.id)

    const skippedSnapshot = await getFinanceSnapshot('2026-08')
    expect(
      skippedSnapshot.recurrences.find((item) => item.id === recurrence.id)
        ?.nextDate,
    ).toBe('2026-09-30')
  })

  it('não duplica uma pendência categorizada na projeção recorrente', async () => {
    await recurrenceServer.createRecurrence({
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
    await db.insert(schema.transactions).values({
      id: 'pending-netflix',
      accountId: testDatabase.ids.brlAccount,
      categoryId: 'subscriptions',
      fingerprint: 'pending-netflix',
      postedAt: '2026-08-10',
      description: 'Netflix',
      normalizedDescription: 'netflix',
      amountCents: -20_800,
      currency: 'BRL',
      status: 'pending',
    })

    const snapshot = await getFinanceSnapshot('2026-08')

    expect(snapshot.dashboard.budgetProjected.lifestyle).toBe(20_800)
  })

  it('pausa sugestões e resolve conflito quando a categoria é corrigida', async () => {
    const recurrence = await recurrenceMatching.createRecurrence({
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
      targetId: testDatabase.ids.brlAccount,
      postedAt: '2026-08-15',
      description: 'Spotify',
      direction: 'outflow',
      amountCents: 2_190,
      categoryId: 'groceries',
    })
    const suggested = await getFinanceSnapshot('2026-08')
    const match = suggested.recurrences
      .find((item) => item.id === recurrence.id)
      ?.occurrences.flatMap((item) => item.matches)
      .find((item) => item.status === 'suggested')

    await recurrenceMatching.setRecurrenceActive({
      id: recurrence.id,
      active: false,
    })
    const paused = await getFinanceSnapshot('2026-08')
    expect(paused.dashboard.budgetProjected.lifestyle).toBe(
      suggested.dashboard.budgetProjected.lifestyle - 2_190,
    )
    await expect(recurrenceMatching.confirmMatch(match!.id)).rejects.toThrow(
      'Reative a recorrência',
    )
    await recurrenceMatching.setRecurrenceActive({
      id: recurrence.id,
      active: true,
    })
    await recurrenceMatching.confirmMatch(match!.id)

    const conflicted = await getFinanceSnapshot('2026-08')
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
    const resolved = await getFinanceSnapshot('2026-08')
    expect(
      resolved.recurrences
        .find((item) => item.id === recurrence.id)
        ?.occurrences.flatMap((item) => item.matches)
        .find((item) => item.id === match!.id)?.categoryConflict,
    ).toBe(false)

    await finance.updateTransactionCategory({
      transactionId: match!.transactionId,
      categoryId: 'groceries',
      saveRule: false,
    })
    const divergentAgain = await getFinanceSnapshot('2026-08')
    expect(
      divergentAgain.recurrences
        .find((item) => item.id === recurrence.id)
        ?.occurrences.flatMap((item) => item.matches)
        .find((item) => item.id === match!.id)?.categoryConflict,
    ).toBe(true)
  })

  it('vincula manualmente um pagamento e aprende o estabelecimento', async () => {
    const recurrence = await recurrenceMatching.createRecurrence({
      name: 'Cuidadora',
      categoryId: 'family',
      amountCents: 215_000,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'fixed',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2026-08-04',
    })
    const payment = await finance.createManualTransaction({
      targetType: 'account',
      targetId: testDatabase.ids.brlAccount,
      postedAt: '2026-08-04',
      description: 'Pix Janete Meili',
      direction: 'outflow',
      amountCents: 215_000,
    })
    const deposit = await finance.createManualTransaction({
      targetType: 'account',
      targetId: testDatabase.ids.brlAccount,
      postedAt: '2026-08-04',
      description: 'Reembolso Janete',
      direction: 'inflow',
      amountCents: 215_000,
    })

    // Sem semelhança de nome nem destino conhecido, a busca automática não
    // sugere nada: é exatamente o caso que o vínculo manual resolve.
    const before = await getFinanceSnapshot('2026-08')
    const occurrence = before.recurrences
      .find((item) => item.id === recurrence.id)
      ?.occurrences.find((item) => item.expectedDate === '2026-08-04')
    expect(occurrence?.status).toBe('expected')
    expect(occurrence?.matches).toHaveLength(0)

    await expect(
      recurrenceMatching.linkTransactions({
        occurrenceId: occurrence!.id,
        transactionIds: [deposit.id],
      }),
    ).rejects.toThrow('escolha uma saída')

    await recurrenceMatching.linkTransactions({
      occurrenceId: occurrence!.id,
      transactionIds: [payment.id],
    })
    const after = await getFinanceSnapshot('2026-08')
    const linked = after.recurrences.find((item) => item.id === recurrence.id)
    const linkedOccurrence = linked?.occurrences.find(
      (item) => item.id === occurrence!.id,
    )
    expect(linkedOccurrence?.status).toBe('matched')
    expect(linkedOccurrence?.matches[0]).toMatchObject({
      transactionId: payment.id,
      status: 'confirmed',
      reason: 'vinculado manualmente',
    })
    expect(linked?.nextDate).toBe('2026-09-04')
    expect(
      after.transactions.find((item) => item.id === payment.id)?.categoryId,
    ).toBe('family')

    // O próximo pagamento do mesmo estabelecimento passa a ser sugerido.
    const nextPayment = await finance.createManualTransaction({
      targetType: 'account',
      targetId: testDatabase.ids.brlAccount,
      postedAt: '2026-09-04',
      description: 'Pix Janete Meili',
      direction: 'outflow',
      amountCents: 215_000,
    })
    await recurrenceMatching.refreshRecurrences()
    const learned = await getFinanceSnapshot('2026-09')
    const suggestion = learned.recurrences
      .find((item) => item.id === recurrence.id)
      ?.occurrences.find((item) => item.expectedDate === '2026-09-04')
      ?.matches.find((match) => match.transactionId === nextPayment.id)
    expect(suggestion?.status).toBe('suggested')
    expect(suggestion?.score).toBeGreaterThanOrEqual(95)
  })

  it('detecta, aprova e passa a ignorar recorrências a partir dos lançamentos', async () => {
    const today = new Date()
    const monthsAgo = (months: number, day: number) => {
      const date = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - months, day),
      )
      return date.toISOString().slice(0, 10)
    }
    const payments: Array<{ id: string }> = []
    for (const months of [3, 2, 1]) {
      payments.push(
        await finance.createManualTransaction({
          targetType: 'account',
          targetId: testDatabase.ids.brlAccount,
          postedAt: monthsAgo(months, 12),
          description: 'Icatu Seguros',
          direction: 'outflow',
          amountCents: 1_751,
        }),
      )
    }
    for (const months of [2, 1]) {
      await finance.createManualTransaction({
        targetType: 'account',
        targetId: testDatabase.ids.brlAccount,
        postedAt: monthsAgo(months, 20),
        description: 'Starlink Internet',
        direction: 'outflow',
        amountCents: 24_900,
      })
    }

    const candidates = await detection.detectRecurrenceCandidates()
    const icatu = candidates.find((item) => item.name === 'Icatu Seguros')
    const starlink = candidates.find(
      (item) => item.name === 'Starlink Internet',
    )
    expect(icatu).toMatchObject({
      frequency: 'monthly',
      amountMode: 'fixed',
      typicalAmountCents: 1_751,
    })
    expect(icatu?.transactions.map((item) => item.id)).toEqual(
      payments.map((item) => item.id),
    )
    expect(starlink).toBeDefined()

    const approved = await detection.approveDetectedRecurrence({
      name: 'Seguro Icatu',
      categoryId: 'insurance',
      amountCents: icatu!.typicalAmountCents,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'fixed',
      frequency: 'monthly',
      nextDate: icatu!.nextExpectedDate,
      accountId: icatu!.accountId ?? undefined,
      transactionIds: icatu!.transactions.map((item) => item.id),
    })
    expect(approved.linked).toBe(3)

    const snapshot = await getFinanceSnapshot()
    const recurrence = snapshot.recurrences.find(
      (item) => item.id === approved.id,
    )
    expect(recurrence?.nextDate).toBe(icatu!.nextExpectedDate)
    expect(
      recurrence?.occurrences.filter((item) => item.status === 'matched'),
    ).toHaveLength(3)
    expect(
      recurrence?.occurrences.some(
        (item) =>
          item.status === 'expected' &&
          item.expectedDate === icatu!.nextExpectedDate,
      ),
    ).toBe(true)
    expect(
      snapshot.transactions.find((item) => item.id === payments[0].id)
        ?.categoryId,
    ).toBe('insurance')

    await detection.ignoreDetectedRecurrence({
      signature: starlink!.signature,
      direction: starlink!.direction,
    })
    const remaining = await detection.detectRecurrenceCandidates()
    expect(
      remaining.find((item) => item.name === 'Icatu Seguros'),
    ).toBeUndefined()
    expect(
      remaining.find((item) => item.name === 'Starlink Internet'),
    ).toBeUndefined()
  })

  it('não cria recorrência quando a detecção ficou sem transações vinculáveis', async () => {
    const today = new Date()
    const monthsAgo = (months: number) =>
      new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - months, 6),
      )
        .toISOString()
        .slice(0, 10)
    for (const months of [2, 1]) {
      await finance.createManualTransaction({
        targetType: 'account',
        targetId: testDatabase.ids.brlAccount,
        postedAt: monthsAgo(months),
        description: 'Clube Horizonte Teste Atomicidade',
        direction: 'outflow',
        amountCents: 8_765,
      })
    }
    const candidate = (
      await recurrenceServer.detectRecurrenceCandidates()
    ).find((item) => item.name === 'Clube Horizonte Teste Atomicidade')
    expect(candidate).toBeDefined()

    const competing = await recurrenceServer.createRecurrence({
      name: 'Vínculo concorrente da detecção',
      categoryId: 'subscriptions',
      amountCents: candidate!.typicalAmountCents,
      currency: candidate!.currency,
      direction: candidate!.direction,
      amountMode: candidate!.amountMode,
      destinationMode: 'automatic',
      frequency: candidate!.frequency,
      nextDate: candidate!.nextExpectedDate,
      startsOn: candidate!.transactions[0].postedAt,
      scheduleAnchor: candidate!.nextExpectedDate,
    })
    const competingOccurrences = await db
      .select()
      .from(schema.recurrenceOccurrences)
      .where(eq(schema.recurrenceOccurrences.recurrenceId, competing.id))
    for (const transaction of candidate!.transactions) {
      const occurrence = competingOccurrences.find(
        (item) => item.expectedDate === transaction.postedAt,
      )
      expect(occurrence).toBeDefined()
      await recurrenceServer.linkTransactions({
        occurrenceId: occurrence!.id,
        transactionIds: [transaction.id],
      })
    }
    const recurrencesBefore = await db
      .select({ id: schema.recurrences.id })
      .from(schema.recurrences)

    const approvalError = await recurrenceServer
      .approveDetectedRecurrence({
        name: 'Clube Horizonte aprovado tarde demais',
        categoryId: 'subscriptions',
        amountCents: candidate!.typicalAmountCents,
        currency: candidate!.currency,
        direction: candidate!.direction,
        amountMode: candidate!.amountMode,
        frequency: candidate!.frequency,
        nextDate: candidate!.nextExpectedDate,
        accountId: candidate!.accountId ?? undefined,
        creditCardId: candidate!.creditCardId ?? undefined,
        transactionIds: candidate!.transactions.map((item) => item.id),
      })
      .then(
        () => null,
        (error: unknown) => error,
      )
    const recurrencesAfter = await db
      .select({ id: schema.recurrences.id })
      .from(schema.recurrences)
    expect.soft(recurrencesAfter).toHaveLength(recurrencesBefore.length)
    expect.soft(approvalError).toBeInstanceOf(Error)
    expect(approvalError).toMatchObject({
      message:
        'Nenhuma das transações detectadas continua disponível para vinculação.',
    })
  })

  it('envelope: soma vários lançamentos, aprende estabelecimentos e fecha o período', async () => {
    const today = new Date()
    const monthStart = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
    )
      .toISOString()
      .slice(0, 10)
    const recurrence = await recurrenceMatching.createRecurrence({
      name: 'Mercado',
      categoryId: 'groceries',
      amountCents: 300_000,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'variable',
      matchMode: 'aggregate',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: monthStart,
    })
    const grocery = async (description: string, amountCents: number) =>
      finance.createManualTransaction({
        targetType: 'account',
        targetId: testDatabase.ids.brlAccount,
        postedAt: monthStart,
        description,
        direction: 'outflow',
        amountCents,
        categoryId: 'groceries',
      })
    const angeloni = await grocery('Angeloni Super Loja', 22_000)
    const imperatriz = await grocery('Supermercados Imperatriz', 50_000)
    await recurrenceMatching.refreshRecurrences()

    const suggestedSnapshot = await getFinanceSnapshot()
    const occurrence = suggestedSnapshot.recurrences
      .find((item) => item.id === recurrence.id)
      ?.occurrences.find((item) => item.expectedDate === monthStart)
    const suggested = occurrence?.matches.filter(
      (match) => match.status === 'suggested',
    )
    expect(suggested?.map((match) => match.transactionId).sort()).toEqual(
      [angeloni.id, imperatriz.id].sort(),
    )

    // Dois lançamentos no mesmo período: ambos confirmados, ocorrência aberta.
    for (const match of suggested!) {
      await recurrenceMatching.confirmMatch(match.id)
    }
    const openSnapshot = await getFinanceSnapshot()
    const openOccurrence = openSnapshot.recurrences
      .find((item) => item.id === recurrence.id)
      ?.occurrences.find((item) => item.id === occurrence!.id)
    expect(openOccurrence?.status).toBe('expected')
    expect(
      openOccurrence?.matches.filter((match) => match.status === 'confirmed'),
    ).toHaveLength(2)

    // Estabelecimento aprendido entra sozinho na próxima busca.
    const angeloniAgain = await grocery('Angeloni Super Loja', 9_900)
    await recurrenceMatching.refreshRecurrences()
    const learnedSnapshot = await getFinanceSnapshot()
    const learnedMatch = learnedSnapshot.recurrences
      .find((item) => item.id === recurrence.id)
      ?.occurrences.find((item) => item.id === occurrence!.id)
      ?.matches.find((match) => match.transactionId === angeloniAgain.id)
    expect(learnedMatch?.status).toBe('auto_confirmed')

    // Vínculo manual de vários lançamentos de uma vez.
    const padaria = await finance.createManualTransaction({
      targetType: 'account',
      targetId: testDatabase.ids.brlAccount,
      postedAt: monthStart,
      description: 'Padaria Pao Quente',
      direction: 'outflow',
      amountCents: 3_500,
    })
    const acougue = await finance.createManualTransaction({
      targetType: 'account',
      targetId: testDatabase.ids.brlAccount,
      postedAt: monthStart,
      description: 'Acougue Central',
      direction: 'outflow',
      amountCents: 12_000,
    })
    const linked = await recurrenceMatching.linkTransactions({
      occurrenceId: occurrence!.id,
      transactionIds: [padaria.id, acougue.id],
    })
    expect(linked.linked).toBe(2)

    // Editar a recorrência não pode apagar o envelope em andamento.
    await recurrenceMatching.updateRecurrence(recurrence.id, {
      name: 'Mercado e feira',
      categoryId: 'groceries',
      amountCents: 320_000,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'variable',
      matchMode: 'aggregate',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: monthStart,
    })
    const editedSnapshot = await getFinanceSnapshot()
    expect(
      editedSnapshot.recurrences
        .find((item) => item.id === recurrence.id)
        ?.occurrences.find((item) => item.id === occurrence!.id)
        ?.matches.filter((match) =>
          isAcceptedRecurrenceMatchStatus(match.status),
        ),
    ).toHaveLength(5)

    // Concluir fecha o período e avança a próxima data.
    await recurrenceMatching.completeOccurrence(occurrence!.id)
    const closedSnapshot = await getFinanceSnapshot()
    const closed = closedSnapshot.recurrences.find(
      (item) => item.id === recurrence.id,
    )
    expect(
      closed?.occurrences.find((item) => item.id === occurrence!.id)?.status,
    ).toBe('matched')
    expect((closed?.nextDate ?? '') > monthStart).toBe(true)
    expect(
      closed?.occurrences
        .find((item) => item.id === occurrence!.id)
        ?.matches.filter((match) =>
          isAcceptedRecurrenceMatchStatus(match.status),
        ),
    ).toHaveLength(5)
  })

  it('receita: permite vincular manualmente a entrada de distribuição de lucro sem alterar sua categoria', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const companyAccount = await finance.createAccount({
      name: 'Conta empresarial de teste',
      institutionName: 'Banco empresarial de teste',
      ownershipScopeId: testDatabase.ids.companyScope,
      kind: 'checking',
      purpose: 'operating',
      currency: 'BRL',
      initialBalanceCents: 0,
    })
    const recurrence = await recurrenceMatching.createRecurrence({
      name: 'Salário',
      categoryId: 'profit_distribution_income',
      amountCents: 6_000_000,
      currency: 'BRL',
      direction: 'income',
      amountMode: 'variable',
      matchMode: 'aggregate',
      destinationMode: 'fixed',
      accountId: testDatabase.ids.brlAccount,
      frequency: 'monthly',
      nextDate: today,
    })
    const outflow = await finance.createManualTransaction({
      targetType: 'account',
      targetId: companyAccount.id,
      postedAt: today,
      description: 'Donald Lourenco Silveira',
      direction: 'outflow',
      amountCents: 2_500_000,
    })
    const inflow = await finance.createManualTransaction({
      targetType: 'account',
      targetId: testDatabase.ids.brlAccount,
      postedAt: today,
      description: 'Donald Lourenco Silveira',
      direction: 'inflow',
      amountCents: 2_500_000,
    })
    // Conciliação PJ → PF como a importação registra: contrapartida nas duas pernas.
    await db
      .update(schema.transactions)
      .set({ counterpartyAccountId: testDatabase.ids.brlAccount })
      .where(eq(schema.transactions.id, outflow.id))
    await db
      .update(schema.transactions)
      .set({ counterpartyAccountId: companyAccount.id })
      .where(eq(schema.transactions.id, inflow.id))
    const groupId = 'profit-distribution-test'
    await db.insert(schema.reconciliationGroups).values({
      id: groupId,
      type: 'profit_distribution',
      status: 'suggested',
      confidence: 100,
    })
    await db.insert(schema.reconciliationLinks).values([
      {
        id: `${groupId}-out`,
        groupId,
        transactionId: outflow.id,
        role: 'source',
      },
      {
        id: `${groupId}-in`,
        groupId,
        transactionId: inflow.id,
        role: 'target',
      },
    ])
    await finance.setReconciliationStatus({ groupId, status: 'confirmed' })
    const [oldOccurrence] = await db
      .select()
      .from(schema.recurrenceOccurrences)
      .where(eq(schema.recurrenceOccurrences.recurrenceId, recurrence.id))
    await db.insert(schema.recurrenceMatches).values({
      id: 'stale-auto-income',
      occurrenceId: oldOccurrence.id,
      transactionId: inflow.id,
      status: 'auto_confirmed',
      score: 95,
      reason: 'regra anterior',
    })
    const knowledgeBefore = await db.select().from(schema.knowledgeBase)

    await recurrenceMatching.refreshRecurrences()
    expect(await db.select().from(schema.knowledgeBase)).toEqual(
      knowledgeBefore,
    )
    expect(
      (
        await db
          .select()
          .from(schema.recurrenceMatches)
          .where(eq(schema.recurrenceMatches.id, 'stale-auto-income'))
      )[0].status,
    ).toBe('unlinked')
    const suggestedSnapshot = await getFinanceSnapshot()
    const occurrence = suggestedSnapshot.recurrences
      .find((item) => item.id === recurrence.id)
      ?.occurrences.find((item) => item.status === 'expected')
    expect(occurrence).toBeDefined()
    // Ambas as pontas pertencem ao caixa consolidado.
    expect(
      occurrence?.matches
        .filter(
          (match) =>
            isAcceptedRecurrenceMatchStatus(match.status) ||
            match.status === 'suggested',
        )
        .map((match) => [match.transactionId, match.status]),
    ).toEqual([])
    const [inflowBeforeLink] = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, inflow.id))
    const categoryKnowledgeBefore = knowledgeBefore.filter(
      (item) => item.categoryId === 'profit_distribution_income',
    )
    const candidates = await recurrenceMatching.listLinkCandidates({
      occurrenceId: occurrence!.id,
      today,
    })
    expect(candidates.map((candidate) => candidate.id)).toContain(inflow.id)
    expect(candidates.map((candidate) => candidate.id)).not.toContain(
      outflow.id,
    )

    await recurrenceMatching.linkTransactions({
      occurrenceId: occurrence!.id,
      transactionIds: [inflow.id],
    })

    const [linkedMatch] = await db
      .select()
      .from(schema.recurrenceMatches)
      .where(eq(schema.recurrenceMatches.id, 'stale-auto-income'))
    expect(linkedMatch.status).toBe('confirmed')
    expect(linkedMatch.categoryConflict).toBe(false)
    expect(linkedMatch.categoryAppliedByMatch).toBe(false)
    const [linkedInflow] = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, inflow.id))
    expect(linkedInflow.categoryId).toBe(inflowBeforeLink.categoryId)

    const knowledgeAfter = await db.select().from(schema.knowledgeBase)
    expect(knowledgeAfter.length).toBe(knowledgeBefore.length + 1)
    expect(
      knowledgeAfter.filter(
        (item) => item.categoryId === 'profit_distribution_income',
      ),
    ).toEqual(categoryKnowledgeBefore)
    await expect(
      recurrenceMatching.linkTransactions({
        occurrenceId: occurrence!.id,
        transactionIds: [outflow.id],
      }),
    ).rejects.toThrow('escolha uma entrada')
  })

  it('continua gerando ocorrências depois de dois anos', async () => {
    const recurrence = await recurrenceServer.createRecurrence({
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
    const snapshot = await getFinanceSnapshot('2026-08')

    expect(
      snapshot.recurrences.find((item) => item.id === recurrence.id)
        ?.occurrences.length,
    ).toBeGreaterThan(24)
  })

  it('preserva vínculos aceitos e só muda a âncora quando o calendário muda', async () => {
    const recurrence = await recurrenceServer.createRecurrence({
      name: 'Envelope ancorado',
      categoryId: 'groceries',
      amountCents: 80_000,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'variable',
      matchMode: 'aggregate',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2027-01-31',
    })
    const row = await finance.createManualTransaction({
      targetType: 'account',
      targetId: testDatabase.ids.brlAccount,
      postedAt: '2027-01-31',
      description: 'Mercado do futuro',
      direction: 'outflow',
      amountCents: 8_000,
      categoryId: 'groceries',
    })
    const before = await getFinanceSnapshot('2027-01')
    const occurrence = before.recurrences
      .find((item) => item.id === recurrence.id)
      ?.occurrences.find((item) => item.expectedDate === '2027-01-31')
    await recurrenceServer.linkTransactions({
      occurrenceId: occurrence!.id,
      transactionIds: [row.id],
    })

    await recurrenceServer.updateRecurrence(recurrence.id, {
      name: 'Envelope apenas renomeado',
      categoryId: 'groceries',
      amountCents: 90_000,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'variable',
      matchMode: 'aggregate',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2027-01-31',
    })
    const renamed = await getFinanceSnapshot('2027-01')
    const renamedRecurrence = renamed.recurrences.find(
      (item) => item.id === recurrence.id,
    )
    expect(renamedRecurrence).toMatchObject({
      startsOn: '2027-01-31',
      scheduleAnchor: '2027-01-31',
    })
    expect(
      renamedRecurrence?.occurrences
        .find((item) => item.id === occurrence!.id)
        ?.matches.some((match) => match.status === 'confirmed'),
    ).toBe(true)
    await expect(
      recurrenceServer.deleteRecurrence(recurrence.id),
    ).rejects.toThrow('Desvincule os pagamentos confirmados')

    await recurrenceServer.updateRecurrence(recurrence.id, {
      name: 'Envelope em novo calendário',
      categoryId: 'groceries',
      amountCents: 90_000,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'variable',
      matchMode: 'aggregate',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2027-02-15',
    })
    const rescheduled = await getFinanceSnapshot('2027-02')
    expect(
      rescheduled.recurrences.find((item) => item.id === recurrence.id),
    ).toMatchObject({
      startsOn: '2027-02-15',
      scheduleAnchor: '2027-02-15',
      nextDate: '2027-02-15',
    })
  })

  it('rejeita uma sugestão aberta', async () => {
    const recurrence = await recurrenceServer.createRecurrence({
      name: 'Serviço rejeitável',
      categoryId: 'subscriptions',
      amountCents: 4_321,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'fixed',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2027-02-20',
    })
    await finance.createManualTransaction({
      targetType: 'account',
      targetId: testDatabase.ids.brlAccount,
      postedAt: '2027-02-20',
      description: 'Serviço rejeitável',
      direction: 'outflow',
      amountCents: 4_321,
    })
    const suggested = await getFinanceSnapshot('2027-02')
    const match = suggested.recurrences
      .find((item) => item.id === recurrence.id)
      ?.occurrences.flatMap((item) => item.matches)
      .find((item) => item.status === 'suggested')

    await recurrenceServer.rejectMatch(match!.id)

    const rejected = await getFinanceSnapshot('2027-02')
    expect(
      rejected.recurrences
        .find((item) => item.id === recurrence.id)
        ?.occurrences.flatMap((item) => item.matches)
        .find((item) => item.id === match!.id)?.status,
    ).toBe('rejected')
  })

  it('lista candidatos sem transações tomadas e prioriza a janela do envelope', async () => {
    const target = await recurrenceServer.createRecurrence({
      name: 'Compras do período',
      categoryId: 'groceries',
      amountCents: 50_000,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'variable',
      matchMode: 'aggregate',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2027-03-01',
    })
    const takenRecurrence = await recurrenceServer.createRecurrence({
      name: 'Pagamento já usado',
      categoryId: 'groceries',
      amountCents: 7_000,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'fixed',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2027-03-05',
    })
    const insideSame = await finance.createManualTransaction({
      targetType: 'account',
      targetId: testDatabase.ids.brlAccount,
      postedAt: '2027-03-20',
      description: 'Mercado na janela',
      direction: 'outflow',
      amountCents: 20_000,
      categoryId: 'groceries',
    })
    const insideOther = await finance.createManualTransaction({
      targetType: 'account',
      targetId: testDatabase.ids.brlAccount,
      postedAt: '2027-03-02',
      description: 'Outra categoria na janela',
      direction: 'outflow',
      amountCents: 49_000,
      categoryId: 'leisure',
    })
    const outside = await finance.createManualTransaction({
      targetType: 'account',
      targetId: testDatabase.ids.brlAccount,
      postedAt: '2027-04-02',
      description: 'Mercado fora da janela',
      direction: 'outflow',
      amountCents: 50_000,
      categoryId: 'groceries',
    })
    const taken = await finance.createManualTransaction({
      targetType: 'account',
      targetId: testDatabase.ids.brlAccount,
      postedAt: '2027-03-05',
      description: 'Pagamento já usado',
      direction: 'outflow',
      amountCents: 7_000,
      categoryId: 'groceries',
    })
    const snapshot = await getFinanceSnapshot('2027-03')
    const takenOccurrence = snapshot.recurrences
      .find((item) => item.id === takenRecurrence.id)
      ?.occurrences.find((item) => item.expectedDate === '2027-03-05')
    const targetOccurrence = snapshot.recurrences
      .find((item) => item.id === target.id)
      ?.occurrences.find((item) => item.expectedDate === '2027-03-01')
    await recurrenceServer.linkTransactions({
      occurrenceId: takenOccurrence!.id,
      transactionIds: [taken.id],
    })

    const candidates = await recurrenceServer.listLinkCandidates({
      occurrenceId: targetOccurrence!.id,
      today: '2027-03-25',
    })

    expect(candidates.map((candidate) => candidate.id)).not.toContain(taken.id)
    const rankedIds = new Set<string>([
      insideSame.id,
      insideOther.id,
      outside.id,
    ])
    expect(
      candidates
        .filter((candidate) => rankedIds.has(candidate.id))
        .map((candidate) => candidate.id),
    ).toEqual([insideSame.id, insideOther.id, outside.id])
    expect(
      candidates.find((candidate) => candidate.id === insideSame.id),
    ).toMatchObject({
      inWindow: true,
      categoryName: 'Mercado',
      accountLabel: snapshot.accounts.find(
        (account) => account.id === testDatabase.ids.brlAccount,
      )?.name,
    })
  })

  it('retorna um candidato elegível depois dos 40 primeiros no ranking', async () => {
    const recurrence = await recurrenceServer.createRecurrence({
      name: 'Lista completa de candidatos',
      categoryId: 'groceries',
      amountCents: 10_000,
      currency: 'USD',
      direction: 'expense',
      amountMode: 'fixed',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2030-01-10',
    })
    const occurrence = await db
      .select({ id: schema.recurrenceOccurrences.id })
      .from(schema.recurrenceOccurrences)
      .where(eq(schema.recurrenceOccurrences.recurrenceId, recurrence.id))
      .limit(1)
    expect(occurrence[0]).toBeDefined()

    await db.insert(schema.transactions).values(
      Array.from({ length: 41 }, (_, index) => ({
        id: `link-candidate-${index}`,
        accountId: testDatabase.ids.brlAccount,
        categoryId: 'groceries',
        fingerprint: `link-candidate-${index}`,
        postedAt: '2030-01-10',
        description: `Candidato ${index}`,
        normalizedDescription: `candidato ${index}`,
        amountCents: -(10_000 + index * 100),
        currency: 'USD',
        status: 'confirmed' as const,
      })),
    )

    const candidates = await recurrenceServer.listLinkCandidates({
      occurrenceId: occurrence[0].id,
      today: '2030-01-10',
    })

    expect(candidates).toHaveLength(41)
    expect(candidates.at(-1)?.id).toBe('link-candidate-40')
  })

  it('retorna deltas por execução e fecha envelope com hoje injetado', async () => {
    const recurrence = await recurrenceServer.createRecurrence({
      name: 'Envelope com relógio injetado',
      categoryId: 'maintenance',
      amountCents: 60_000,
      currency: 'BRL',
      direction: 'expense',
      amountMode: 'variable',
      matchMode: 'aggregate',
      destinationMode: 'automatic',
      frequency: 'monthly',
      nextDate: '2027-06-01',
    })
    await recurrenceServer.refreshRecurrences({ today: '2027-06-20' })
    await db.insert(schema.transactions).values({
      id: 'injected-today-envelope-row',
      accountId: testDatabase.ids.brlAccount,
      categoryId: 'maintenance',
      fingerprint: 'injected-today-envelope-row',
      postedAt: '2027-06-15',
      description: 'Feira com relógio injetado',
      normalizedDescription: 'feira com relogio injetado',
      amountCents: -12_000,
      currency: 'BRL',
      baseAmountCents: -12_000,
      status: 'confirmed',
    })

    const first = await recurrenceServer.refreshRecurrences({
      today: '2027-06-20',
    })
    const second = await recurrenceServer.refreshRecurrences({
      today: '2027-06-20',
    })
    expect(first).toMatchObject({ suggestionCount: 1, autoConfirmCount: 0 })
    expect(second).toMatchObject({ suggestionCount: 0, autoConfirmCount: 0 })

    const open = await getFinanceSnapshot('2027-06')
    const occurrence = open.recurrences
      .find((item) => item.id === recurrence.id)
      ?.occurrences.find((item) => item.expectedDate === '2027-06-01')
    const match = occurrence?.matches.find(
      (candidate) => candidate.transactionId === 'injected-today-envelope-row',
    )
    await recurrenceServer.confirmMatch(match!.id)
    await recurrenceServer.refreshRecurrences({ today: '2027-07-01' })

    const closed = await getFinanceSnapshot('2027-06')
    const closedRecurrence = closed.recurrences.find(
      (item) => item.id === recurrence.id,
    )
    expect(
      closedRecurrence?.occurrences.find(
        (item) => item.expectedDate === '2027-06-01',
      )?.status,
    ).toBe('matched')
    expect(closedRecurrence?.nextDate).toBe('2027-07-01')
  })
})
