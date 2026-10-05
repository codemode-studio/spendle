import * as Effect from 'effect/Effect'

import type { FamilyTransaction } from '#/lib/ledger'
import type { V2Client } from '#/lib/v2/client.server'

import { allEntries } from '#/lib/v2/client.server'

const otherColor = '#94a3b8'

/**
 * Every entry as the category analysis reads it, in reais: entries in
 * other currencies at the rate of their date, and left out only without
 * one. Transfers and bill payments keep their system category, which is
 * outside the spending buckets; entries without a category count as
 * uncategorized.
 */
export function categoryLedger(client: V2Client) {
  return Effect.gen(function* () {
    const [entries, categories, accounts] = yield* Effect.all([
      allEntries(client, {}),
      client.categories.list({ query: { includeArchived: true } }),
      client.accounts.list({ query: { includeArchived: true } }),
    ])
    const categoryById = new Map(categories.map((item) => [item.id, item]))
    const cards = new Set(
      accounts
        .filter((account) => account.kind === 'credit_card')
        .map((account) => account.id),
    )
    return entries.flatMap((entry): Array<FamilyTransaction> => {
      const amountCents =
        entry.currency === 'BRL'
          ? entry.amountCents
          : (entry.converted?.cents ?? null)
      if (amountCents === null) return []
      const categoryId = entry.category?.categoryId ?? null
      const category = categoryId ? categoryById.get(categoryId) : undefined
      const uncategorized =
        !category || category.id === 'uncategorized'
          ? !entry.category?.excludedFromSpending
          : false
      return [
        {
          id: entry.id,
          postedAt: entry.bookedOn,
          description: entry.description,
          normalized: entry.description.toLowerCase(),
          amountCents,
          categoryId: uncategorized ? null : (category?.id ?? null),
          categoryName: uncategorized
            ? 'Sem categoria'
            : (category?.name ?? 'Sem categoria'),
          color: category?.color ?? otherColor,
          bucket: uncategorized ? null : (category?.bucket ?? null),
          source: cards.has(entry.accountId) ? 'card' : 'account',
          uncategorized,
        },
      ]
    })
  })
}
