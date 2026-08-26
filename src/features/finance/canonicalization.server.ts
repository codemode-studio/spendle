import { createHash, randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'

import type { db } from '#/db/index.server'
import * as schema from '#/db/schema'
import { normalizeDescription } from '#/domain/finance'

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type MatchKind = NonNullable<
  typeof schema.transactionEvidence.$inferInsert.matchKind
>

export function transactionFingerprint(input: {
  postedAt: string
  amountCents: number
  description: string
  currency: string
}) {
  return createHash('sha256')
    .update(
      [
        input.postedAt.slice(0, 10),
        input.amountCents,
        normalizeDescription(input.description),
        input.currency,
      ].join('|'),
    )
    .digest('hex')
}

export function linkCanonicalObservation(
  transaction: DatabaseTransaction,
  input: {
    stagedTransactionId: string
    transactionId: string
    matchKind: MatchKind
    duplicate?: boolean
    duplicateReason?: null | 'external_id' | 'fingerprint_overlap'
    externalId?: string | null
    transactionStatus?: 'pending' | 'confirmed' | 'excluded'
  },
) {
  if (input.duplicate !== undefined || input.duplicateReason !== undefined) {
    transaction
      .update(schema.stagedTransactions)
      .set({
        ...(input.duplicate !== undefined
          ? { duplicate: input.duplicate }
          : {}),
        ...(input.duplicateReason !== undefined
          ? { duplicateReason: input.duplicateReason }
          : {}),
      })
      .where(eq(schema.stagedTransactions.id, input.stagedTransactionId))
      .run()
  }

  if (input.externalId) {
    transaction
      .update(schema.transactions)
      .set({ externalId: input.externalId })
      .where(
        and(
          eq(schema.transactions.id, input.transactionId),
          sql`${schema.transactions.externalId} is null`,
        ),
      )
      .run()
  }

  if (input.transactionStatus) {
    transaction
      .update(schema.transactions)
      .set({ status: input.transactionStatus })
      .where(eq(schema.transactions.id, input.transactionId))
      .run()
  }

  transaction
    .insert(schema.transactionEvidence)
    .values({
      id: randomUUID(),
      stagedTransactionId: input.stagedTransactionId,
      transactionId: input.transactionId,
      matchKind: input.matchKind,
    })
    .onConflictDoNothing()
    .run()
}
