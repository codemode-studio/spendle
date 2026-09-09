import { and, count, eq, isNull, or } from 'drizzle-orm'
import { db, ensureDatabase } from '#/db/index.server'
import { accounts, creditCards, recurrences, transactions } from '#/db/schema'

/** Small setup read for the persistent sidebar; never loads ledger rows. */
export async function getOnboardingStatus() {
  await ensureDatabase()
  const hasAccount = Boolean(
    db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.active, true))
      .limit(1)
      .get(),
  )
  const hasCard = Boolean(
    db
      .select({ id: creditCards.id })
      .from(creditCards)
      .where(eq(creditCards.active, true))
      .limit(1)
      .get(),
  )
  const hasTransactions = Boolean(
    db
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.status, 'confirmed'))
      .limit(1)
      .get(),
  )
  const uncategorizedCount = db
    .select({ value: count() })
    .from(transactions)
    .where(
      and(
        eq(transactions.status, 'confirmed'),
        or(
          isNull(transactions.categoryId),
          eq(transactions.categoryId, 'uncategorized'),
        ),
      ),
    )
    .get()!.value
  const hasRecurrences = Boolean(
    db
      .select({ id: recurrences.id })
      .from(recurrences)
      .where(eq(recurrences.active, true))
      .limit(1)
      .get(),
  )
  return {
    accounts: hasAccount || hasCard,
    transactions: hasTransactions,
    categories: hasTransactions && uncategorizedCount === 0,
    recurrences: hasRecurrences,
    uncategorizedCount,
  }
}
