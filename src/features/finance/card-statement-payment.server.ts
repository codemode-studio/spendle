import { randomUUID } from 'node:crypto'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import { isSettlementCategory } from '#/domain/card-payment'
import { formatInstrumentName } from '#/domain/finance'
import { assertIsoDate, daysBetween } from '#/domain/period'
import { refreshReconciliationAfterCommit } from './reconciliation-refresh.server'

// The person decides which bank debit paid a statement. The link is a record;
// the ledger on the Cartões page reads it as the strongest evidence.

const CANDIDATE_WINDOW_DAYS = 45

export interface StatementPaymentCandidate {
  id: string
  postedAt: string
  description: string
  amountCents: number
  currency: string
  accountLabel: string | null
  categoryName: string | null
  amountDifferenceCents: number | null
  daysApart: number
  linkedToDueDate: string | null
}

export async function listCardStatementPaymentCandidates(input: {
  creditCardId: string
  dueDate: string
  /** Statement total, used only to rank exact matches first. */
  amountCents?: number
}): Promise<StatementPaymentCandidate[]> {
  assertIsoDate(input.dueDate)
  await ensureDatabase()
  const card = (
    await db
      .select({ currency: schema.creditCards.currency })
      .from(schema.creditCards)
      .where(eq(schema.creditCards.id, input.creditCardId))
      .limit(1)
  ).at(0)
  if (!card) throw new Error('Cartão não encontrado.')
  const [rows, links, groups, groupLinks, accounts, categories] =
    await Promise.all([
      db
        .select()
        .from(schema.transactions)
        .where(
          and(
            isNotNull(schema.transactions.accountId),
            eq(schema.transactions.status, 'confirmed'),
            // Minor units of different currencies are not comparable.
            eq(schema.transactions.currency, card.currency),
          ),
        ),
      db.select().from(schema.cardStatementPayments),
      db
        .select()
        .from(schema.reconciliationGroups)
        .where(
          and(
            eq(schema.reconciliationGroups.type, 'card_payment'),
            eq(schema.reconciliationGroups.status, 'confirmed'),
          ),
        ),
      db.select().from(schema.reconciliationLinks),
      db.select().from(schema.accounts),
      db.select().from(schema.categories),
    ])
  const confirmedGroupIds = new Set(groups.map((group) => group.id))
  const reconciled = new Set(
    groupLinks
      .filter((link) => confirmedGroupIds.has(link.groupId))
      .map((link) => link.transactionId),
  )
  const linkByTransaction = new Map(
    links.map((link) => [link.transactionId, link]),
  )
  const accountById = new Map(accounts.map((row) => [row.id, row]))
  const categoryById = new Map(categories.map((row) => [row.id, row]))

  return rows
    .flatMap((row) => {
      if (row.amountCents >= 0 || reconciled.has(row.id)) return []
      const link = linkByTransaction.get(row.id)
      // Already the answer for this statement, or taken by another one.
      if (
        link &&
        link.creditCardId === input.creditCardId &&
        link.dueDate === input.dueDate
      )
        return []
      const daysApart = daysBetween(row.postedAt, input.dueDate, {
        inclusive: false,
        absolute: true,
      })
      if (daysApart > CANDIDATE_WINDOW_DAYS) return []
      const account = row.accountId ? accountById.get(row.accountId) : null
      return [
        {
          id: row.id,
          postedAt: row.postedAt,
          description: row.description,
          amountCents: row.amountCents,
          currency: row.currency,
          accountLabel: account ? formatInstrumentName(account.name) : null,
          categoryName: row.categoryId
            ? (categoryById.get(row.categoryId)?.name ?? null)
            : null,
          amountDifferenceCents:
            input.amountCents === undefined
              ? null
              : Math.abs(-row.amountCents - input.amountCents),
          daysApart,
          linkedToDueDate: link?.dueDate ?? null,
        },
      ]
    })
    .sort(
      (left, right) =>
        (left.amountDifferenceCents ?? 0) -
          (right.amountDifferenceCents ?? 0) ||
        left.daysApart - right.daysApart ||
        right.postedAt.localeCompare(left.postedAt),
    )
}

export async function linkCardStatementPayment(input: {
  creditCardId: string
  dueDate: string
  transactionId: string
  partial?: boolean
}) {
  assertIsoDate(input.dueDate)
  await ensureDatabase()
  const card = (
    await db
      .select()
      .from(schema.creditCards)
      .where(eq(schema.creditCards.id, input.creditCardId))
      .limit(1)
  ).at(0)
  if (!card) throw new Error('Cartão não encontrado.')
  const transaction = (
    await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, input.transactionId))
      .limit(1)
  ).at(0)
  if (!transaction) throw new Error('Lançamento não encontrado.')
  if (!transaction.accountId || transaction.amountCents >= 0)
    throw new Error('Escolha um débito de conta bancária.')
  if (transaction.currency !== card.currency)
    throw new Error(
      `Escolha um débito em ${card.currency}, a moeda da fatura deste cartão.`,
    )

  const existing = (
    await db
      .select()
      .from(schema.cardStatementPayments)
      .where(
        eq(schema.cardStatementPayments.transactionId, input.transactionId),
      )
      .limit(1)
  ).at(0)
  // Moving a link keeps the category the person had before the first link,
  // while the debit still carries the one that link assigned.
  const previousCategoryId =
    existing?.previousCategoryId && transaction.categoryId === 'card_payment'
      ? existing.previousCategoryId
      : isSettlementCategory(transaction.categoryId)
        ? null
        : transaction.categoryId

  const id = randomUUID()
  db.transaction((tx) => {
    // One debit settles one statement; relinking moves it.
    tx.delete(schema.cardStatementPayments)
      .where(
        eq(schema.cardStatementPayments.transactionId, input.transactionId),
      )
      .run()
    tx.insert(schema.cardStatementPayments)
      .values({
        id,
        creditCardId: input.creditCardId,
        dueDate: input.dueDate,
        transactionId: input.transactionId,
        previousCategoryId,
        partial: input.partial ?? false,
      })
      .run()
    if (!isSettlementCategory(transaction.categoryId)) {
      tx.update(schema.transactions)
        .set({ categoryId: 'card_payment' })
        .where(eq(schema.transactions.id, input.transactionId))
        .run()
    }
  })
  // The person's link outranks automatic matches of this debit.
  await refreshReconciliationAfterCommit()
  return { id }
}

export async function unlinkCardStatementPayment(input: { id: string }) {
  await ensureDatabase()
  const link = (
    await db
      .select()
      .from(schema.cardStatementPayments)
      .where(eq(schema.cardStatementPayments.id, input.id))
      .limit(1)
  ).at(0)
  if (!link) throw new Error('Vínculo não encontrado.')
  db.transaction((tx) => {
    tx.delete(schema.cardStatementPayments)
      .where(eq(schema.cardStatementPayments.id, input.id))
      .run()
    if (link.previousCategoryId) {
      // Only undo our own reclassification.
      tx.update(schema.transactions)
        .set({ categoryId: link.previousCategoryId })
        .where(
          and(
            eq(schema.transactions.id, link.transactionId),
            inArray(schema.transactions.categoryId, ['card_payment']),
          ),
        )
        .run()
    }
  })
  // Without the link the debit may pair again under the automatic rules.
  await refreshReconciliationAfterCommit()
  return { id: input.id }
}
