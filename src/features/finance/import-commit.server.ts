import { randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { and, eq, sql } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import { parseInstallmentDescription } from '#/domain/credit-card'
import { classifyCheckpointAtDate } from '#/domain/balance-checkpoint'
import { convertMinorUnitsAtRate } from '#/domain/currency'
import {
  effectiveValidationReason,
  isHardImportReviewReason,
  nextValidationState,
} from '#/domain/import-audit'
import { runPostCommitStep } from '#/domain/post-commit'
import { assertIsoDate } from '#/domain/period'
import { parseCsvStatement } from './csv-statement.server'
import {
  applyImportOutcome,
  recoverBatchEvidence,
  resolveImportOutcome,
} from './canonical-outcome.server'
import { buildCanonicalCommitPlan } from './import-commit-plan.server'
import { reconcileCsvWithPdfControl } from './import-control-reconciliation.server'
import { replaceCheckpointChainForImport } from './checkpoint-chain.server'
import {
  confirmCoveragePeriod,
  refreshImportBatchCoverage,
} from './coverage-lifecycle.server'
import { fetchPtax } from './currency.server'
import {
  assertImportBatchActionable,
  assertImportActionable,
} from './import-guards.server'
import {
  matchesDocumentLastFour,
  normalizeLastFour,
} from './statement-reader.server'
import { refreshReconciliationAfterCommit } from './reconciliation-refresh.server'
import { refreshStatementResolutionState } from './finance.server'
import { findRestoredExclusionOwnerImportIds } from './statement-exclusions.server'

export { reconcileCsvWithPdfControl } from './import-control-reconciliation.server'

function isDependentBatchEvidence(importRow: {
  dependsOnImportId: string | null
}) {
  return Boolean(importRow.dependsOnImportId)
}

async function finishImportBatchIfComplete(batchId: string) {
  await refreshImportBatchCoverage({ batchId, mode: 'completed' })
}

async function finalizeImportAfterCommit(
  batchId: string | null,
  importId: string,
) {
  const batchEvidence = await runPostCommitStep(
    batchId ? () => recoverBatchEvidence(batchId) : null,
  )
  const batchCoverage = await runPostCommitStep(
    batchId ? () => finishImportBatchIfComplete(batchId) : null,
  )
  const reconciliation = await refreshReconciliationAfterCommit()
  const statementOwners = await runPostCommitStep(async () => {
    const finalizedImportIds = batchId
      ? (
          await db
            .select({ id: schema.imports.id })
            .from(schema.imports)
            .where(eq(schema.imports.batchId, batchId))
        ).map((item) => item.id)
      : [importId]
    const restoredOwnerIds =
      await findRestoredExclusionOwnerImportIds(finalizedImportIds)
    if (restoredOwnerIds.length) {
      await Promise.all(
        restoredOwnerIds.map((ownerImportId) =>
          refreshStatementResolutionState(ownerImportId),
        ),
      )
    }
  })
  const status =
    batchEvidence.status === 'deferred' ||
    batchCoverage.status === 'deferred' ||
    reconciliation.status === 'deferred' ||
    statementOwners.status === 'deferred'
      ? ('deferred' as const)
      : ('completed' as const)
  return {
    status,
    batchEvidence,
    batchCoverage,
    reconciliation,
    statementOwners,
  }
}

async function refreshCsvImportControls(
  importRow: typeof schema.imports.$inferSelect,
  source: { storagePath: string; originalName: string },
) {
  if (importRow.parser !== 'csv') {
    return { importRow, patch: null }
  }
  const targetType = importRow.accountId ? 'account' : 'card'
  const statement = parseCsvStatement(
    await readFile(source.storagePath),
    targetType,
    source.originalName,
  )
  const accountIdentifiers = importRow.accountId
    ? await db
        .select({ externalId: schema.accounts.externalId })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, importRow.accountId))
        .limit(1)
    : []
  const cardIdentifiers = importRow.creditCardId
    ? [
        ...(await db
          .select({ lastFour: schema.creditCards.lastFour })
          .from(schema.creditCards)
          .where(eq(schema.creditCards.id, importRow.creditCardId))
          .limit(1)),
        ...(await db
          .select({ lastFour: schema.creditCardInstruments.lastFour })
          .from(schema.creditCardInstruments)
          .where(
            eq(
              schema.creditCardInstruments.creditCardId,
              importRow.creditCardId,
            ),
          )),
      ]
    : []
  const targetIdentifiers = [
    ...accountIdentifiers.map((item) => item.externalId),
    ...cardIdentifiers.map((item) => item.lastFour),
  ]
  if (
    statement.detectedLastFour &&
    targetIdentifiers.some(Boolean) &&
    !matchesDocumentLastFour(statement.detectedLastFour, targetIdentifiers)
  ) {
    const targetLastFour = targetIdentifiers
      .map(normalizeLastFour)
      .find(Boolean)
    throw new Error(
      `O CSV termina em •${statement.detectedLastFour}, mas o destino selecionado termina em •${targetLastFour}.`,
    )
  }
  const preserveConfirmedPeriod = Boolean(
    importRow.periodStart &&
    importRow.periodEnd &&
    (importRow.periodSource === 'user' ||
      (importRow.periodSource === 'filename' &&
        statement.periodSource === 'activity' &&
        (!statement.activityStart ||
          importRow.periodStart <= statement.activityStart) &&
        (!statement.activityEnd ||
          importRow.periodEnd >= statement.activityEnd))),
  )
  const preserveReconciledPdfControl = Boolean(
    importRow.batchId &&
    importRow.validationStatus === 'reconciled' &&
    importRow.closingBalanceCents !== null &&
    importRow.balanceAsOf,
  )
  const refreshedControls = {
    closingBalanceCents: preserveReconciledPdfControl
      ? importRow.closingBalanceCents
      : statement.closingBalanceCents,
    closingBalanceType: preserveReconciledPdfControl
      ? importRow.closingBalanceType
      : statement.closingBalanceCents === null
        ? null
        : importRow.creditCardId
          ? ('card_statement' as const)
          : ('posted' as const),
    balanceAsOf: preserveReconciledPdfControl
      ? importRow.balanceAsOf
      : statement.balanceAsOf,
    periodStart: preserveConfirmedPeriod
      ? importRow.periodStart
      : statement.periodStart,
    periodEnd: preserveConfirmedPeriod
      ? importRow.periodEnd
      : statement.periodEnd,
    activityStart: statement.activityStart,
    activityEnd: statement.activityEnd,
    periodSource: preserveConfirmedPeriod
      ? importRow.periodSource
      : statement.periodSource,
    coverageConfidence: preserveConfirmedPeriod
      ? ('high' as const)
      : statement.coverageConfidence,
    detectedLastFour: statement.detectedLastFour,
  }
  return {
    importRow: { ...importRow, ...refreshedControls },
    patch: refreshedControls,
  }
}

