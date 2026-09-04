import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'

import { db } from '#/db/index.server'
import * as schema from '#/db/schema'
import { nextValidationState } from '#/domain/import-audit'

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export function reopenRestoredExclusionOwners(
  transaction: DatabaseTransaction,
  input: {
    transactionIds: string[]
    exclusionReasonSuffix: string
    validationMessage: string
  },
) {
  if (!input.transactionIds.length) return []
  const activeExclusions = transaction
    .select()
    .from(schema.statementExclusions)
    .where(
      and(
        inArray(schema.statementExclusions.transactionId, input.transactionIds),
        isNull(schema.statementExclusions.reversedAt),
      ),
    )
    .all()
  if (!activeExclusions.length) return []

  const affectedImportIds = [
    ...new Set(activeExclusions.map((item) => item.importId)),
  ]
  const affectedImports = transaction
    .select()
    .from(schema.imports)
    .where(inArray(schema.imports.id, affectedImportIds))
    .all()
  transaction
    .update(schema.statementExclusions)
    .set({
      reversedAt: new Date(),
      reason: sql`${schema.statementExclusions.reason} || ${` ${input.exclusionReasonSuffix}`}`,
    })
    .where(
      inArray(
        schema.statementExclusions.id,
        activeExclusions.map((exclusion) => exclusion.id),
      ),
    )
    .run()
  for (const affectedImport of affectedImports) {
    transaction
      .update(schema.imports)
      .set({
        ...nextValidationState({
          current: affectedImport,
          evaluated: {
            validationStatus: 'divergent',
            validationReason: 'pending_correction',
            validationMessage: input.validationMessage,
          },
        }),
      })
      .where(inArray(schema.imports.id, [affectedImport.id]))
      .run()
  }
  return affectedImportIds
}

export async function findRestoredExclusionOwnerImportIds(
  restoringImportIds: string[],
) {
  if (!restoringImportIds.length) return []
  const rows = await db
    .select({
      restoringImportId: schema.stagedTransactions.importId,
      ownerImportId: schema.statementExclusions.importId,
    })
    .from(schema.transactionEvidence)
    .innerJoin(
      schema.stagedTransactions,
      eq(
        schema.stagedTransactions.id,
        schema.transactionEvidence.stagedTransactionId,
      ),
    )
    .innerJoin(
      schema.statementExclusions,
      eq(
        schema.statementExclusions.transactionId,
        schema.transactionEvidence.transactionId,
      ),
    )
    .where(
      and(
        inArray(schema.stagedTransactions.importId, restoringImportIds),
        isNotNull(schema.statementExclusions.reversedAt),
      ),
    )
  return [
    ...new Set(
      rows.flatMap((row) =>
        row.ownerImportId === row.restoringImportId
          ? []
          : [row.ownerImportId],
      ),
    ),
  ]
}
