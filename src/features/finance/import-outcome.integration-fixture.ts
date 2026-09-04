import { eq } from 'drizzle-orm'

import { db } from '#/db/index.server'
import * as schema from '#/db/schema'
import { resolveImportOutcome } from './canonical-outcome.server'
import { stageImport } from './import-stage.server'

export async function stageCardObservationAndResolveOutcome(input: {
  file: File
  creditCardId: string
}) {
  const stagedResult = await stageImport({
    file: input.file,
    targetType: 'card',
    targetId: input.creditCardId,
    aiConsent: false,
  })
  const [[observation], [transactionRow]] = await Promise.all([
    db
      .select()
      .from(schema.stagedTransactions)
      .where(eq(schema.stagedTransactions.importId, stagedResult.importId)),
    db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.creditCardId, input.creditCardId)),
  ])
  const outcome = db.transaction((transaction) =>
    resolveImportOutcome(transaction, stagedResult.importId, {
      assignments: [
        {
          observationId: observation.id,
          transactionId: transactionRow.id,
          externalId: observation.externalId,
        },
      ],
    }),
  )
  return { importId: stagedResult.importId, outcome }
}