async function prepareCanonicalTransactions(input: {
  importRow: typeof schema.imports.$inferSelect
  staged: Array<typeof schema.stagedTransactions.$inferSelect>
  duplicateReasons: Array<'external_id' | 'fingerprint_overlap' | null>
  sourceSha256: string
}) {
  const transactions: Array<typeof schema.transactions.$inferInsert> = []
  const transactionByObservation = new Map<string, string>()
  const installments: Array<typeof schema.installmentPlans.$inferInsert> = []
  const sourceOccurrences = new Map<string, number>()
  for (const [index, item] of input.staged.entries()) {
    if (input.duplicateReasons[index]) continue
    let baseAmountCents: number | null = item.amountCents
    let exchangeRateMicros: number | null = 1_000_000
    if (item.currency === 'USD') {
      exchangeRateMicros = await fetchPtax(item.postedAt.slice(0, 10))
      baseAmountCents = exchangeRateMicros
        ? convertMinorUnitsAtRate(
            item.amountCents,
            item.currency,
            'BRL',
            exchangeRateMicros,
          )
        : null
    } else if (item.currency !== 'BRL') {
      baseAmountCents = null
      exchangeRateMicros = null
    }
    const transactionId = randomUUID()
    const occurrence = (sourceOccurrences.get(item.fingerprint) ?? 0) + 1
    sourceOccurrences.set(item.fingerprint, occurrence)
    const targetKey = input.importRow.accountId
      ? `account:${input.importRow.accountId}`
      : `card:${input.importRow.creditCardId}`
    const sourceKey = item.externalId
      ? `${targetKey}:external:${item.externalId}`
      : `${targetKey}:file:${input.sourceSha256}:${item.fingerprint}:${occurrence}`
    transactions.push({
      id: transactionId,
      importId: input.importRow.id,
      accountId: input.importRow.accountId,
      creditCardId: input.importRow.creditCardId,
      categoryId: item.suggestedCategoryId,
      counterpartyAccountId: item.counterpartyAccountId,
      externalId: item.externalId,
      sourceKey,
      fingerprint: item.fingerprint,
      postedAt: item.postedAt,
      description: item.description,
      normalizedDescription: item.normalizedDescription,
      amountCents: item.amountCents,
      currency: item.currency,
      baseAmountCents,
      exchangeRateMicros,
      status:
        input.importRow.creditCardId &&
        input.importRow.closingBalanceCents === null
          ? 'pending'
          : 'confirmed',
    })
    transactionByObservation.set(item.id, transactionId)
    const installment =
      input.importRow.creditCardId && item.amountCents < 0
        ? parseInstallmentDescription(item.description)
        : null
    if (input.importRow.creditCardId && installment) {
      installments.push({
        id: randomUUID(),
        creditCardId: input.importRow.creditCardId,
        sourceTransactionId: transactionId,
        description: installment.cleanDescription,
        categoryId: item.suggestedCategoryId,
        installmentAmountCents: Math.abs(item.amountCents),
        totalInstallments: installment.totalInstallments,
        currentInstallment: installment.currentInstallment,
        firstChargeDate: item.postedAt,
        autoDetected: true,
      })
    }
  }
  return { transactions, transactionByObservation, installments }
}

