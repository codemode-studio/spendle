import { randomUUID } from 'node:crypto'
import { and, eq, inArray, or } from 'drizzle-orm'

import { db } from '#/db/index.server'
import * as schema from '#/db/schema'
import {
  duplicateReasonForOutcome,
  resolveImportObservationOutcomes,
} from '#/domain/canonicalization'
import {
  canCommitImportAudit,
  evaluateImportAudit,
  nextValidationState,
} from '#/domain/import-audit'
import { matchStructuredImportToTrustedControls } from './canonical-outcome.server'
import { hasReliableCoverage } from './coverage-lifecycle.server'

export async function buildCanonicalCommitPlan(
  importRow: typeof schema.imports.$inferSelect,
  staged: Array<typeof schema.stagedTransactions.$inferSelect>,
  manualReviewConfirmed: boolean,
  importPatch: Partial<typeof schema.imports.$inferInsert> | null = null,
) {
  const importId = importRow.id
  const targetFilter = importRow.accountId
    ? eq(schema.transactions.accountId, importRow.accountId)
    : eq(schema.transactions.creditCardId, importRow.creditCardId!)
  const existingTransactions = await db
    .select({
      id: schema.transactions.id,
      importId: schema.transactions.importId,
      fingerprint: schema.transactions.fingerprint,
      externalId: schema.transactions.externalId,
      postedAt: schema.transactions.postedAt,
      amountCents: schema.transactions.amountCents,
      description: schema.transactions.description,
      normalizedDescription: schema.transactions.normalizedDescription,
      currency: schema.transactions.currency,
      status: schema.transactions.status,
    })
    .from(schema.transactions)
    .where(targetFilter)
  const closedCycleAssignments = await matchStructuredImportToTrustedControls(
    importRow,
    staged,
    existingTransactions,
  )
  const knownEvidenceVersions = existingTransactions.length
    ? await db
        .select({
          transactionId: schema.transactionEvidence.transactionId,
          fingerprint: schema.stagedTransactions.fingerprint,
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
          schema.imports,
          eq(schema.imports.id, schema.stagedTransactions.importId),
        )
        .leftJoin(
          schema.transactionCorrections,
          eq(
            schema.transactionCorrections.stagedTransactionId,
            schema.stagedTransactions.id,
          ),
        )
        .where(
          and(
            inArray(
              schema.transactionEvidence.transactionId,
              existingTransactions.map((transaction) => transaction.id),
            ),
            or(
              inArray(schema.imports.status, ['committed', 'evidence']),
              and(
                eq(schema.imports.status, 'review'),
                inArray(schema.transactionCorrections.status, [
                  'accepted',
                  'rejected',
                ]),
              ),
            ),
          ),
        )
    : []
  const externalById = new Map(
    existingTransactions
      .filter(
        (
          transaction,
        ): transaction is typeof transaction & { externalId: string } =>
          Boolean(transaction.externalId),
      )
      .map((transaction) => [transaction.externalId, transaction]),
  )
  for (const item of staged) {
    const existing = item.externalId
      ? externalById.get(item.externalId)
      : undefined
    const knownHistoricalVersion = existing
      ? knownEvidenceVersions.some(
          (version) =>
            version.transactionId === existing.id &&
            version.fingerprint === item.fingerprint,
        )
      : false
    if (
      existing &&
      existing.fingerprint !== item.fingerprint &&
      !knownHistoricalVersion &&
      !closedCycleAssignments.has(item.id)
    ) {
      db.transaction((transaction) => {
        transaction
          .insert(schema.transactionCorrections)
          .values({
            id: randomUUID(),
            stagedTransactionId: item.id,
            transactionId: existing.id,
            previousJson: JSON.stringify({
              postedAt: existing.postedAt,
              description: existing.description,
              amountCents: existing.amountCents,
              currency: existing.currency,
              fingerprint: existing.fingerprint,
            }),
            proposedJson: JSON.stringify({
              postedAt: item.postedAt,
              description: item.description,
              amountCents: item.amountCents,
              currency: item.currency,
              fingerprint: item.fingerprint,
            }),
          })
          .onConflictDoNothing()
          .run()
        transaction
          .update(schema.imports)
          .set({
            ...(importPatch ?? {}),
            ...nextValidationState({
              current: importRow,
              evaluated: {
                validationStatus: 'divergent',
                validationReason: 'pending_correction',
                validationMessage:
                  'O banco reenviou uma transação identificada com dados diferentes. A correção ficou pendente de revisão; o lançamento atual não foi alterado.',
              },
            }),
          })
          .where(eq(schema.imports.id, importId))
          .run()
      })
      throw new Error(
        'O banco reenviou uma transação com dados diferentes. Revise a correção pendente; nada foi alterado no histórico.',
      )
    }
  }
  const reliableCoverage = hasReliableCoverage({
    periodStart: importRow.periodStart,
    periodEnd: importRow.periodEnd,
    periodSource: importRow.periodSource,
  })
  const promotedExternalIds = new Map(
    [...closedCycleAssignments.values()].flatMap((assignment) =>
      assignment.externalId
        ? [[assignment.transactionId, assignment.externalId] as const]
        : [],
    ),
  )
  const effectiveExistingTransactions = existingTransactions.map(
    (transaction) => ({
      ...transaction,
      externalId:
        promotedExternalIds.get(transaction.id) ?? transaction.externalId,
    }),
  )
  const canonicalDecisions = resolveImportObservationOutcomes({
    observations: staged,
    transactions: effectiveExistingTransactions.filter(
      (transaction) =>
        Boolean(transaction.externalId) ||
        (reliableCoverage &&
          transaction.postedAt >= importRow.periodStart! &&
          transaction.postedAt <= importRow.periodEnd!),
    ),
    assignments: [...closedCycleAssignments.entries()].map(
      ([observationId, assignment]) => ({
        observationId,
        transactionId: assignment.transactionId,
        reason: 'trusted_statement_control' as const,
      }),
    ),
    knownEvidenceVersions,
  })
  const duplicateReasons = canonicalDecisions.map(duplicateReasonForOutcome)
  for (const [index, item] of staged.entries()) {
    if (!closedCycleAssignments.has(item.id)) continue
    duplicateReasons[index] = item.externalId
      ? 'external_id'
      : 'fingerprint_overlap'
  }
  const accountAnchor = importRow.accountId
    ? await db
        .select({
          balanceCents: schema.accounts.statementBalanceCents,
          balanceAt: schema.accounts.statementBalanceAt,
        })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, importRow.accountId))
        .limit(1)
    : []
  const anchor = accountAnchor.at(0)
  const existingMovementCents = anchor?.balanceAt
    ? existingTransactions
        .filter(
          (transaction) =>
            transaction.status === 'confirmed' &&
            transaction.postedAt > anchor.balanceAt! &&
            (!importRow.balanceAsOf ||
              transaction.postedAt <= importRow.balanceAsOf),
        )
        .reduce((sum, transaction) => sum + transaction.amountCents, 0)
    : 0
  const newMovementCents = importRow.creditCardId
    ? staged.reduce((sum, item) => sum + item.amountCents, 0)
    : staged
        .filter(
          (item, index) =>
            !duplicateReasons[index] &&
            (!anchor?.balanceAt || item.postedAt > anchor.balanceAt) &&
            (!importRow.balanceAsOf || item.postedAt <= importRow.balanceAsOf),
        )
        .reduce((sum, item) => sum + item.amountCents, 0)
  const audit = evaluateImportAudit({
    targetType: importRow.accountId ? 'account' : 'card',
    sourceTransactionCount: importRow.sourceTransactionCount,
    parsedTransactionCount: importRow.parsedTransactionCount,
    invalidTransactionCount: importRow.invalidTransactionCount,
    openingBalanceCents: importRow.openingBalanceCents,
    openingBalanceAt: importRow.openingBalanceAt,
    closingBalanceCents:
      importRow.closingBalanceType === 'available'
        ? null
        : importRow.closingBalanceCents,
    balanceAsOf: importRow.balanceAsOf,
    statementPeriodStart: importRow.periodStart,
    anchorBalanceCents: anchor?.balanceCents ?? null,
    anchorBalanceAt: anchor?.balanceAt ?? null,
    existingMovementCents,
    newMovementCents,
    documentMovementCents: staged.reduce(
      (sum, item) => sum + item.amountCents,
      0,
    ),
  })
  if (!canCommitImportAudit(audit.status, manualReviewConfirmed)) {
    db.transaction((transaction) => {
      transaction
        .update(schema.imports)
        .set({
          ...(importPatch ?? {}),
          ...nextValidationState({
            current: importRow,
            evaluated: {
              validationStatus: audit.status,
              validationReason: audit.reasonCode,
              validationMessage: audit.message,
            },
          }),
          expectedBalanceCents: audit.expectedBalanceCents,
          balanceDifferenceCents: audit.balanceDifferenceCents,
        })
        .where(eq(schema.imports.id, importId))
        .run()
    })
    throw new Error(
      audit.status === 'warning'
        ? `Confirme a revisão manual antes de consolidar. ${audit.message}`
        : audit.message,
    )
  }
  return { closedCycleAssignments, duplicateReasons, audit }
}
