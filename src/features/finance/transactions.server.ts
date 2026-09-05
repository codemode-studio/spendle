import { and, count, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import { normalizeDescription } from '#/domain/finance'
import type { TransactionFilters } from './transactions.filters'

export async function getTransactionsPage(input: TransactionFilters) {
  await ensureDatabase()
  const t = schema.transactions
  const amount = sql`coalesce(${t.baseAmountCents}, ${t.amountCents})`
  const uncategorized = or(
    isNull(t.categoryId),
    eq(t.categoryId, 'uncategorized'),
  )
  const where = and(
    input.search
      ? sql`instr(normalize_description(${t.description}), ${normalizeDescription(input.search)}) > 0`
      : undefined,
    input.target !== 'all'
      ? or(eq(t.accountId, input.target), eq(t.creditCardId, input.target))
      : undefined,
    input.onlyUncategorized ? uncategorized : undefined,
    input.category !== 'all' ? eq(t.categoryId, input.category) : undefined,
    input.direction === 'in'
      ? sql`${amount} > 0`
      : input.direction === 'out'
        ? sql`${amount} < 0`
        : undefined,
    input.minCents !== null
      ? sql`abs(${amount}) >= ${input.minCents}`
      : undefined,
    input.maxCents !== null
      ? sql`abs(${amount}) <= ${input.maxCents}`
      : undefined,
  )
  const [{ total }] = await db.select({ total: count() }).from(t).where(where)
  const page = Math.min(input.page, Math.max(0, Math.ceil(total / 50) - 1))
  const [
    rows,
    accounts,
    cards,
    categories,
    groups,
    links,
    counts,
    [summary],
    [review],
  ] = await Promise.all([
    db
      .select()
      .from(t)
      .where(where)
      .orderBy(desc(t.postedAt), desc(t.id))
      .limit(50)
      .offset(page * 50),
    db.select().from(schema.accounts).orderBy(schema.accounts.name),
    db.select().from(schema.creditCards).orderBy(schema.creditCards.name),
    db.select().from(schema.categories).orderBy(schema.categories.name),
    db
      .select()
      .from(schema.reconciliationGroups)
      .orderBy(desc(schema.reconciliationGroups.createdAt)),
    db.select().from(schema.reconciliationLinks),
    db
      .select({ categoryId: t.categoryId, count: count() })
      .from(t)
      .groupBy(t.categoryId),
    db
      .select({
        total: count(),
        start: sql<string | null>`min(${t.postedAt})`,
        end: sql<string | null>`max(${t.postedAt})`,
        uncategorized: sql<number>`coalesce(sum(case when ${t.status} = 'confirmed' and (${uncategorized}) then 1 else 0 end), 0)`,
      })
      .from(t),
    db
      .select({ count: count() })
      .from(schema.stagedTransactions)
      .innerJoin(
        schema.imports,
        eq(schema.stagedTransactions.importId, schema.imports.id),
      )
      .where(eq(schema.imports.status, 'review')),
  ])
  const accountById = new Map(accounts.map((row) => [row.id, row]))
  const cardById = new Map(cards.map((row) => [row.id, row]))
  const categoryById = new Map(categories.map((row) => [row.id, row]))
  const enrich = (row: typeof t.$inferSelect) => ({
    ...row,
    account: row.accountId ? (accountById.get(row.accountId) ?? null) : null,
    creditCard: row.creditCardId
      ? (cardById.get(row.creditCardId) ?? null)
      : null,
    counterpartyAccount: row.counterpartyAccountId
      ? (accountById.get(row.counterpartyAccountId) ?? null)
      : null,
    category: row.categoryId
      ? (categoryById.get(row.categoryId) ?? null)
      : null,
  })
  const linkedIds = [...new Set(links.map((link) => link.transactionId))]
  const linkedRows = linkedIds.length
    ? await db.select().from(t).where(inArray(t.id, linkedIds))
    : []
  const linkedById = new Map(linkedRows.map((row) => [row.id, enrich(row)]))
  const linksByGroup = new Map<string, typeof links>()
  for (const link of links) {
    const group = linksByGroup.get(link.groupId) ?? []
    group.push(link)
    linksByGroup.set(link.groupId, group)
  }
  return {
    transactions: rows.map(enrich),
    accounts,
    cards,
    categories,
    reconciliations: groups.map((group) => ({
      ...group,
      links: (linksByGroup.get(group.id) ?? []).map((link) => ({
        ...link,
        transaction: linkedById.get(link.transactionId) ?? null,
      })),
    })),
    dashboard: { reviewTransactionCount: review.count },
    categoryCounts: counts,
    uncategorizedCount: summary.uncategorized,
    totalCount: summary.total,
    filteredCount: total,
    page,
    period:
      summary.start && summary.end
        ? { start: summary.start, end: summary.end }
        : null,
  }
}