export async function commitImport(
  importId: string,
  manualReviewConfirmed = false,
) {
  await ensureDatabase()
  const importRows = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, importId))
    .limit(1)
  if (!importRows[0]) throw new Error('Importação não encontrada.')
  let importRow: typeof schema.imports.$inferSelect = importRows[0]
  if (importRow.status === 'committed' || importRow.status === 'evidence') {
    return { committed: 0, reused: true }
  }
  await assertImportActionable(importRow, 'commit')
  if (importRow.status !== 'review') {
    throw new Error('Somente lotes em revisão podem ser consolidados.')
  }
  if (isDependentBatchEvidence(importRow)) {
    throw new Error(
      'Este arquivo está aguardando o documento principal do mesmo lote. Consolide ou rejeite o documento principal primeiro.',
    )
  }
  const source = await db
    .select({
      sha256: schema.sourceFiles.sha256,
      storagePath: schema.sourceFiles.storagePath,
      originalName: schema.sourceFiles.originalName,
    })
    .from(schema.sourceFiles)
    .where(eq(schema.sourceFiles.id, importRow.sourceFileId))
    .limit(1)
  if (!source[0]) throw new Error('Arquivo original não encontrado.')

  const refreshedControls = await refreshCsvImportControls(importRow, source[0])
  importRow = refreshedControls.importRow

  if (importRow.batchId) {
    const batchMembers = (
      await db
        .select()
        .from(schema.imports)
        .where(eq(schema.imports.batchId, importRow.batchId))
    ).map((member) => (member.id === importId ? importRow : member))
    await assertImportBatchActionable(
      batchMembers,
      {
        targetType: importRow.accountId ? 'account' : 'card',
        targetId: importRow.accountId ?? importRow.creditCardId!,
      },
      'commit',
    )
  }

  if (importRow.validationStatus === 'divergent') {
    throw new Error(
      importRow.validationMessage ||
        'A auditoria encontrou uma divergência. Revise ou rejeite este lote antes de continuar.',
    )
  }
  if (
    importRow.periodSource === 'activity' ||
    importRow.periodSource === 'unknown'
  ) {
    // Persist the reparsed controls before rejecting, otherwise the review
    // keeps reading the stale (reliable) period, hides the coverage
    // confirmation form and every retry repeats this error.
    if (refreshedControls.patch) {
      await db
        .update(schema.imports)
        .set(refreshedControls.patch)
        .where(eq(schema.imports.id, importId))
    }
    throw new Error(
      'Confirme o período exportado antes de consolidar. Os dias com movimentação não provam, sozinhos, a cobertura do arquivo.',
    )
  }
  const staged = await db
    .select()
    .from(schema.stagedTransactions)
    .where(eq(schema.stagedTransactions.importId, importId))
  const incompleteTransfer = staged.find(
    (item) =>
      !item.duplicate &&
      item.suggestedCategoryId === 'transfer' &&
      !item.counterpartyAccountId,
  )
  if (incompleteTransfer) {
    throw new Error(
      `Selecione a conta relacionada à transferência "${incompleteTransfer.description}" antes de consolidar.`,
    )
  }
  if (
    importRow.parser === 'pdf_inspector' &&
    (importRow.creditCardId || importRow.accountId) &&
    importRow.closingBalanceCents !== null &&
    importRow.closingBalanceType !== 'available' &&
    importRow.balanceAsOf
  ) {
    await reconcileCsvWithPdfControl({
      importIds: [importId],
      targetType: importRow.accountId ? 'account' : 'card',
      targetId: importRow.accountId ?? importRow.creditCardId!,
      finalize: true,
    })
    const refreshed = await db
      .select()
      .from(schema.imports)
      .where(eq(schema.imports.id, importId))
      .limit(1)
    importRow = refreshed[0]
    if (importRow.status === 'committed' || importRow.status === 'evidence') {
      const postCommit = await finalizeImportAfterCommit(
        importRow.batchId,
        importId,
      )
      const created = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.transactions)
        .where(eq(schema.transactions.importId, importId))
      return {
        committed: Number(created[0]?.count ?? 0),
        reused: false,
        postCommit,
      }
    }
    if (importRow.validationStatus === 'divergent') {
      throw new Error(
        importRow.validationMessage ||
          'O documento ainda tem observações sem vínculo. Resolva as diferenças antes de consolidar.',
      )
    }
  }
  const { closedCycleAssignments, duplicateReasons, audit } =
    await buildCanonicalCommitPlan(
      importRow,
      staged,
      manualReviewConfirmed,
      refreshedControls.patch,
    )
  const checkpointBalanceType = importRow.creditCardId
    ? ('card_statement' as const)
    : importRow.closingBalanceType === 'available'
      ? ('available' as const)
      : ('posted' as const)
  const checkpointAtDate =
    importRow.closingBalanceCents !== null && importRow.balanceAsOf
      ? classifyCheckpointAtDate(
          await db
            .select()
            .from(schema.balanceCheckpoints)
            .where(
              importRow.accountId
                ? eq(schema.balanceCheckpoints.accountId, importRow.accountId)
                : eq(
                    schema.balanceCheckpoints.creditCardId,
                    importRow.creditCardId!,
                  ),
            ),
          {
            balanceType: checkpointBalanceType,
            balanceCents: importRow.closingBalanceCents,
            asOf: importRow.balanceAsOf,
          },
        )
      : { status: 'none' as const, checkpointId: null }
  if (checkpointAtDate.status === 'conflict') {
    const message =
      'Já existe outro saldo ativo deste tipo para a mesma data. Invalide o ponto anterior antes de consolidar este arquivo.'
    db.transaction((transaction) => {
      transaction
        .update(schema.imports)
        .set({
          ...(refreshedControls.patch ?? {}),
          ...nextValidationState({
            current: importRow,
            evaluated: {
              validationStatus: 'divergent',
              validationReason: 'balance_mismatch',
              validationMessage: message,
            },
          }),
        })
        .where(eq(schema.imports.id, importId))
        .run()
    })
    throw new Error(message)
  }
  const checkpointControlImport =
    importRow.batchId &&
    (importRow.parser === 'csv' || importRow.parser === 'ofx') &&
    importRow.closingBalanceCents !== null &&
    importRow.balanceAsOf
      ? (
          await db
            .select()
            .from(schema.imports)
            .where(eq(schema.imports.batchId, importRow.batchId))
        ).find(
          (candidate) =>
            candidate.parser === 'pdf_inspector' &&
            candidate.status === 'review' &&
            !isHardImportReviewReason(effectiveValidationReason(candidate)) &&
            candidate.dependsOnImportId === importId &&
            candidate.closingBalanceCents === importRow.closingBalanceCents &&
            candidate.balanceAsOf === importRow.balanceAsOf,
        )
      : null
  const checkpointImportId = checkpointControlImport?.id ?? importId
  const checkpointSource = checkpointControlImport
    ? ('pdf' as const)
    : importRow.parser === 'ofx'
      ? ('ofx' as const)
      : importRow.parser === 'csv'
        ? ('csv' as const)
        : ('pdf' as const)
  const {
    transactions: prepared,
    transactionByObservation: createdTransactionByStagedId,
    installments: detectedInstallments,
  } = await prepareCanonicalTransactions({
    importRow,
    staged,
    duplicateReasons,
    sourceSha256: source[0].sha256,
  })
  db.transaction((transaction) => {
    const outcome = resolveImportOutcome(transaction, importId, {
      importOverrides: refreshedControls.patch ?? undefined,
      assignments: [...closedCycleAssignments.entries()].map(
        ([observationId, assignment]) => ({
          observationId,
          transactionId: assignment.transactionId,
          externalId: assignment.externalId,
        }),
      ),
      checkpointImportId,
      checkpointSource,
      checkpointMethod: checkpointControlImport
        ? 'date_amount_currency_multiset'
        : undefined,
      auditStatus: audit.status,
      balanceDifferenceCents: audit.balanceDifferenceCents,
      createdTransactions: prepared.map(({ id, externalId }) => ({
        id,
        externalId: externalId ?? null,
      })),
      createdTransactionByObservation: createdTransactionByStagedId,
    })
    outcome.commit = {
      importPatch: refreshedControls.patch,
      transactions: prepared,
      installments: detectedInstallments,
      validation: {
        status: audit.status,
        reason: audit.reasonCode,
        message: audit.message,
        expectedBalanceCents: audit.expectedBalanceCents,
        balanceDifferenceCents: audit.balanceDifferenceCents,
      },
    }
    applyImportOutcome(transaction, outcome)
  })
  const postCommit = await finalizeImportAfterCommit(
    importRow.batchId,
    importId,
  )
  return {
    committed: prepared.length,
    reused: false,
    postCommit,
  }
}

