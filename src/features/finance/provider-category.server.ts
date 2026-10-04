import { isNotNull, sql } from 'drizzle-orm'

import { db } from '#/db/index.server'
import * as schema from '#/db/schema'

/**
 * Provider category (Pluggy) of the observation backing each ledger row.
 * Pending or rejected corrections and deletions don't describe the current
 * fact; among the rest, the latest observation wins, and the later insertion
 * among those observed in the same second.
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
      rowid: sql<number>`${schema.openFinanceTransactionObservations}.rowid`,
    })
    .from(schema.openFinanceTransactionObservations)
    .where(
      isNotNull(
        schema.openFinanceTransactionObservations.canonicalTransactionId,
      ),
    )
  const providerCategory = new Map<string, string | null>()
  const latest = new Map<string, { observedAt: number; rowid: number }>()
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
    const previous = latest.get(observation.transactionId)
    if (
      previous &&
      (previous.observedAt > observedAt ||
        (previous.observedAt === observedAt &&
          previous.rowid > observation.rowid))
    )
      continue
    latest.set(observation.transactionId, {
      observedAt,
      rowid: observation.rowid,
    })
    providerCategory.set(
      observation.transactionId,
      observation.providerCategory,
    )
  }
  return providerCategory
}
