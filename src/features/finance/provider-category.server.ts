import { isNotNull } from 'drizzle-orm'

import { db } from '#/db/index.server'
import * as schema from '#/db/schema'

/**
 * Provider category (Pluggy) of the observation backing each ledger row.
 * Pending or rejected corrections and deletions don't describe the current
 * fact; among the rest, the latest observation wins.
 */
export async function readCurrentProviderCategories() {
  const rows = await db
    .select({
      transactionId:
        schema.openFinanceTransactionObservations.canonicalTransactionId,
      providerCategory:
        schema.openFinanceTransactionObservations.providerCategory,
      resolution: schema.openFinanceTransactionObservations.resolution,
      observedAt: schema.openFinanceTransactionObservations.observedAt,
    })
    .from(schema.openFinanceTransactionObservations)
    .where(
      isNotNull(
        schema.openFinanceTransactionObservations.canonicalTransactionId,
      ),
    )
  const providerCategory = new Map<string, string | null>()
  const providerObservedAt = new Map<string, number>()
  for (const observation of rows) {
    if (!observation.transactionId) continue
    if (
      observation.resolution === 'correction_pending' ||
      observation.resolution === 'rejected' ||
      observation.resolution === 'deleted'
    ) {
      continue
    }
    const observedAt = observation.observedAt.getTime()
    if ((providerObservedAt.get(observation.transactionId) ?? -1) > observedAt)
      continue
    providerObservedAt.set(observation.transactionId, observedAt)
    providerCategory.set(
      observation.transactionId,
      observation.providerCategory,
    )
  }
  return providerCategory
}