export async function retryImportFinalization(importId: string) {
  await ensureDatabase()
  const importRow = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, importId))
    .limit(1)
  const current = importRow.at(0)
  if (!current) throw new Error('Importação não encontrada.')
  await assertImportActionable(current, 'retry_finalization')
  if (current.status !== 'committed' && current.status !== 'evidence') {
    throw new Error('A importação ainda não foi consolidada.')
  }
  return finalizeImportAfterCommit(current.batchId, importId)
}

export async function rejectImport(importId: string) {
  await ensureDatabase()
  const importRow = await db
    .select({ batchId: schema.imports.batchId, status: schema.imports.status })
    .from(schema.imports)
    .where(eq(schema.imports.id, importId))
    .limit(1)
  if (!importRow[0]) throw new Error('Importação não encontrada.')
  const dependentSiblings = importRow[0].batchId
    ? (
        await db
          .select()
          .from(schema.imports)
          .where(eq(schema.imports.batchId, importRow[0].batchId))
      ).filter(
        (candidate) =>
          candidate.status === 'review' &&
          candidate.dependsOnImportId === importId,
      )
    : []
  db.transaction((transaction) => {
    const result = transaction
      .update(schema.imports)
      .set({ status: 'rejected' })
      .where(
        and(
          eq(schema.imports.id, importId),
          eq(schema.imports.status, 'review'),
        ),
      )
      .run()
    if (result.changes !== 1) {
      throw new Error(
        'Apenas uma importação ainda em revisão pode ser rejeitada. Atualize a página para ver o estado atual.',
      )
    }
    for (const sibling of dependentSiblings) {
      const released = transaction
        .update(schema.imports)
        .set({
          dependsOnImportId: null,
          warning: null,
          ...nextValidationState({
            current: sibling,
            evaluated: {
              validationStatus:
                sibling.parser === 'pdf_inspector'
                  ? sibling.validationStatus
                  : 'imported',
              validationReason:
                sibling.parser === 'pdf_inspector'
                  ? sibling.validationReason
                  : sibling.closingBalanceCents === null
                    ? 'needs_balance'
                    : 'ready',
              validationMessage:
                sibling.parser === 'pdf_inspector'
                  ? 'O arquivo principal foi rejeitado. Este PDF agora pode ser revisado e consolidado sozinho.'
                  : 'O arquivo principal foi rejeitado. Este arquivo estruturado agora pode ser revisado e consolidado sozinho.',
            },
          }),
        })
        .where(
          and(
            eq(schema.imports.id, sibling.id),
            eq(schema.imports.status, 'review'),
          ),
        )
        .run()
      if (released.changes !== 1) {
        throw new Error(
          'Um arquivo relacionado saiu da revisão durante a rejeição. Nenhuma alteração foi aplicada; atualize a página.',
        )
      }
    }
  })
  if (importRow[0].batchId) {
    await finishImportBatchIfComplete(importRow[0].batchId)
  }
  return { success: true }
}

