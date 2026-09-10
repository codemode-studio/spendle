import { desc, eq } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import { familyTransactions } from '#/domain/ledger'

/** Carrega somente os fatos usados na análise de categorias. */
export async function getCategoryTransactions() {
  await ensureDatabase()
  const [scopes, transactions, links] = await Promise.all([
    db
      .select({
        id: schema.ownershipScopes.id,
        type: schema.ownershipScopes.type,
      })
      .from(schema.ownershipScopes),
    db
      .select({
        id: schema.transactions.id,
        postedAt: schema.transactions.postedAt,
        description: schema.transactions.description,
        normalizedDescription: schema.transactions.normalizedDescription,
        amountCents: schema.transactions.amountCents,
        baseAmountCents: schema.transactions.baseAmountCents,
        currency: schema.transactions.currency,
        status: schema.transactions.status,
        counterpartyAccountId: schema.transactions.counterpartyAccountId,
        creditCardId: schema.transactions.creditCardId,
        account: { ownershipScopeId: schema.accounts.ownershipScopeId },
        creditCard: { ownershipScopeId: schema.creditCards.ownershipScopeId },
        category: {
          id: schema.categories.id,
          name: schema.categories.name,
          color: schema.categories.color,
          bucket: schema.categories.bucket,
        },
      })
      .from(schema.transactions)
      .leftJoin(
        schema.accounts,
        eq(schema.transactions.accountId, schema.accounts.id),
      )
      .leftJoin(
        schema.creditCards,
        eq(schema.transactions.creditCardId, schema.creditCards.id),
      )
      .leftJoin(
        schema.categories,
        eq(schema.transactions.categoryId, schema.categories.id),
      )
      .orderBy(desc(schema.transactions.postedAt)),
    db
      .select({
        id: schema.reconciliationGroups.id,
        type: schema.reconciliationGroups.type,
        status: schema.reconciliationGroups.status,
        transactionId: schema.reconciliationLinks.transactionId,
      })
      .from(schema.reconciliationGroups)
      .leftJoin(
        schema.reconciliationLinks,
        eq(schema.reconciliationLinks.groupId, schema.reconciliationGroups.id),
      ),
  ])
  const groups = new Map<
    string,
    { type: string; status: string; links: Array<{ transactionId: string }> }
  >()
  for (const link of links) {
    const group = groups.get(link.id) ?? {
      type: link.type,
      status: link.status,
      links: [],
    }
    if (link.transactionId)
      group.links.push({ transactionId: link.transactionId })
    groups.set(link.id, group)
  }
  return familyTransactions({
    scopes,
    transactions,
    reconciliations: [...groups.values()],
  })
}
