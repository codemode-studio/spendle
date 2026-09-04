import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import {
  addRecurrencePeriod,
  buildRecurrenceCandidates,
  isAcceptedRecurrenceMatchStatus,
  merchantSignature,
  transactionEligibleForRecurrence,
} from '#/domain/recurrence-matching'
import type { RecurrenceReconciliationType } from '#/domain/recurrence-matching'

function median(values: number[]) {
  if (!values.length) return undefined
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2
}

function shiftDays(iso: string, days: number) {
  const date = new Date(`${iso}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function previousRecurrencePeriod(
  date: string,
  frequency: 'monthly' | 'yearly',
  scheduleAnchor: string,
) {
  const [year, month] = date.split('-').map(Number)
  const [, anchorMonth, anchorDay] = scheduleAnchor.split('-').map(Number)
  const targetYear =
    frequency === 'monthly' ? (month === 1 ? year - 1 : year) : year - 1
  const targetMonth =
    frequency === 'monthly' ? (month === 1 ? 11 : month - 2) : anchorMonth - 1
  const lastDay = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate()
  return new Date(
    Date.UTC(targetYear, targetMonth, Math.min(anchorDay, lastDay)),
  )
    .toISOString()
    .slice(0, 10)
}

function occurrenceDates(input: {
  startsOn: string
  scheduleAnchor: string
  nextDate: string
  frequency: 'monthly' | 'yearly'
}) {
  const result: string[] = []
  const today = new Date().toISOString().slice(0, 10)
  let date = input.startsOn === '1970-01-01' ? input.nextDate : input.startsOn
  if (input.startsOn === '1970-01-01') {
    // Sem data de início cadastrada, a recorrência é tratada como já em curso:
    // olha um período para trás (até 45 dias) para achar o pagamento anterior.
    const previous = previousRecurrencePeriod(
      date,
      input.frequency,
      input.scheduleAnchor,
    )
    if (previous >= shiftDays(today, -45)) date = previous
  }
  const lastDate = input.nextDate > today ? input.nextDate : today
  while (date <= lastDate) {
    result.push(date)
    date = addRecurrencePeriod(date, input.frequency, input.scheduleAnchor)
  }
  return result
}

export async function refreshRecurrenceSuggestions() {
  await ensureDatabase()
  const [
    recurrences,
    transactions,
    existingOccurrences,
    existingMatches,
    groups,
    links,
  ] = await Promise.all([
    db.select().from(schema.recurrences),
    db.select().from(schema.transactions),
    db.select().from(schema.recurrenceOccurrences),
    db.select().from(schema.recurrenceMatches),
    db.select().from(schema.reconciliationGroups),
    db.select().from(schema.reconciliationLinks),
  ])
  const groupsById = new Map(groups.map((group) => [group.id, group]))
  const reconciliationByTransaction = new Map<
    string,
    (typeof groups)[number]['type']
  >()
  for (const link of links) {
    const group = groupsById.get(link.groupId)
    if (!group || group.status === 'rejected') continue
    if (!reconciliationByTransaction.has(link.transactionId)) {
      reconciliationByTransaction.set(link.transactionId, group.type)
    }
  }

  for (const recurrence of recurrences) {
    if (!recurrence.active || !recurrence.categoryId) continue
    for (const expectedDate of occurrenceDates(recurrence)) {
      const exists = existingOccurrences.some(
        (occurrence) =>
          occurrence.recurrenceId === recurrence.id &&
          occurrence.expectedDate === expectedDate,
      )
      if (exists) continue
      const id = randomUUID()
      await db.insert(schema.recurrenceOccurrences).values({
        id,
        recurrenceId: recurrence.id,
        expectedDate,
        expectedAmountCents: Math.abs(recurrence.amountCents),
        currency: recurrence.currency,
        direction: recurrence.direction,
        categoryId: recurrence.categoryId,
      })
      existingOccurrences.push({
        id,
        recurrenceId: recurrence.id,
        expectedDate,
        expectedAmountCents: Math.abs(recurrence.amountCents),
        currency: recurrence.currency,
        direction: recurrence.direction,
        categoryId: recurrence.categoryId,
        status: 'expected',
        resolvedAt: null,
        createdAt: new Date(),
      })
    }
  }

  const acceptedMatches = existingMatches.filter((match) =>
    isAcceptedRecurrenceMatchStatus(match.status),
  )
  const unavailableTransactionIds = new Set(
    acceptedMatches.map((match) => match.transactionId),
  )

  for (const occurrence of existingOccurrences) {
    if (occurrence.status !== 'expected') continue
    const recurrence = recurrences.find(
      (item) => item.id === occurrence.recurrenceId,
    )
    if (!recurrence?.active) continue
    const confirmedForRecurrence = acceptedMatches.filter((match) => {
      const learnedOccurrence = existingOccurrences.find(
        (item) => item.id === match.occurrenceId,
      )
      return learnedOccurrence?.recurrenceId === recurrence.id
    })
    const learnedTransactions = confirmedForRecurrence
      .map((match) =>
        transactions.find((item) => item.id === match.transactionId),
      )
      .filter((item): item is (typeof transactions)[number] => Boolean(item))
    const learnedObservations = confirmedForRecurrence.flatMap((match) => {
      const learnedOccurrence = existingOccurrences.find(
        (item) => item.id === match.occurrenceId,
      )
      const learnedTransaction = transactions.find(
        (item) => item.id === match.transactionId,
      )
      if (!learnedOccurrence || !learnedTransaction) return []
      const dateOffset =
        (new Date(
          `${learnedTransaction.postedAt.slice(0, 10)}T12:00:00Z`,
        ).getTime() -
          new Date(`${learnedOccurrence.expectedDate}T12:00:00Z`).getTime()) /
        86_400_000
      return [
        {
          dateOffset,
          amountCents: Math.abs(learnedTransaction.amountCents),
        },
      ]
    })
    const medianDateOffsetDays = median(
      learnedObservations.map((observation) => observation.dateOffset),
    )
    const learnedAmounts = learnedObservations.map(
      (observation) => observation.amountCents,
    )
    const rejectedCount = existingMatches.filter((match) => {
      const rejectedOccurrence = existingOccurrences.find(
        (item) => item.id === match.occurrenceId,
      )
      return (
        match.status === 'rejected' &&
        rejectedOccurrence?.recurrenceId === recurrence.id
      )
    }).length
    if (recurrence.matchMode === 'aggregate') {
      await refreshAggregateOccurrence({
        recurrence,
        occurrence,
        transactions,
        existingMatches,
        learnedTransactions,
        reconciliationByTransaction,
        unavailableTransactionIds,
      })
      continue
    }
    const candidates = buildRecurrenceCandidates({
      recurrenceName: recurrence.name,
      rule: {
        expectedDate: occurrence.expectedDate,
        expectedAmountCents: occurrence.expectedAmountCents,
        currency: occurrence.currency,
        direction: occurrence.direction,
        amountMode: recurrence.amountMode,
        destinationMode: recurrence.destinationMode,
        accountId: recurrence.accountId,
        creditCardId: recurrence.creditCardId,
        dateToleranceDays: recurrence.dateToleranceDays,
        amountToleranceBps: recurrence.amountToleranceBps,
        autoMatchEnabled: recurrence.autoMatchEnabled,
        minimumConfirmations: recurrence.minimumConfirmations,
      },
      transactions: transactions.map((transaction) => ({
        id: transaction.id,
        postedAt: transaction.postedAt,
        amountCents: transaction.amountCents,
        currency: transaction.currency,
        description: transaction.description,
        status: transaction.status,
        accountId: transaction.accountId,
        creditCardId: transaction.creditCardId,
        counterpartyAccountId: transaction.counterpartyAccountId,
        reconciliationType:
          reconciliationByTransaction.get(transaction.id) ?? null,
      })),
      learning: {
        confirmedCount: confirmedForRecurrence.length,
        aliases: learnedTransactions.map((transaction) =>
          merchantSignature(transaction.description),
        ),
        accountIds: [
          ...(recurrence.accountId ? [recurrence.accountId] : []),
          ...learnedTransactions.flatMap((transaction) =>
            transaction.accountId ? [transaction.accountId] : [],
          ),
        ],
        creditCardIds: [
          ...(recurrence.creditCardId ? [recurrence.creditCardId] : []),
          ...learnedTransactions.flatMap((transaction) =>
            transaction.creditCardId ? [transaction.creditCardId] : [],
          ),
        ],
        medianDateOffsetDays,
        dateSpreadDays:
          medianDateOffsetDays === undefined
            ? undefined
            : Math.max(
                ...learnedObservations.map((observation) =>
                  Math.abs(observation.dateOffset - medianDateOffsetDays),
                ),
              ),
        amountRangeCents: learnedAmounts.length
          ? {
              min: Math.min(...learnedAmounts),
              max: Math.max(...learnedAmounts),
            }
          : undefined,
        rejectionCount: rejectedCount,
      },
      unavailableTransactionIds,
    })
    for (const candidate of candidates.slice(0, 3)) {
      const existing = existingMatches.find(
        (match) =>
          match.occurrenceId === occurrence.id &&
          match.transactionId === candidate.transactionId,
      )
      if (existing && existing.status !== 'suggested') continue
      if (!existing) {
        const id = randomUUID()
        await db.insert(schema.recurrenceMatches).values({
          id,
          occurrenceId: occurrence.id,
          transactionId: candidate.transactionId,
          status: 'suggested',
          score: candidate.score,
          reason: candidate.reason,
          evidenceJson: JSON.stringify(candidate.evidence),
        })
        existingMatches.push({
          id,
          occurrenceId: occurrence.id,
          transactionId: candidate.transactionId,
          status: 'suggested',
          score: candidate.score,
          reason: candidate.reason,
          evidenceJson: JSON.stringify(candidate.evidence),
          previousCategoryId: null,
          categoryAppliedByMatch: false,
          categoryConflict: false,
          confirmedAt: null,
          resolvedAt: null,
          createdAt: new Date(),
        })
      }
      // Automation is deliberately unavailable until real confirmations have
      // built history. Once eligible, it uses the exact same reversible path.
      if (candidate.autoConfirm) {
        await confirmRecurrenceMatchInternal(
          existing?.id ?? existingMatches.at(-1)!.id,
          true,
        )
        unavailableTransactionIds.add(candidate.transactionId)
        break
      }
    }
  }

  return {
    occurrenceCount: existingOccurrences.length,
    suggestionCount: existingMatches.filter(
      (match) => match.status === 'suggested',
    ).length,
  }
}

async function transactionBelongsToCompany(transaction: {
  accountId: string | null
  creditCardId: string | null
}) {
  const account = transaction.accountId
    ? await db
        .select({ scopeId: schema.accounts.ownershipScopeId })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, transaction.accountId))
        .limit(1)
    : []
  const card = transaction.creditCardId
    ? await db
        .select({ scopeId: schema.creditCards.ownershipScopeId })
        .from(schema.creditCards)
        .where(eq(schema.creditCards.id, transaction.creditCardId))
        .limit(1)
    : []
  const scopeId = account[0]?.scopeId ?? card[0]?.scopeId
  if (!scopeId) return false
  const scope = await db
    .select({ type: schema.ownershipScopes.type })
    .from(schema.ownershipScopes)
    .where(eq(schema.ownershipScopes.id, scopeId))
    .limit(1)
  return scope[0]?.type === 'company_br' || scope[0]?.type === 'company_us'
}

export async function confirmRecurrenceMatchInternal(
  matchId: string,
  automatic: boolean,
) {
  const match = await db
    .select()
    .from(schema.recurrenceMatches)
    .where(eq(schema.recurrenceMatches.id, matchId))
    .limit(1)
  if (!match[0]) throw new Error('Correspondência não encontrada.')
  const occurrence = await db
    .select()
    .from(schema.recurrenceOccurrences)
    .where(eq(schema.recurrenceOccurrences.id, match[0].occurrenceId))
    .limit(1)
  const transaction = await db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.id, match[0].transactionId))
    .limit(1)
  if (!occurrence[0] || !transaction[0]) {
    throw new Error('A ocorrência ou transação não existe mais.')
  }
  if (match[0].status !== 'suggested' || occurrence[0].status !== 'expected') {
    throw new Error('Esta correspondência não está mais disponível.')
  }
  if (transaction[0].status !== 'confirmed') {
    throw new Error('Confirme a transação antes de conciliá-la.')
  }
  const recurrence = await db
    .select()
    .from(schema.recurrences)
    .where(eq(schema.recurrences.id, occurrence[0].recurrenceId))
    .limit(1)
  if (!recurrence[0]?.active) {
    throw new Error('Reative a recorrência antes de confirmar um pagamento.')
  }
  const financialLinks = await db
    .select()
    .from(schema.reconciliationLinks)
    .where(eq(schema.reconciliationLinks.transactionId, transaction[0].id))
  if (financialLinks.length) {
    const linkedGroups = await db.select().from(schema.reconciliationGroups)
    // Estornos e distribuições de lucro convivem com a recorrência; só
    // transferências e pagamento de fatura precisam ser desfeitos antes.
    const hasActiveFinancialReconciliation = financialLinks.some((link) => {
      const group = linkedGroups.find((item) => item.id === link.groupId)
      return (
        group &&
        group.status !== 'rejected' &&
        !transactionEligibleForRecurrence({ reconciliationType: group.type })
      )
    })
    if (hasActiveFinancialReconciliation) {
      throw new Error('Resolva primeiro a conciliação financeira da transação.')
    }
  }
  const companyTransaction = await transactionBelongsToCompany(transaction[0])
  const categoryCanBeApplied =
    !companyTransaction &&
    (!transaction[0].categoryId ||
      transaction[0].categoryId === 'uncategorized')
  const categoryConflict =
    !companyTransaction &&
    Boolean(
      transaction[0].categoryId &&
      transaction[0].categoryId !== 'uncategorized' &&
      transaction[0].categoryId !== occurrence[0].categoryId,
    )
  db.transaction((tx) => {
    if (categoryCanBeApplied) {
      tx.update(schema.transactions)
        .set({ categoryId: occurrence[0].categoryId })
        .where(eq(schema.transactions.id, transaction[0].id))
        .run()
    }
    tx.update(schema.recurrenceMatches)
      .set({
        status: automatic ? 'auto_confirmed' : 'confirmed',
        previousCategoryId: transaction[0].categoryId,
        categoryAppliedByMatch: categoryCanBeApplied,
        categoryConflict,
        confirmedAt: new Date(),
        resolvedAt: new Date(),
      })
      .where(eq(schema.recurrenceMatches.id, matchId))
      .run()
    // Envelopes (agregado) ficam abertos até o período terminar ou a pessoa
    // concluir; só recorrências de pagamento único fecham no primeiro vínculo.
    if (recurrence[0].matchMode !== 'aggregate') {
      tx.update(schema.recurrenceOccurrences)
        .set({ status: 'matched', resolvedAt: new Date() })
        .where(eq(schema.recurrenceOccurrences.id, occurrence[0].id))
        .run()
      if (occurrence[0].expectedDate >= recurrence[0].nextDate) {
        tx.update(schema.recurrences)
          .set({
            nextDate: addRecurrencePeriod(
              occurrence[0].expectedDate,
              recurrence[0].frequency,
              recurrence[0].scheduleAnchor,
            ),
          })
          .where(eq(schema.recurrences.id, recurrence[0].id))
          .run()
      }
    }
  })
  return { id: matchId }
}

type RefreshRow = typeof schema.transactions.$inferSelect
type RefreshMatch = typeof schema.recurrenceMatches.$inferSelect

/** Janela de um envelope: do dia esperado até o dia esperado seguinte (exclusivo). */
export function aggregateWindow(
  occurrence: { expectedDate: string },
  recurrence: { frequency: 'monthly' | 'yearly'; scheduleAnchor: string },
) {
  return {
    start: occurrence.expectedDate,
    end: addRecurrencePeriod(
      occurrence.expectedDate,
      recurrence.frequency,
      recurrence.scheduleAnchor,
    ),
  }
}

/**
 * Envelope: dentro da janela, lançamentos de estabelecimentos já confirmados
 * entram sozinhos; os da mesma categoria viram sugestão. Quando a janela
 * termina e há lançamentos vinculados, a ocorrência fecha com o total real.
 */
async function refreshAggregateOccurrence(input: {
  recurrence: typeof schema.recurrences.$inferSelect
  occurrence: typeof schema.recurrenceOccurrences.$inferSelect
  transactions: RefreshRow[]
  existingMatches: RefreshMatch[]
  learnedTransactions: RefreshRow[]
  reconciliationByTransaction: Map<string, RecurrenceReconciliationType>
  unavailableTransactionIds: Set<string>
}) {
  const {
    recurrence,
    occurrence,
    transactions,
    existingMatches,
    learnedTransactions,
    reconciliationByTransaction,
    unavailableTransactionIds,
  } = input
  const today = new Date().toISOString().slice(0, 10)
  const window = aggregateWindow(occurrence, recurrence)
  const windowEnded = window.end <= today
  const aliases = new Set(
    learnedTransactions
      .map((transaction) => merchantSignature(transaction.description))
      .filter((signature) => signature.length > 1),
  )
  const expectedSign = occurrence.direction === 'expense' ? -1 : 1
  for (const transaction of transactions) {
    if (transaction.status !== 'confirmed') continue
    if (transaction.currency !== occurrence.currency) continue
    if (Math.sign(transaction.amountCents) !== expectedSign) continue
    if (unavailableTransactionIds.has(transaction.id)) continue
    if (
      !transactionEligibleForRecurrence({
        counterpartyAccountId: transaction.counterpartyAccountId,
        reconciliationType:
          reconciliationByTransaction.get(transaction.id) ?? null,
      })
    ) {
      continue
    }
    if (
      transaction.postedAt < window.start ||
      transaction.postedAt >= window.end
    ) {
      continue
    }
    const signature = merchantSignature(transaction.description)
    const knownMerchant = aliases.has(signature)
    const sameCategory =
      recurrence.categoryId !== null &&
      transaction.categoryId === recurrence.categoryId
    // Distribuição de lucro conciliada já tem origem comprovada (a própria
    // empresa), então entra sem pedir confirmação, como um remetente aprendido.
    const trustedDistribution =
      occurrence.direction === 'income' &&
      sameCategory &&
      reconciliationByTransaction.get(transaction.id) === 'profit_distribution'
    const autoConfirm = knownMerchant || trustedDistribution
    if (!knownMerchant && !sameCategory) continue
    const existing = existingMatches.find(
      (match) =>
        match.occurrenceId === occurrence.id &&
        match.transactionId === transaction.id,
    )
    if (existing && existing.status !== 'suggested') continue
    let matchId = existing?.id
    if (!matchId) {
      matchId = randomUUID()
      const row = {
        id: matchId,
        occurrenceId: occurrence.id,
        transactionId: transaction.id,
        status: 'suggested' as const,
        score: autoConfirm ? 95 : 60,
        reason: knownMerchant
          ? 'estabelecimento já confirmado neste envelope'
          : trustedDistribution
            ? 'distribuição de lucro conciliada no período'
            : 'mesma categoria no período',
        evidenceJson: JSON.stringify({
          aggregate: true,
          knownMerchant,
          trustedDistribution,
        }),
      }
      await db.insert(schema.recurrenceMatches).values(row)
      existingMatches.push({
        ...row,
        previousCategoryId: null,
        categoryAppliedByMatch: false,
        categoryConflict: false,
        confirmedAt: null,
        resolvedAt: null,
        createdAt: new Date(),
      })
    }
    if (autoConfirm) {
      await confirmRecurrenceMatchInternal(matchId, true)
      unavailableTransactionIds.add(transaction.id)
      const stored = existingMatches.find((match) => match.id === matchId)
      if (stored) stored.status = 'auto_confirmed'
    }
  }
  // Só depois de varrer o período (lançamentos importados tarde entram aqui)
  // decidimos fechar o envelope. Sem nenhum aceito, ele fica aberto para revisão.
  if (windowEnded) {
    const accepted = existingMatches.filter(
      (match) =>
        match.occurrenceId === occurrence.id &&
        isAcceptedRecurrenceMatchStatus(match.status),
    )
    if (accepted.length) await closeAggregateOccurrence(occurrence.id)
  }
}

async function closeAggregateOccurrence(occurrenceId: string) {
  const occurrence = await db
    .select()
    .from(schema.recurrenceOccurrences)
    .where(eq(schema.recurrenceOccurrences.id, occurrenceId))
    .limit(1)
  if (!occurrence[0]) throw new Error('Ocorrência não encontrada.')
  const recurrence = await db
    .select()
    .from(schema.recurrences)
    .where(eq(schema.recurrences.id, occurrence[0].recurrenceId))
    .limit(1)
  db.transaction((tx) => {
    tx.update(schema.recurrenceOccurrences)
      .set({ status: 'matched', resolvedAt: new Date() })
      .where(eq(schema.recurrenceOccurrences.id, occurrenceId))
      .run()
    tx.update(schema.recurrenceMatches)
      .set({ status: 'rejected', resolvedAt: new Date() })
      .where(
        and(
          eq(schema.recurrenceMatches.occurrenceId, occurrenceId),
          eq(schema.recurrenceMatches.status, 'suggested'),
        ),
      )
      .run()
    if (recurrence[0] && occurrence[0].expectedDate >= recurrence[0].nextDate) {
      tx.update(schema.recurrences)
        .set({
          nextDate: addRecurrencePeriod(
            occurrence[0].expectedDate,
            recurrence[0].frequency,
            recurrence[0].scheduleAnchor,
          ),
        })
        .where(eq(schema.recurrences.id, recurrence[0].id))
        .run()
    }
  })
}

/** Fecha manualmente o envelope do período com o que já foi vinculado. */
export async function completeRecurrenceOccurrence(occurrenceId: string) {
  await ensureDatabase()
  const occurrence = await db
    .select()
    .from(schema.recurrenceOccurrences)
    .where(eq(schema.recurrenceOccurrences.id, occurrenceId))
    .limit(1)
  if (occurrence[0]?.status !== 'expected') {
    throw new Error('Somente ocorrências abertas podem ser concluídas.')
  }
  const accepted = await db
    .select()
    .from(schema.recurrenceMatches)
    .where(eq(schema.recurrenceMatches.occurrenceId, occurrenceId))
  if (
    !accepted.some((match) => isAcceptedRecurrenceMatchStatus(match.status))
  ) {
    throw new Error(
      'Vincule pelo menos um lançamento antes de concluir o período.',
    )
  }
  await closeAggregateOccurrence(occurrenceId)
  await refreshRecurrenceSuggestions()
  return { id: occurrenceId }
}

export async function confirmRecurrenceMatch(matchId: string) {
  await ensureDatabase()
  const result = await confirmRecurrenceMatchInternal(matchId, false)
  // Num envelope, confirmar um estabelecimento ensina o alias: os outros
  // lançamentos do mesmo lugar no período entram na hora.
  const match = await db
    .select({ occurrenceId: schema.recurrenceMatches.occurrenceId })
    .from(schema.recurrenceMatches)
    .where(eq(schema.recurrenceMatches.id, matchId))
    .limit(1)
  const occurrence = match[0]
    ? await db
        .select({ recurrenceId: schema.recurrenceOccurrences.recurrenceId })
        .from(schema.recurrenceOccurrences)
        .where(eq(schema.recurrenceOccurrences.id, match[0].occurrenceId))
        .limit(1)
    : []
  const recurrence = occurrence[0]
    ? await db
        .select({ matchMode: schema.recurrences.matchMode })
        .from(schema.recurrences)
        .where(eq(schema.recurrences.id, occurrence[0].recurrenceId))
        .limit(1)
    : []
  if (recurrence[0]?.matchMode === 'aggregate') {
    await refreshRecurrenceSuggestions()
  }
  return result
}

export async function rejectRecurrenceMatch(matchId: string) {
  await ensureDatabase()
  const match = await db
    .select({ status: schema.recurrenceMatches.status })
    .from(schema.recurrenceMatches)
    .where(eq(schema.recurrenceMatches.id, matchId))
    .limit(1)
  if (match[0]?.status !== 'suggested') {
    throw new Error('Somente sugestões abertas podem ser rejeitadas.')
  }
  await db
    .update(schema.recurrenceMatches)
    .set({ status: 'rejected', resolvedAt: new Date() })
    .where(eq(schema.recurrenceMatches.id, matchId))
  return { id: matchId }
}

export async function unlinkRecurrenceMatch(matchId: string) {
  await ensureDatabase()
  const match = await db
    .select()
    .from(schema.recurrenceMatches)
    .where(eq(schema.recurrenceMatches.id, matchId))
    .limit(1)
  if (!match[0]) throw new Error('Correspondência não encontrada.')
  if (!isAcceptedRecurrenceMatchStatus(match[0].status)) {
    throw new Error('Somente vínculos confirmados podem ser desfeitos.')
  }
  const occurrence = await db
    .select()
    .from(schema.recurrenceOccurrences)
    .where(eq(schema.recurrenceOccurrences.id, match[0].occurrenceId))
    .limit(1)
  const transaction = await db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.id, match[0].transactionId))
    .limit(1)
  const recurrence = occurrence[0]
    ? await db
        .select()
        .from(schema.recurrences)
        .where(eq(schema.recurrences.id, occurrence[0].recurrenceId))
        .limit(1)
    : []
  db.transaction((tx) => {
    if (
      match[0].categoryAppliedByMatch &&
      occurrence[0] &&
      transaction[0]?.categoryId === occurrence[0].categoryId
    ) {
      tx.update(schema.transactions)
        .set({ categoryId: match[0].previousCategoryId })
        .where(eq(schema.transactions.id, transaction[0].id))
        .run()
    }
    tx.update(schema.recurrenceMatches)
      .set({ status: 'unlinked', resolvedAt: new Date() })
      .where(eq(schema.recurrenceMatches.id, matchId))
      .run()
    if (occurrence[0]) {
      tx.update(schema.recurrenceOccurrences)
        .set({ status: 'expected', resolvedAt: null })
        .where(eq(schema.recurrenceOccurrences.id, occurrence[0].id))
        .run()
      if (
        recurrence[0] &&
        occurrence[0].expectedDate < recurrence[0].nextDate
      ) {
        tx.update(schema.recurrences)
          .set({ nextDate: occurrence[0].expectedDate })
          .where(eq(schema.recurrences.id, recurrence[0].id))
          .run()
      }
    }
  })
  return { id: matchId }
}

export async function skipRecurrenceOccurrence(occurrenceId: string) {
  await ensureDatabase()
  const occurrence = await db
    .select()
    .from(schema.recurrenceOccurrences)
    .where(eq(schema.recurrenceOccurrences.id, occurrenceId))
    .limit(1)
  if (occurrence[0]?.status !== 'expected') {
    throw new Error('Somente ocorrências pendentes podem ser ignoradas.')
  }
  const recurrence = await db
    .select()
    .from(schema.recurrences)
    .where(eq(schema.recurrences.id, occurrence[0].recurrenceId))
    .limit(1)
  db.transaction((tx) => {
    tx.update(schema.recurrenceOccurrences)
      .set({ status: 'skipped', resolvedAt: new Date() })
      .where(eq(schema.recurrenceOccurrences.id, occurrenceId))
      .run()
    tx.update(schema.recurrenceMatches)
      .set({ status: 'rejected', resolvedAt: new Date() })
      .where(
        and(
          eq(schema.recurrenceMatches.occurrenceId, occurrenceId),
          eq(schema.recurrenceMatches.status, 'suggested'),
        ),
      )
      .run()
    if (recurrence[0] && occurrence[0].expectedDate >= recurrence[0].nextDate) {
      tx.update(schema.recurrences)
        .set({
          nextDate: addRecurrencePeriod(
            occurrence[0].expectedDate,
            recurrence[0].frequency,
            recurrence[0].scheduleAnchor,
          ),
        })
        .where(eq(schema.recurrences.id, recurrence[0].id))
        .run()
    }
  })
  await refreshRecurrenceSuggestions()
  return { id: occurrenceId }
}

/**
 * Vínculo manual: a pessoa escolhe a transação que pagou a ocorrência e o
 * sistema segue o mesmo caminho da confirmação (categoria, próxima data,
 * aprendizado de alias e destino para as próximas buscas).
 */
export async function linkRecurrenceOccurrence(input: {
  occurrenceId: string
  transactionIds: string[]
}) {
  await ensureDatabase()
  const occurrence = await db
    .select()
    .from(schema.recurrenceOccurrences)
    .where(eq(schema.recurrenceOccurrences.id, input.occurrenceId))
    .limit(1)
  if (!occurrence[0]) throw new Error('Ocorrência não encontrada.')
  if (occurrence[0].status !== 'expected') {
    throw new Error('Esta ocorrência já foi resolvida.')
  }
  const recurrence = await db
    .select()
    .from(schema.recurrences)
    .where(eq(schema.recurrences.id, occurrence[0].recurrenceId))
    .limit(1)
  if (
    recurrence[0]?.matchMode !== 'aggregate' &&
    input.transactionIds.length > 1
  ) {
    throw new Error(
      'Esta recorrência aceita um pagamento por período. Para somar vários lançamentos, marque-a como envelope.',
    )
  }
  let linked = 0
  for (const transactionId of input.transactionIds) {
    await linkSingleTransaction(occurrence[0], transactionId)
    linked += 1
  }
  return { id: input.occurrenceId, linked }
}

async function linkSingleTransaction(
  occurrence: typeof schema.recurrenceOccurrences.$inferSelect,
  transactionId: string,
) {
  const transaction = await db
    .select()
    .from(schema.transactions)
    .where(eq(schema.transactions.id, transactionId))
    .limit(1)
  if (!transaction[0]) throw new Error('Transação não encontrada.')
  if (transaction[0].status !== 'confirmed') {
    throw new Error('Confirme a transação antes de vinculá-la.')
  }
  if (transaction[0].currency !== occurrence.currency) {
    throw new Error(
      `Esta recorrência é em ${occurrence.currency}; escolha uma transação na mesma moeda.`,
    )
  }
  const expectedSign = occurrence.direction === 'expense' ? -1 : 1
  if (Math.sign(transaction[0].amountCents) !== expectedSign) {
    throw new Error(
      occurrence.direction === 'expense'
        ? 'Esta recorrência é uma despesa; escolha uma saída.'
        : 'Esta recorrência é uma receita; escolha uma entrada.',
    )
  }
  const matchesForTransaction = await db
    .select()
    .from(schema.recurrenceMatches)
    .where(eq(schema.recurrenceMatches.transactionId, transactionId))
  if (
    matchesForTransaction.some((match) =>
      isAcceptedRecurrenceMatchStatus(match.status),
    )
  ) {
    throw new Error('Esta transação já está vinculada a outra recorrência.')
  }
  const existing = matchesForTransaction.find(
    (match) => match.occurrenceId === occurrence.id,
  )
  const matchId = existing?.id ?? randomUUID()
  const manual = {
    status: 'suggested' as const,
    score: 100,
    reason: 'vinculado manualmente',
    evidenceJson: JSON.stringify({ manual: true }),
    resolvedAt: null,
  }
  if (existing) {
    await db
      .update(schema.recurrenceMatches)
      .set(manual)
      .where(eq(schema.recurrenceMatches.id, matchId))
  } else {
    await db.insert(schema.recurrenceMatches).values({
      id: matchId,
      occurrenceId: occurrence.id,
      transactionId,
      ...manual,
    })
  }
  return confirmRecurrenceMatchInternal(matchId, false)
}
