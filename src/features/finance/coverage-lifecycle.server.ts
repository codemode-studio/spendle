import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import {
  createFilenameCoverageTemplate,
  resolveCompletedBatchStatus,
  summarizeCoveragePeriods,
} from '#/domain/import-coverage'
import { identifyDuplicateReasons } from '#/domain/import-audit'

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export function setCoverageInterval(
  transaction: DatabaseTransaction,
  input: {
    importId: string
    accountId: string | null
    creditCardId: string | null
    start: string
    end: string
    source: 'metadata' | 'filename' | 'user'
    confidence: 'high' | 'medium' | 'low'
  },
) {
  transaction
    .insert(schema.coverageIntervals)
    .values({ id: randomUUID(), ...input })
    .onConflictDoUpdate({
      target: schema.coverageIntervals.importId,
      set: {
        start: input.start,
        end: input.end,
        source: input.source,
        confidence: input.confidence,
      },
    })
    .run()
}

export async function getLearnedCoverageTemplates() {
  await ensureDatabase()
  return (await db.select().from(schema.filenameCoverageRules)).map(
    (rule) => rule.template,
  )
}

export async function refreshImportBatchCoverage(input: {
  batchId: string
  importIds?: string[]
  mode: 'staged' | 'completed'
}) {
  await ensureDatabase()
  const imports = await db
    .select({
      status: schema.imports.status,
      periodStart: schema.imports.periodStart,
      periodEnd: schema.imports.periodEnd,
      periodSource: schema.imports.periodSource,
    })
    .from(schema.imports)
    .where(
      input.importIds
        ? inArray(schema.imports.id, input.importIds)
        : eq(schema.imports.batchId, input.batchId),
    )

  if (
    input.mode === 'completed' &&
    !imports.every(
      (item) =>
        item.status === 'committed' ||
        item.status === 'evidence' ||
        item.status === 'rejected',
    )
  ) {
    return null
  }

  const summary = summarizeCoveragePeriods(
    imports,
    input.mode === 'completed'
      ? (item) => item.status === 'committed' || item.status === 'evidence'
      : undefined,
  )
  const status =
    input.mode === 'completed'
      ? resolveCompletedBatchStatus(imports.map((item) => item.status))
      : imports.some((item) => item.status === 'review')
        ? ('review' as const)
        : ('committed' as const)

  await db
    .update(schema.importBatches)
    .set({
      status,
      coverageStart: summary.coverageStart,
      coverageEnd: summary.coverageEnd,
      gapSummaryJson: JSON.stringify(summary.gaps),
    })
    .where(eq(schema.importBatches.id, input.batchId))

  return { ...summary, status, imports }
}

export async function confirmCoveragePeriod(input: {
  importId: string
  periodStart: string
  periodEnd: string
}) {
  await ensureDatabase()
  if (input.periodStart > input.periodEnd) {
    throw new Error('A data inicial precisa ser anterior à data final.')
  }
  const importRow = (
    await db
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, input.importId))
      .limit(1)
  ).at(0)
  if (!importRow || importRow.status !== 'review') {
    throw new Error(
      'Somente uma importação em revisão pode ter o período corrigido.',
    )
  }
  if (
    (importRow.activityStart && input.periodStart > importRow.activityStart) ||
    (importRow.activityEnd && input.periodEnd < importRow.activityEnd)
  ) {
    throw new Error(
      'O período confirmado precisa incluir todas as transações encontradas no arquivo.',
    )
  }

  const source = (
    await db
      .select({ originalName: schema.sourceFiles.originalName })
      .from(schema.sourceFiles)
      .where(eq(schema.sourceFiles.id, importRow.sourceFileId))
      .limit(1)
  ).at(0)
  const learnedTemplate = source
    ? createFilenameCoverageTemplate(
        source.originalName,
        input.periodStart,
        input.periodEnd,
      )
    : null
  const stagedRows = await db
    .select()
    .from(schema.stagedTransactions)
    .where(eq(schema.stagedTransactions.importId, input.importId))
  const targetFilter = importRow.accountId
    ? eq(schema.transactions.accountId, importRow.accountId)
    : eq(schema.transactions.creditCardId, importRow.creditCardId!)
  const existingTransactions = await db
    .select({
      externalId: schema.transactions.externalId,
      fingerprint: schema.transactions.fingerprint,
      postedAt: schema.transactions.postedAt,
    })
    .from(schema.transactions)
    .where(targetFilter)
  const duplicateReasons = identifyDuplicateReasons(
    stagedRows,
    existingTransactions.filter(
      (transaction) =>
        Boolean(transaction.externalId) ||
        (transaction.postedAt >= input.periodStart &&
          transaction.postedAt <= input.periodEnd),
    ),
  )

  db.transaction((transaction) => {
    transaction
      .update(schema.imports)
      .set({
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        periodSource: 'user',
        coverageConfidence: 'high',
      })
      .where(eq(schema.imports.id, input.importId))
      .run()
    for (const [index, row] of stagedRows.entries()) {
      transaction
        .update(schema.stagedTransactions)
        .set({
          duplicate: duplicateReasons[index] !== null,
          duplicateReason: duplicateReasons[index],
        })
        .where(eq(schema.stagedTransactions.id, row.id))
        .run()
    }
    setCoverageInterval(transaction, {
      importId: input.importId,
      accountId: importRow.accountId,
      creditCardId: importRow.creditCardId,
      start: input.periodStart,
      end: input.periodEnd,
      source: 'user',
      confidence: 'high',
    })
    if (learnedTemplate) {
      transaction
        .insert(schema.filenameCoverageRules)
        .values({ id: randomUUID(), template: learnedTemplate })
        .onConflictDoNothing()
        .run()
    }
  })

  const relatedImportIds = importRow.batchId
    ? (
        await db
          .select({ id: schema.imports.id })
          .from(schema.imports)
          .where(eq(schema.imports.batchId, importRow.batchId))
      ).map((item) => item.id)
    : [input.importId]

  return {
    relatedImportIds,
    batchId: importRow.batchId,
    targetType: importRow.accountId ? ('account' as const) : ('card' as const),
    targetId: importRow.accountId ?? importRow.creditCardId!,
  }
}
