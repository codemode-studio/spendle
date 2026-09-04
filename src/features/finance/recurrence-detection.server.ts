import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import { detectRecurrences, detectionKey } from '#/domain/recurrence-detection'
import type { DetectedRecurrence } from '#/domain/recurrence-detection'
import {
  isAcceptedRecurrenceMatchStatus,
  merchantSignature,
} from '#/domain/recurrence-matching'
import { createRecurrence } from './finance.server'
import {
  confirmRecurrenceMatchInternal,
  refreshRecurrenceSuggestions,
} from './recurrence-refresh.server'

/** Categorias que nunca representam uma recorrência da família. */
const NEVER_RECURRING_CATEGORIES = new Set(['transfer', 'card_payment'])

export async function detectRecurrenceCandidates(): Promise<
  DetectedRecurrence[]
> {
  await ensureDatabase()
  const [transactions, recurrences, matches, groups, links, ignores] =
    await Promise.all([
      db.select().from(schema.transactions),
      db.select().from(schema.recurrences),
      db.select().from(schema.recurrenceMatches),
      db.select().from(schema.reconciliationGroups),
      db.select().from(schema.reconciliationLinks),
      db.select().from(schema.recurrenceDetectionIgnores),
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
  const acceptedTransactionIds = new Set(
    matches
      .filter((match) => isAcceptedRecurrenceMatchStatus(match.status))
      .map((match) => match.transactionId),
  )
  const transactionsById = new Map(
    transactions.map((transaction) => [transaction.id, transaction]),
  )
  const knownSignatures = new Set<string>()
  for (const recurrence of recurrences) {
    knownSignatures.add(merchantSignature(recurrence.name))
  }
  for (const transactionId of acceptedTransactionIds) {
    const transaction = transactionsById.get(transactionId)
    if (transaction)
      knownSignatures.add(merchantSignature(transaction.description))
  }
  knownSignatures.delete('')

  return detectRecurrences({
    transactions: transactions.map((transaction) => ({
      id: transaction.id,
      postedAt: transaction.postedAt,
      amountCents: transaction.amountCents,
      currency: transaction.currency,
      description: transaction.description,
      status: transaction.status,
      accountId: transaction.accountId,
      creditCardId: transaction.creditCardId,
      categoryId: transaction.categoryId,
      counterpartyAccountId: transaction.counterpartyAccountId,
      reconciliationType:
        reconciliationByTransaction.get(transaction.id) ?? null,
    })),
    excludedTransactionIds: acceptedTransactionIds,
    knownSignatures,
    ignoredKeys: new Set(
      ignores.map((item) => detectionKey(item.signature, item.direction)),
    ),
    excludedCategoryIds: NEVER_RECURRING_CATEGORIES,
  })
}

export type ApproveDetectedRecurrenceInput = {
  name: string
  categoryId: string
  amountCents: number
  currency: string
  direction: 'income' | 'expense'
  amountMode: 'fixed' | 'variable'
  frequency: 'monthly' | 'yearly'
  nextDate: string
  accountId?: string
  creditCardId?: string
  transactionIds: string[]
}

/**
 * Aprova um candidato: cria a recorrência e vincula os pagamentos passados como
 * ocorrências realizadas. A partir daí o motor de conciliação assume, já com
 * o estabelecimento e o destino aprendidos.
 */
export async function approveDetectedRecurrence(
  input: ApproveDetectedRecurrenceInput,
) {
  await ensureDatabase()
  const category = await db
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.id, input.categoryId))
    .limit(1)
  const allowedBuckets =
    input.direction === 'income' ? ['income'] : ['essential', 'lifestyle']
  if (!category[0] || !allowedBuckets.includes(category[0].bucket)) {
    throw new Error(
      input.direction === 'income'
        ? 'Escolha uma categoria de receita para esta recorrência.'
        : 'Escolha uma categoria de despesa (essencial ou estilo de vida).',
    )
  }
  const recurrence = await createRecurrence({
    name: input.name,
    categoryId: input.categoryId,
    amountCents: Math.abs(input.amountCents),
    currency: input.currency,
    direction: input.direction,
    amountMode: input.amountMode,
    destinationMode: 'automatic',
    frequency: input.frequency,
    nextDate: input.nextDate,
    accountId: input.accountId,
    creditCardId: input.creditCardId,
  })

  const expectedSign = input.direction === 'expense' ? -1 : 1
  let linked = 0
  for (const transactionId of input.transactionIds) {
    const transaction = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, transactionId))
      .limit(1)
    if (!transaction[0] || transaction[0].status !== 'confirmed') continue
    if (Math.sign(transaction[0].amountCents) !== expectedSign) continue
    const taken = await db
      .select()
      .from(schema.recurrenceMatches)
      .where(eq(schema.recurrenceMatches.transactionId, transactionId))
    if (taken.some((match) => isAcceptedRecurrenceMatchStatus(match.status))) {
      continue
    }
    const occurrenceId = randomUUID()
    await db.insert(schema.recurrenceOccurrences).values({
      id: occurrenceId,
      recurrenceId: recurrence.id,
      expectedDate: transaction[0].postedAt,
      expectedAmountCents: Math.abs(transaction[0].amountCents),
      currency: transaction[0].currency,
      direction: input.direction,
      categoryId: input.categoryId,
    })
    const matchId = randomUUID()
    await db.insert(schema.recurrenceMatches).values({
      id: matchId,
      occurrenceId,
      transactionId,
      status: 'suggested',
      score: 100,
      reason: 'aprovado na detecção',
      evidenceJson: JSON.stringify({ detected: true }),
    })
    await confirmRecurrenceMatchInternal(matchId, false)
    linked += 1
  }

  await refreshRecurrenceSuggestions()
  return { id: recurrence.id, linked }
}

export async function ignoreDetectedRecurrence(input: {
  signature: string
  direction: 'income' | 'expense'
}) {
  await ensureDatabase()
  await db
    .insert(schema.recurrenceDetectionIgnores)
    .values({ id: randomUUID(), ...input })
    .onConflictDoNothing()
  return { ignored: true }
}