export async function replaceConflictingCheckpoint(importId: string) {
  await ensureDatabase()
  const importRows = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, importId))
    .limit(1)
  const importRow = importRows.at(0)
  if (!importRow) throw new Error('Importação não encontrada.')
  await assertImportActionable(importRow, 'replace_checkpoint')
  const result = await replaceCheckpointChainForImport(importId)
  const reconciliationRefresh = await refreshReconciliationAfterCommit()
  return { ...result, reconciliationRefresh }
}
export async function confirmImportCoverage(input: {
  importId: string
  periodStart: string
  periodEnd: string
}) {
  assertIsoDate(input.periodStart)
  assertIsoDate(input.periodEnd)
  await ensureDatabase()
  const importRows = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, input.importId))
    .limit(1)
  const importRow = importRows.at(0)
  if (!importRow) throw new Error('Importação não encontrada.')
  await assertImportActionable(importRow, 'confirm_coverage')
  const confirmation = await confirmCoveragePeriod(input)
  await reconcileCsvWithPdfControl({
    importIds: confirmation.relatedImportIds,
    targetType: confirmation.targetType,
    targetId: confirmation.targetId,
  })
  if (confirmation.batchId) {
    await refreshImportBatchCoverage({
      batchId: confirmation.batchId,
      mode: 'staged',
    })
  }
  return { success: true }
}

