import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { inferCoverageFromFilename } from '#/domain/import-coverage'
import * as schema from './schema'

function isValidCompactDate(value?: string) {
  if (!value || !/^\d{8}$/.test(value)) return false
  const candidate = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
  const parsed = new Date(`${candidate}T12:00:00Z`)
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === candidate
  )
}

export async function repairImportProvenance(
  db: BetterSQLite3Database<typeof schema>,
) {
  const stagedActivityRows = await db
    .select({
      importId: schema.stagedTransactions.importId,
      postedAt: schema.stagedTransactions.postedAt,
    })
    .from(schema.stagedTransactions)
  const stagedActivity = new Map<string, { start: string; end: string }>()
  for (const item of stagedActivityRows) {
    const current = stagedActivity.get(item.importId)
    stagedActivity.set(item.importId, {
      start:
        !current || item.postedAt < current.start
          ? item.postedAt
          : current.start,
      end:
        !current || item.postedAt > current.end ? item.postedAt : current.end,
    })
  }
  const rows = await db
    .select({ import: schema.imports, sourceFile: schema.sourceFiles })
    .from(schema.imports)
    .innerJoin(
      schema.sourceFiles,
      eq(schema.sourceFiles.id, schema.imports.sourceFileId),
    )
  for (const row of rows) {
    const filenamePeriod = inferCoverageFromFilename(
      row.sourceFile.originalName,
    )
    const activity = stagedActivity.get(row.import.id) ?? null
    const activityStart = activity?.start ?? row.import.activityStart ?? null
    const activityEnd = activity?.end ?? row.import.activityEnd ?? null
    const containsActivity = (period: { start: string; end: string }) =>
      (!activityStart || period.start <= activityStart) &&
      (!activityEnd || period.end >= activityEnd)
    const ofxMetadataState =
      row.import.parser === 'ofx' &&
      (() => {
        try {
          const source = readFileSync(row.sourceFile.storagePath, 'utf8')
          const start = source.match(/<DTSTART>\s*(\d{8})/i)?.[1]
          const end = source.match(/<DTEND>\s*(\d{8})/i)?.[1]
          return isValidCompactDate(start) && isValidCompactDate(end)
            ? ('valid' as const)
            : ('invalid' as const)
        } catch {
          return 'unavailable' as const
        }
      })()
    const existingReliablePeriod =
      row.import.periodStart &&
      row.import.periodEnd &&
      (row.import.periodSource === 'user' ||
        (row.import.periodSource === 'metadata' &&
          ofxMetadataState !== 'invalid') ||
        (row.import.periodSource === 'metadata' &&
          row.import.parser !== 'ofx') ||
        row.import.periodSource === 'filename')
        ? { start: row.import.periodStart, end: row.import.periodEnd }
        : null
    const inferredFilenamePeriod =
      row.import.periodSource !== 'user' &&
      filenamePeriod &&
      containsActivity(filenamePeriod)
        ? filenamePeriod
        : null
    const reliablePeriod = existingReliablePeriod
      ? containsActivity(existingReliablePeriod) ||
        row.import.periodSource === 'user'
        ? existingReliablePeriod
        : null
      : inferredFilenamePeriod
    const reliableSource = reliablePeriod
      ? row.import.periodSource === 'user'
        ? ('user' as const)
        : existingReliablePeriod && row.import.periodSource === 'metadata'
          ? ('metadata' as const)
          : ('filename' as const)
      : null
    await db
      .update(schema.imports)
      .set({
        activityStart,
        activityEnd,
        ...(reliablePeriod && reliableSource
          ? {
              periodStart: reliablePeriod.start,
              periodEnd: reliablePeriod.end,
              periodSource: reliableSource,
              coverageConfidence: 'high' as const,
            }
          : row.import.periodSource === 'user'
            ? {}
            : {
                periodSource: activity
                  ? ('activity' as const)
                  : ('unknown' as const),
                coverageConfidence: activity
                  ? ('low' as const)
                  : ('unknown' as const),
              }),
      })
      .where(eq(schema.imports.id, row.import.id))
    if (reliablePeriod && reliableSource) {
      await db
        .insert(schema.coverageIntervals)
        .values({
          id: randomUUID(),
          importId: row.import.id,
          accountId: row.import.accountId,
          creditCardId: row.import.creditCardId,
          start: reliablePeriod.start,
          end: reliablePeriod.end,
          source: reliableSource,
          confidence: 'high',
        })
        .onConflictDoUpdate({
          target: schema.coverageIntervals.importId,
          set: {
            start: reliablePeriod.start,
            end: reliablePeriod.end,
            source: reliableSource,
            confidence: 'high',
          },
        })
    } else if (row.import.periodSource !== 'user') {
      await db
        .delete(schema.coverageIntervals)
        .where(eq(schema.coverageIntervals.importId, row.import.id))
    }
  }

  const unlinked = await db
    .select({ staged: schema.stagedTransactions, import: schema.imports })
    .from(schema.stagedTransactions)
    .innerJoin(
      schema.imports,
      eq(schema.imports.id, schema.stagedTransactions.importId),
    )
    .leftJoin(
      schema.transactionEvidence,
      eq(
        schema.transactionEvidence.stagedTransactionId,
        schema.stagedTransactions.id,
      ),
    )
    .where(isNull(schema.transactionEvidence.id))
  const existingEvidence = await db
    .select({
      importId: schema.stagedTransactions.importId,
      transactionId: schema.transactionEvidence.transactionId,
    })
    .from(schema.transactionEvidence)
    .innerJoin(
      schema.stagedTransactions,
      eq(
        schema.stagedTransactions.id,
        schema.transactionEvidence.stagedTransactionId,
      ),
    )
  const assignedTransactionIds = new Set(
    existingEvidence.map((item) => `${item.importId}:${item.transactionId}`),
  )
  const externalTransactions = await db
    .select({
      id: schema.transactions.id,
      accountId: schema.transactions.accountId,
      creditCardId: schema.transactions.creditCardId,
      externalId: schema.transactions.externalId,
    })
    .from(schema.transactions)
  const reservedExternalTransactions = new Set(
    unlinked.flatMap((row) => {
      if (!row.staged.externalId) return []
      const match = externalTransactions.find(
        (candidate) =>
          candidate.externalId === row.staged.externalId &&
          candidate.accountId === row.import.accountId &&
          candidate.creditCardId === row.import.creditCardId,
      )
      return match ? [`${row.import.id}:${match.id}`] : []
    }),
  )
  for (const row of unlinked) {
    const target = row.import.accountId
      ? eq(schema.transactions.accountId, row.import.accountId)
      : eq(schema.transactions.creditCardId, row.import.creditCardId!)
    let candidates = await db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(
        row.staged.externalId
          ? and(
              target,
              eq(schema.transactions.externalId, row.staged.externalId),
            )
          : and(
              target,
              eq(schema.transactions.fingerprint, row.staged.fingerprint),
            ),
      )
      .orderBy(asc(schema.transactions.id))
    let matchKind: 'external_id' | 'exact_overlap' | 'statement_control' = row
      .staged.externalId
      ? 'external_id'
      : 'exact_overlap'
    if (row.staged.externalId && !candidates.length) {
      candidates = await db
        .select({ id: schema.transactions.id })
        .from(schema.transactions)
        .where(
          and(
            target,
            isNull(schema.transactions.externalId),
            eq(schema.transactions.fingerprint, row.staged.fingerprint),
          ),
        )
        .orderBy(asc(schema.transactions.id))
      matchKind = 'exact_overlap'
    }
    if (
      row.import.status === 'evidence' &&
      row.import.parser === 'pdf_inspector' &&
      row.import.closingBalanceCents !== null &&
      !row.staged.externalId &&
      !candidates.length
    ) {
      candidates = await db
        .select({ id: schema.transactions.id })
        .from(schema.transactions)
        .where(
          and(
            target,
            eq(schema.transactions.postedAt, row.staged.postedAt),
            eq(schema.transactions.amountCents, row.staged.amountCents),
            eq(schema.transactions.currency, row.staged.currency),
          ),
        )
        .orderBy(asc(schema.transactions.id))
      matchKind = 'statement_control'
    }
    const candidate = candidates.find(
      (item) =>
        !assignedTransactionIds.has(`${row.import.id}:${item.id}`) &&
        (Boolean(row.staged.externalId) ||
          !reservedExternalTransactions.has(`${row.import.id}:${item.id}`)),
    )
    if (!candidate) continue
    await db
      .insert(schema.transactionEvidence)
      .values({
        id: randomUUID(),
        stagedTransactionId: row.staged.id,
        transactionId: candidate.id,
        matchKind,
      })
      .onConflictDoNothing()
    assignedTransactionIds.add(`${row.import.id}:${candidate.id}`)
  }
}
