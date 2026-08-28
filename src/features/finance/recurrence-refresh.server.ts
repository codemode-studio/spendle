import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import {
  addRecurrencePeriod,
  buildRecurrenceCandidates,
  isAcceptedRecurrenceMatchStatus,
  merchantSignature,
} from '#/domain/recurrence-matching'

function median(values: number[]) {
  if (!values.length) return undefined
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2
}

function occurrenceDates(input: {
  startsOn: string
  scheduleAnchor: string
  nextDate: string
  frequency: 'monthly' | 'yearly'
}) {
  const result: string[] = []
  let date = input.startsOn === '1970-01-01' ? input.nextDate : input.startsOn
  const lastDate =
    input.nextDate > new Date().toISOString().slice(0, 10)
      ? input.nextDate
      : new Date().toISOString().slice(0, 10)
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

async function confirmRecurrenceMatchInternal(
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
    const hasActiveFinancialReconciliation = financialLinks.some((link) => {
      const group = linkedGroups.find((item) => item.id === link.groupId)
      return group && group.status !== 'rejected' && group.type !== 'refund'
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
    tx.update(schema.recurrenceOccurrences)
      .set({ status: 'matched', resolvedAt: new Date() })
      .where(eq(schema.recurrenceOccurrences.id, occurrence[0].id))
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
  return { id: matchId }
}

export async function confirmRecurrenceMatch(matchId: string) {
  await ensureDatabase()
  return confirmRecurrenceMatchInternal(matchId, false)
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