export async function clearTransactionData() {
  await ensureDatabase()
  const storedFiles = await db
    .select({ storagePath: schema.sourceFiles.storagePath })
    .from(schema.sourceFiles)
  const transactionCount = (
    await db.select({ id: schema.transactions.id }).from(schema.transactions)
  ).length
  const importCount = (
    await db.select({ id: schema.imports.id }).from(schema.imports)
  ).length

  db.transaction((transaction) => {
    transaction
      .update(schema.goalContributions)
      .set({ transactionId: null })
      .run()
    transaction.delete(schema.reconciliationLinks).run()
    transaction.delete(schema.reconciliationGroups).run()
    transaction.delete(schema.cardStatementCycles).run()
    transaction.delete(schema.transactionSplits).run()
    transaction.delete(schema.transactionEvidence).run()
    transaction.delete(schema.transactionCorrections).run()
    transaction.delete(schema.transactions).run()
    transaction.delete(schema.balanceCheckpoints).run()
    transaction.delete(schema.stagedTransactions).run()
    transaction.delete(schema.coverageIntervals).run()
    transaction.delete(schema.imports).run()
    transaction.delete(schema.importBatches).run()
    transaction.delete(schema.sourceFiles).run()
    transaction.delete(schema.monthlyBudgets).run()
    transaction
      .update(schema.accounts)
      .set({
        statementBalanceCents: null,
        statementBalanceAt: null,
        coverageStart: null,
      })
      .run()
    transaction
      .update(schema.creditCards)
      .set({
        statementBalanceCents: null,
        statementBalanceAt: null,
        coverageStart: null,
      })
      .run()
  })

  const importsDirectory = resolve(process.cwd(), 'data', 'imports')
  await Promise.allSettled(
    storedFiles.map(async ({ storagePath }) => {
      const absolutePath = resolve(storagePath)
      if (!absolutePath.startsWith(`${importsDirectory}${sep}`)) return
      await unlink(absolutePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }),
  )

  return { transactionCount, importCount }
}

export async function getStoredSource(importId: string) {
  await ensureDatabase()
  const rows = await db
    .select({ storagePath: schema.sourceFiles.storagePath })
    .from(schema.imports)
    .innerJoin(
      schema.sourceFiles,
      eq(schema.imports.sourceFileId, schema.sourceFiles.id),
    )
    .where(eq(schema.imports.id, importId))
    .limit(1)
  if (!rows[0]) throw new Error('Arquivo não encontrado.')
  return readFile(rows[0].storagePath)
}
