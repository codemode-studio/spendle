import { randomUUID } from 'node:crypto'
import { and, eq, gte, inArray, or } from 'drizzle-orm'

import { db } from '#/db/index.server'
import * as schema from '#/db/schema'
import { classifyCheckpointAtDate } from '#/domain/balance-checkpoint'
import {
  assignDependentBatchEvidence,
  externalIdentityOwnerKey,
  resolveImportObservationOutcomes,
  statementValueSignature,
} from '#/domain/canonicalization'
import type {
  ImportObservationOutcome,
  CanonicalOutcomeAssignment,
} from '#/domain/canonicalization'
import {
  getEffectiveImportValidationState,
  nextValidationState,
} from '#/domain/import-audit'
import { linkCanonicalObservation } from './canonicalization.server'
import {
  applyCardCycleChange,
  applyImportCheckpointDecision,
  applyPendingPromotion,
} from './checkpoint-chain.server'
import type {
  CardCycleChange,
  ImportCheckpointDecision,
  PendingPromotion,
} from './checkpoint-chain.server'
import {
  hasReliableCoverage,
  setCoverageInterval,
} from './coverage-lifecycle.server'
import { loadEffectiveImportValidationStates } from './import-guards.server'
import { reopenRestoredExclusionOwners } from './statement-exclusions.server'

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export function applyCanonicalEvidenceLink(
  transaction: DatabaseTransaction,
  input: Parameters<typeof linkCanonicalObservation>[1],
) {
  linkCanonicalObservation(transaction, input)
}

export interface ImportOutcome {
  importId: string
  target: { type: 'account' | 'card'; id: string }
  observations: ImportObservationOutcome[]
  checkpoint: ImportCheckpointDecision
  cardCycle: CardCycleChange
  promotions: PendingPromotion[]
  coverage: {
    start: string
    end: string
    source: 'metadata' | 'filename' | 'user'
    confidence: 'high' | 'medium' | 'low'
  } | null
  batchEvidence: Array<{
    importId: string
    observationId: string
    transactionId: string
    externalId: string | null
  }>
  dependentImportIds: string[]
  restoration?: {
    exclusionReasonSuffix: string
    validationMessage: string
    reconciliationReason: string
    checkpointReason: string
  }
  commit?: {
    importPatch: Partial<typeof schema.imports.$inferInsert> | null
    transactions: Array<typeof schema.transactions.$inferInsert>
    installments: Array<typeof schema.installmentPlans.$inferInsert>
    validation: {
      status: 'imported' | 'warning' | 'reconciled' | 'divergent'
      reason: typeof schema.imports.$inferSelect.validationReason
      message: string
      expectedBalanceCents: number | null
      balanceDifferenceCents: number | null
    }
  }
}

export function resolveImportOutcome(
  transaction: DatabaseTransaction,
  importId: string,
  options: {
    mode?: 'full' | 'evidence_only'
    assignments?: Array<{
      observationId: string
      transactionId: string
      externalId: string | null
    }>
    checkpointImportId?: string
    checkpointSource?: 'csv' | 'ofx' | 'pdf'
    auditStatus?: 'imported' | 'warning' | 'reconciled' | 'divergent'
    balanceDifferenceCents?: number | null
    checkpointMethod?: 'date_amount_currency_multiset'
    importOverrides?: Partial<typeof schema.imports.$inferSelect>
    createdTransactions?: Array<{ id: string; externalId: string | null }>
    createdTransactionByObservation?: Map<string, string>
  } = {},
): ImportOutcome {
  const storedImport = transaction
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, importId))
    .get()
  const importRow = storedImport
    ? { ...storedImport, ...options.importOverrides }
    : null
  if (!importRow || (!importRow.accountId && !importRow.creditCardId)) {
    throw new Error('Importação não encontrada.')
  }
  const staged = transaction
    .select()
    .from(schema.stagedTransactions)
    .where(eq(schema.stagedTransactions.importId, importId))
    .all()
  const target = importRow.accountId
    ? { type: 'account' as const, id: importRow.accountId }
    : { type: 'card' as const, id: importRow.creditCardId! }
  const ledger = transaction
    .select({
      id: schema.transactions.id,
      externalId: schema.transactions.externalId,
      fingerprint: schema.transactions.fingerprint,
      postedAt: schema.transactions.postedAt,
      status: schema.transactions.status,
    })
    .from(schema.transactions)
    .where(
      target.type === 'account'
        ? eq(schema.transactions.accountId, target.id)
        : eq(schema.transactions.creditCardId, target.id),
    )
    .all()
  const promotedIds = new Map(
    (options.assignments ?? []).flatMap((assignment) =>
      assignment.externalId
        ? [[assignment.transactionId, assignment.externalId] as const]
        : [],
    ),
  )
  const effectiveLedger = ledger.map((item) => ({
    ...item,
    externalId: promotedIds.get(item.id) ?? item.externalId,
  }))
  const reliableCoverage = hasReliableCoverage({
    periodStart: importRow.periodStart,
    periodEnd: importRow.periodEnd,
    periodSource: importRow.periodSource,
  })
  const eligibleLedger = effectiveLedger.filter(
    (item) =>
      Boolean(item.externalId) ||
      (reliableCoverage &&
        item.postedAt >= importRow.periodStart! &&
        item.postedAt <= importRow.periodEnd!),
  )
  const knownEvidenceVersions = ledger.length
    ? transaction
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
              ledger.map((item) => item.id),
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
        .all()
    : []
  const assignments: CanonicalOutcomeAssignment[] = (
    options.assignments ?? []
  ).map((assignment) => ({
    observationId: assignment.observationId,
    transactionId: assignment.transactionId,
    reason: 'trusted_statement_control',
  }))
  const observations = resolveImportObservationOutcomes({
    observations: staged,
    transactions: eligibleLedger,
    assignments,
    knownEvidenceVersions,
  }).map((decision) =>
    decision.kind === 'new'
      ? {
          ...decision,
          transactionId: options.createdTransactionByObservation?.get(
            decision.observationId,
          ),
        }
      : decision,
  )

  if (options.mode === 'evidence_only') {
    return {
      importId,
      target,
      observations,
      checkpoint: { kind: 'none' },
      cardCycle: { kind: 'none' },
      promotions: [],
      coverage: null,
      batchEvidence: (options.assignments ?? []).map((assignment) => ({
        importId,
        ...assignment,
      })),
      dependentImportIds: [],
    }
  }

  const balanceType =
    target.type === 'card'
      ? ('card_statement' as const)
      : importRow.closingBalanceType === 'available'
        ? ('available' as const)
        : ('posted' as const)
  const checkpointAtDate =
    importRow.closingBalanceCents !== null && importRow.balanceAsOf
      ? classifyCheckpointAtDate(
          transaction
            .select()
            .from(schema.balanceCheckpoints)
            .where(
              target.type === 'account'
                ? eq(schema.balanceCheckpoints.accountId, target.id)
                : eq(schema.balanceCheckpoints.creditCardId, target.id),
            )
            .all(),
          {
            balanceType,
            balanceCents: importRow.closingBalanceCents,
            asOf: importRow.balanceAsOf,
          },
        )
      : { status: 'none' as const, checkpointId: null }
  if (checkpointAtDate.status === 'conflict') {
    throw new Error(
      'Já existe outro saldo ativo deste tipo para a mesma data. Invalide o ponto anterior antes de consolidar este arquivo.',
    )
  }
  const targetRow =
    target.type === 'account'
      ? transaction
          .select({ coverageStart: schema.accounts.coverageStart })
          .from(schema.accounts)
          .where(eq(schema.accounts.id, target.id))
          .get()
      : transaction
          .select({ coverageStart: schema.creditCards.coverageStart })
          .from(schema.creditCards)
          .where(eq(schema.creditCards.id, target.id))
          .get()
  const checkpoint: ImportCheckpointDecision =
    importRow.closingBalanceCents === null || !importRow.balanceAsOf
      ? { kind: 'none' }
      : {
          kind: 'anchor',
          targetType: target.type,
          targetId: target.id,
          importId: options.checkpointImportId ?? importId,
          balanceCents: importRow.closingBalanceCents,
          asOf: importRow.balanceAsOf,
          balanceType,
          source:
            options.checkpointSource ??
            (importRow.parser === 'ofx'
              ? 'ofx'
              : importRow.parser === 'csv'
                ? 'csv'
                : 'pdf'),
          reviewState:
            balanceType !== 'available' && options.auditStatus === 'reconciled'
              ? 'verified'
              : 'observed',
          differenceCents:
            balanceType === 'available'
              ? null
              : (options.balanceDifferenceCents ??
                importRow.balanceDifferenceCents),
          method: options.checkpointMethod ?? null,
          create: checkpointAtDate.status === 'none',
          coverageStart:
            targetRow?.coverageStart ??
            importRow.periodStart ??
            importRow.balanceAsOf,
          dueDate: importRow.statementDueDate,
        }
  const coverage =
    reliableCoverage &&
    importRow.periodStart &&
    importRow.periodEnd &&
    (importRow.periodSource === 'metadata' ||
      importRow.periodSource === 'filename' ||
      importRow.periodSource === 'user')
      ? {
          start: importRow.periodStart,
          end: importRow.periodEnd,
          source: importRow.periodSource,
          confidence:
            importRow.coverageConfidence === 'unknown'
              ? ('low' as const)
              : importRow.coverageConfidence,
        }
      : null
  const cardCycle: CardCycleChange =
    target.type === 'card' &&
    importRow.closingBalanceCents !== null &&
    importRow.periodStart &&
    importRow.periodEnd &&
    coverage
      ? {
          kind: 'close',
          id: randomUUID(),
          creditCardId: target.id,
          importId: options.checkpointImportId ?? importId,
          periodStart: importRow.periodStart,
          periodEnd: importRow.periodEnd,
          closingDate: importRow.balanceAsOf,
          dueDate: importRow.statementDueDate,
          totalCents: importRow.closingBalanceCents,
          status:
            options.auditStatus === 'reconciled' ? 'reconciled' : 'closed',
        }
      : { kind: 'none' }
  const promotions: PendingPromotion[] =
    target.type === 'card' && importRow.balanceAsOf
      ? [
          {
            creditCardId: target.id,
            from: importRow.periodStart,
            // A statement only proves the rows inside its declared period.
            through:
              importRow.periodEnd && importRow.periodEnd < importRow.balanceAsOf
                ? importRow.periodEnd
                : importRow.balanceAsOf,
          },
        ]
      : []
  const dependentEvidence = resolveDependentEvidence(
    transaction,
    target,
    importRow,
    staged,
    observations,
    options.createdTransactions ?? [],
  )

  return {
    importId,
    target,
    observations,
    checkpoint,
    cardCycle,
    promotions,
    coverage,
    batchEvidence: [
      ...(options.assignments ?? []).map((assignment) => ({
        importId,
        ...assignment,
      })),
      ...dependentEvidence.assignments,
    ],
    dependentImportIds: dependentEvidence.importIds,
  }
}

function resolveDependentEvidence(
  transaction: DatabaseTransaction,
  target: ImportOutcome['target'],
  importRow: typeof schema.imports.$inferSelect,
  staged: Array<typeof schema.stagedTransactions.$inferSelect>,
  observations: ImportObservationOutcome[],
  createdTransactions: Array<{ id: string; externalId: string | null }>,
) {
  const dependentImports = importRow.batchId
    ? transaction
        .select()
        .from(schema.imports)
        .where(eq(schema.imports.batchId, importRow.batchId))
        .all()
        .filter(
          (candidate) =>
            candidate.status === 'review' &&
            getEffectiveImportValidationState(candidate).remediation.links &&
            candidate.dependsOnImportId === importRow.id,
        )
    : []
  const dependentObservations = dependentImports.length
    ? transaction
        .select()
        .from(schema.stagedTransactions)
        .where(
          inArray(
            schema.stagedTransactions.importId,
            dependentImports.map((candidate) => candidate.id),
          ),
        )
        .all()
    : []
  const stagedById = new Map(staged.map((item) => [item.id, item]))
  const canonical = observations.flatMap((decision) => {
    const item = stagedById.get(decision.observationId)
    return item && decision.transactionId
      ? [
          {
            transactionId: decision.transactionId,
            signature: statementValueSignature(item),
          },
        ]
      : []
  })
  if (!dependentImports.length) {
    return { importIds: [], assignments: [] }
  }
  const existingTransactions = transaction
    .select({
      id: schema.transactions.id,
      externalId: schema.transactions.externalId,
      accountId: schema.transactions.accountId,
      creditCardId: schema.transactions.creditCardId,
    })
    .from(schema.transactions)
    .all()
  const externalOwner = new Map([
    ...existingTransactions.flatMap((item) => {
      const ownerTarget = item.accountId
        ? ({ type: 'account', id: item.accountId } as const)
        : item.creditCardId
          ? ({ type: 'card', id: item.creditCardId } as const)
          : null
      return item.externalId && ownerTarget
        ? [
            [
              externalIdentityOwnerKey(ownerTarget, item.externalId),
              item.id,
            ] as const,
          ]
        : []
    }),
    ...createdTransactions.flatMap((item) =>
      item.externalId
        ? [
            [
              externalIdentityOwnerKey(target, item.externalId),
              item.id,
            ] as const,
          ]
        : [],
    ),
  ])
  const externalIdByTransaction = new Map(
    [...existingTransactions, ...createdTransactions].flatMap((item) =>
      item.externalId ? [[item.id, item.externalId] as const] : [],
    ),
  )
  const assignments: ImportOutcome['batchEvidence'] = []
  for (const dependentImport of dependentImports) {
    const resolved = assignDependentBatchEvidence({
      canonical,
      observations: dependentObservations
        .filter((item) => item.importId === dependentImport.id)
        .map((item) => ({
          observationId: item.id,
          signature: statementValueSignature(item),
          externalId: item.externalId,
        })),
    })
    if (resolved.unmatchedObservationIds.length) {
      throw new Error(
        'O arquivo dependente deixou de corresponder ao documento principal. Nenhuma alteração foi aplicada; refaça o lote.',
      )
    }
    for (const assignment of resolved.assignments) {
      if (assignment.externalId) {
        const ownerKey = externalIdentityOwnerKey(target, assignment.externalId)
        const owner = externalOwner.get(ownerKey)
        const currentExternalId = externalIdByTransaction.get(
          assignment.transactionId,
        )
        if (
          (owner && owner !== assignment.transactionId) ||
          (currentExternalId && currentExternalId !== assignment.externalId)
        ) {
          throw new Error(
            'O identificador bancário do arquivo relacionado já pertence a outro lançamento. Nenhuma alteração foi aplicada; revise o lote.',
          )
        }
        externalOwner.set(ownerKey, assignment.transactionId)
        externalIdByTransaction.set(
          assignment.transactionId,
          assignment.externalId,
        )
      }
      assignments.push({ importId: dependentImport.id, ...assignment })
    }
  }
  return { importIds: dependentImports.map((item) => item.id), assignments }
}

function applyTransferRules(
  transaction: DatabaseTransaction,
  outcome: ImportOutcome,
) {
  if (outcome.target.type !== 'account') return
  const observations = transaction
    .select()
    .from(schema.stagedTransactions)
    .where(eq(schema.stagedTransactions.importId, outcome.importId))
    .all()
  for (const item of observations) {
    if (
      item.suggestedCategoryId !== 'transfer' ||
      !item.counterpartyAccountId ||
      item.counterpartyAccountId === outcome.target.id
    ) {
      continue
    }
    transaction
      .insert(schema.categorizationRules)
      .values({
        id: randomUUID(),
        pattern: item.normalizedDescription,
        accountId: outcome.target.id,
        counterpartyAccountId: item.counterpartyAccountId,
        direction: item.amountCents < 0 ? 'outgoing' : 'incoming',
        categoryId: 'transfer',
        priority: 5,
      })
      .onConflictDoUpdate({
        target: [
          schema.categorizationRules.pattern,
          schema.categorizationRules.accountId,
          schema.categorizationRules.direction,
        ],
        set: {
          counterpartyAccountId: item.counterpartyAccountId,
          categoryId: 'transfer',
          priority: 5,
          active: true,
        },
      })
      .run()
  }
}

function restoreExcludedTransactions(
  transaction: DatabaseTransaction,
  outcome: ImportOutcome,
) {
  const restoredDecisions = outcome.observations.filter(
    (decision) => decision.kind === 'excluded' && decision.transactionId,
  )
  const restoredTransactionIds = [
    ...new Set(restoredDecisions.map((decision) => decision.transactionId!)),
  ]
  if (!restoredTransactionIds.length) return
  const staged = transaction
    .select({
      id: schema.stagedTransactions.id,
      postedAt: schema.stagedTransactions.postedAt,
    })
    .from(schema.stagedTransactions)
    .where(
      inArray(
        schema.stagedTransactions.id,
        restoredDecisions.map((decision) => decision.observationId),
      ),
    )
    .all()
  const affectedFrom = staged
    .map((item) => item.postedAt)
    .sort()
    .at(0)!
  const importRow = transaction
    .select({ closingBalanceCents: schema.imports.closingBalanceCents })
    .from(schema.imports)
    .where(eq(schema.imports.id, outcome.importId))
    .get()
  reopenRestoredExclusionOwners(transaction, {
    transactionIds: restoredTransactionIds,
    exclusionReasonSuffix:
      outcome.restoration?.exclusionReasonSuffix ??
      'Reaberta automaticamente porque uma importação posterior comprovou a movimentação.',
    validationMessage:
      outcome.restoration?.validationMessage ??
      'Uma movimentação antes marcada como autorização ausente apareceu em uma importação posterior. O fechamento e os saldos seguintes foram reabertos para conferência.',
  })
  transaction
    .update(schema.transactions)
    .set({
      status:
        outcome.target.type === 'card' &&
        importRow?.closingBalanceCents === null
          ? 'pending'
          : 'confirmed',
    })
    .where(inArray(schema.transactions.id, restoredTransactionIds))
    .run()
  const affectedGroupIds = transaction
    .select({ groupId: schema.reconciliationLinks.groupId })
    .from(schema.reconciliationLinks)
    .where(
      inArray(schema.reconciliationLinks.transactionId, restoredTransactionIds),
    )
    .all()
  const groupIds = [...new Set(affectedGroupIds.map((item) => item.groupId))]
  const linkedGroups = groupIds.length
    ? transaction
        .select({
          groupId: schema.reconciliationLinks.groupId,
          transactionId: schema.reconciliationLinks.transactionId,
          previousCategoryId: schema.reconciliationLinks.previousCategoryId,
          status: schema.reconciliationGroups.status,
        })
        .from(schema.reconciliationLinks)
        .innerJoin(
          schema.reconciliationGroups,
          eq(
            schema.reconciliationGroups.id,
            schema.reconciliationLinks.groupId,
          ),
        )
        .where(inArray(schema.reconciliationLinks.groupId, groupIds))
        .all()
    : []
  for (const link of linkedGroups) {
    if (link.status !== 'confirmed') continue
    transaction
      .update(schema.transactions)
      .set({ categoryId: link.previousCategoryId })
      .where(eq(schema.transactions.id, link.transactionId))
      .run()
  }
  if (groupIds.length) {
    transaction
      .update(schema.reconciliationGroups)
      .set({
        status: 'suggested',
        aiValidation: null,
        aiConfidence: null,
        aiReason: null,
        aiValidatedAt: null,
        reason:
          outcome.restoration?.reconciliationReason ??
          'Reaberta porque uma movimentação antes excluída reapareceu em uma importação posterior.',
      })
      .where(inArray(schema.reconciliationGroups.id, groupIds))
      .run()
  }
  if (outcome.target.type === 'card') {
    transaction
      .update(schema.cardStatementCycles)
      .set({ status: 'closed' })
      .where(
        and(
          eq(schema.cardStatementCycles.creditCardId, outcome.target.id),
          gte(schema.cardStatementCycles.periodEnd, affectedFrom),
        ),
      )
      .run()
  }
  applyImportCheckpointDecision(transaction, {
    kind: 'invalidate-from',
    targetType: outcome.target.type,
    targetId: outcome.target.id,
    from: affectedFrom,
    reason:
      outcome.restoration?.checkpointReason ??
      'Uma movimentação antes excluída reapareceu em uma importação posterior.',
  })
}

function applyObservationEvidence(
  transaction: DatabaseTransaction,
  outcome: ImportOutcome,
) {
  for (const decision of outcome.observations) {
    if (!decision.transactionId || decision.kind === 'correction') continue
    const observation = transaction
      .select({ externalId: schema.stagedTransactions.externalId })
      .from(schema.stagedTransactions)
      .where(eq(schema.stagedTransactions.id, decision.observationId))
      .get()
    const batchAssignment = outcome.batchEvidence.find(
      (assignment) => assignment.observationId === decision.observationId,
    )
    const duplicateReason = decision.reasons.includes('stable_external_id')
      ? ('external_id' as const)
      : decision.reasons.includes('exact_overlap')
        ? ('fingerprint_overlap' as const)
        : null
    applyCanonicalEvidenceLink(transaction, {
      stagedTransactionId: decision.observationId,
      transactionId: decision.transactionId,
      matchKind:
        decision.kind === 'new'
          ? 'created'
          : decision.reasons.includes('trusted_statement_control')
            ? 'statement_control'
            : duplicateReason === 'external_id'
              ? 'external_id'
              : 'exact_overlap',
      duplicate: decision.kind !== 'new',
      duplicateReason,
      externalId:
        batchAssignment?.externalId ??
        (duplicateReason === 'fingerprint_overlap'
          ? observation?.externalId
          : null),
    })
  }
}

function applyDependentEvidence(
  transaction: DatabaseTransaction,
  outcome: ImportOutcome,
) {
  if (!outcome.dependentImportIds.length) return
  for (const importId of outcome.dependentImportIds) {
    for (const assignment of outcome.batchEvidence.filter(
      (item) => item.importId === importId,
    )) {
      applyCanonicalEvidenceLink(transaction, {
        stagedTransactionId: assignment.observationId,
        transactionId: assignment.transactionId,
        matchKind: 'statement_control',
        duplicate: true,
        duplicateReason: null,
        externalId: assignment.externalId,
      })
    }
    const updated = transaction
      .update(schema.imports)
      .set({
        status: 'evidence',
        committedAt: new Date(),
        validationMessage:
          'Arquivo preservado como evidência do documento principal consolidado, sem criar lançamentos duplicados.',
      })
      .where(
        and(
          eq(schema.imports.id, importId),
          eq(schema.imports.status, 'review'),
        ),
      )
      .run()
    if (updated.changes !== 1) {
      throw new Error(
        'Um arquivo relacionado saiu da revisão durante a consolidação. Nenhuma alteração foi aplicada; atualize a página.',
      )
    }
  }
}

export function applyImportOutcome(
  transaction: DatabaseTransaction,
  outcome: ImportOutcome,
) {
  if (outcome.commit) {
    if (outcome.commit.importPatch) {
      transaction
        .update(schema.imports)
        .set(outcome.commit.importPatch)
        .where(eq(schema.imports.id, outcome.importId))
        .run()
    }
    applyTransferRules(transaction, outcome)
    if (outcome.commit.transactions.length) {
      transaction
        .insert(schema.transactions)
        .values(outcome.commit.transactions)
        .run()
    }
    restoreExcludedTransactions(transaction, outcome)
    applyObservationEvidence(transaction, outcome)
    applyDependentEvidence(transaction, outcome)
    if (outcome.commit.installments.length) {
      transaction
        .insert(schema.installmentPlans)
        .values(outcome.commit.installments)
        .onConflictDoNothing()
        .run()
    }
    const updated = transaction
      .update(schema.imports)
      .set({
        status: outcome.commit.transactions.length ? 'committed' : 'evidence',
        committedAt: new Date(),
        validationStatus: outcome.commit.validation.status,
        validationReason: outcome.commit.validation.reason,
        validationMessage: outcome.commit.validation.message,
        expectedBalanceCents: outcome.commit.validation.expectedBalanceCents,
        balanceDifferenceCents:
          outcome.commit.validation.balanceDifferenceCents,
      })
      .where(
        and(
          eq(schema.imports.id, outcome.importId),
          eq(schema.imports.status, 'review'),
        ),
      )
      .run()
    if (updated.changes !== 1) {
      throw new Error(
        'A importação saiu da revisão enquanto era consolidada. Nenhum lançamento foi alterado; atualize a página.',
      )
    }
  } else {
    applyObservationEvidence(transaction, outcome)
  }
  applyCardCycleChange(transaction, outcome.cardCycle)
  applyImportCheckpointDecision(transaction, outcome.checkpoint)
  for (const promotion of outcome.promotions) {
    applyPendingPromotion(transaction, promotion)
  }
  if (outcome.coverage) {
    setCoverageInterval(transaction, {
      importId: outcome.importId,
      accountId: outcome.target.type === 'account' ? outcome.target.id : null,
      creditCardId: outcome.target.type === 'card' ? outcome.target.id : null,
      ...outcome.coverage,
    })
  }
}

export async function recoverBatchEvidence(batchId: string) {
  const evidenceImports = await db
    .select()
    .from(schema.imports)
    .where(
      and(
        eq(schema.imports.batchId, batchId),
        eq(schema.imports.status, 'evidence'),
      ),
    )
  if (!evidenceImports.length) return
  const stagedRows = await db
    .select({
      id: schema.stagedTransactions.id,
      importId: schema.stagedTransactions.importId,
    })
    .from(schema.stagedTransactions)
    .where(
      inArray(
        schema.stagedTransactions.importId,
        evidenceImports.map((item) => item.id),
      ),
    )
  const linkedRows = stagedRows.length
    ? await db
        .select({
          stagedTransactionId: schema.transactionEvidence.stagedTransactionId,
        })
        .from(schema.transactionEvidence)
        .where(
          inArray(
            schema.transactionEvidence.stagedTransactionId,
            stagedRows.map((item) => item.id),
          ),
        )
    : []
  const linkedObservationIds = new Set(
    linkedRows.map((item) => item.stagedTransactionId),
  )
  const importIdsWithUnlinkedObservations = new Set(
    stagedRows.flatMap((item) =>
      linkedObservationIds.has(item.id) ? [] : [item.importId],
    ),
  )
  const importRows = evidenceImports.filter((item) =>
    importIdsWithUnlinkedObservations.has(item.id),
  )
  const firstImport = importRows.at(0)
  if (!firstImport) return
  const validationStates = await loadEffectiveImportValidationStates(
    importRows,
    {
      targetType: firstImport.accountId ? 'account' : 'card',
      targetId: firstImport.accountId ?? firstImport.creditCardId!,
    },
  )
  for (const importRow of importRows) {
    if (!validationStates.get(importRow.id)?.remediation.links) {
      continue
    }
    db.transaction((transaction) => {
      const initial = resolveImportOutcome(transaction, importRow.id, {
        mode: 'evidence_only',
      })
      const staged = transaction
        .select()
        .from(schema.stagedTransactions)
        .where(eq(schema.stagedTransactions.importId, importRow.id))
        .all()
      const ledger = transaction
        .select()
        .from(schema.transactions)
        .where(
          importRow.accountId
            ? eq(schema.transactions.accountId, importRow.accountId)
            : eq(schema.transactions.creditCardId, importRow.creditCardId!),
        )
        .all()
      const reserved = new Set(
        initial.observations.flatMap((decision) =>
          decision.transactionId ? [decision.transactionId] : [],
        ),
      )
      const assignments = initial.observations.flatMap((decision) => {
        if (decision.kind !== 'new') return []
        const observation = staged.find(
          (item) => item.id === decision.observationId,
        )
        const candidate = observation
          ? ledger.find(
              (item) =>
                !reserved.has(item.id) &&
                (!observation.externalId || !item.externalId) &&
                statementValueSignature(item) ===
                  statementValueSignature(observation),
            )
          : null
        if (!candidate) return []
        reserved.add(candidate.id)
        return [
          {
            observationId: decision.observationId,
            transactionId: candidate.id,
            externalId: observation?.externalId ?? null,
          },
        ]
      })
      const outcome = assignments.length
        ? resolveImportOutcome(transaction, importRow.id, {
            mode: 'evidence_only',
            assignments,
          })
        : initial
      applyImportOutcome(transaction, outcome)
    })
  }
}

export async function matchStructuredImportToTrustedControls(
  importRow: typeof schema.imports.$inferSelect,
  staged: Array<typeof schema.stagedTransactions.$inferSelect>,
  existingTransactions: Array<
    Pick<
      typeof schema.transactions.$inferSelect,
      | 'id'
      | 'importId'
      | 'status'
      | 'externalId'
      | 'postedAt'
      | 'amountCents'
      | 'currency'
    >
  >,
) {
  const assignments = new Map<
    string,
    { transactionId: string; externalId: string | null }
  >()
  if (
    (importRow.parser !== 'csv' && importRow.parser !== 'ofx') ||
    (!importRow.creditCardId && !importRow.accountId)
  ) {
    return assignments
  }

  const cardControls = importRow.creditCardId
    ? await db
        .select({
          periodStart: schema.cardStatementCycles.periodStart,
          periodEnd: schema.cardStatementCycles.periodEnd,
          importId: schema.cardStatementCycles.importId,
        })
        .from(schema.cardStatementCycles)
        .where(
          and(
            eq(schema.cardStatementCycles.creditCardId, importRow.creditCardId),
            eq(schema.cardStatementCycles.status, 'reconciled'),
          ),
        )
    : []
  const accountControls = importRow.accountId
    ? await db
        .select({
          periodStart: schema.imports.periodStart,
          periodEnd: schema.imports.periodEnd,
          importId: schema.imports.id,
          reviewState: schema.balanceCheckpoints.reviewState,
        })
        .from(schema.balanceCheckpoints)
        .innerJoin(
          schema.imports,
          eq(schema.imports.id, schema.balanceCheckpoints.importId),
        )
        .where(
          and(
            eq(schema.balanceCheckpoints.accountId, importRow.accountId),
            eq(schema.balanceCheckpoints.source, 'pdf'),
            inArray(schema.imports.status, ['committed', 'evidence']),
          ),
        )
    : []
  const controls = [
    ...cardControls.map((control) => ({ ...control, kind: 'card' as const })),
    ...accountControls
      .filter(
        (control) =>
          control.reviewState !== 'invalidated' &&
          control.periodStart &&
          control.periodEnd,
      )
      .map((control) => ({
        periodStart: control.periodStart!,
        periodEnd: control.periodEnd!,
        importId: control.importId,
        kind: 'account' as const,
      })),
  ]
  if (!controls.length) return assignments

  const accountControlImportIds = controls.flatMap((control) =>
    control.kind === 'account' && control.importId ? [control.importId] : [],
  )
  const accountControlEvidence = accountControlImportIds.length
    ? await db
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
        .where(
          inArray(schema.stagedTransactions.importId, accountControlImportIds),
        )
    : []
  const controlledTransactionIdsByImport = new Map<string, Set<string>>()
  for (const evidence of accountControlEvidence) {
    const transactionIds =
      controlledTransactionIdsByImport.get(evidence.importId) ??
      new Set<string>()
    transactionIds.add(evidence.transactionId)
    controlledTransactionIdsByImport.set(evidence.importId, transactionIds)
  }

  const reservedTransactionIds = new Set<string>()
  for (const observation of staged) {
    const postedDate = observation.postedAt.slice(0, 10)
    const matchingControls = controls.filter(
      (control) =>
        postedDate >= control.periodStart && postedDate <= control.periodEnd,
    )
    if (!matchingControls.length) continue
    if (
      importRow.creditCardId &&
      matchingControls.filter((control) => control.kind === 'card').length > 1
    ) {
      const message =
        'O lançamento pertence a mais de um ciclo reconciliado. Revise os períodos das faturas antes de consolidar este CSV.'
      await db
        .update(schema.imports)
        .set(
          nextValidationState({
            current: importRow,
            evaluated: {
              validationStatus: 'divergent',
              validationReason: 'blocked',
              validationMessage: message,
            },
          }),
        )
        .where(eq(schema.imports.id, importRow.id))
      throw new Error(message)
    }
    if (
      observation.externalId &&
      existingTransactions.some(
        (transaction) => transaction.externalId === observation.externalId,
      )
    ) {
      continue
    }

    const controlledImportIds = new Set(
      matchingControls.flatMap((control) =>
        control.kind === 'account' && control.importId
          ? [control.importId]
          : [],
      ),
    )
    const controlledTransactionIds = new Set(
      [...controlledImportIds].flatMap((controlledImportId) => [
        ...(controlledTransactionIdsByImport.get(controlledImportId) ?? []),
      ]),
    )
    const candidate = existingTransactions
      .filter(
        (transaction) =>
          (transaction.status === 'confirmed' ||
            transaction.status === 'excluded') &&
          (!observation.externalId || !transaction.externalId) &&
          !reservedTransactionIds.has(transaction.id) &&
          matchingControls.some(
            (control) =>
              transaction.postedAt.slice(0, 10) >= control.periodStart &&
              transaction.postedAt.slice(0, 10) <= control.periodEnd,
          ) &&
          (!importRow.accountId ||
            (transaction.importId !== null &&
              controlledImportIds.has(transaction.importId)) ||
            controlledTransactionIds.has(transaction.id)) &&
          statementValueSignature(transaction) ===
            statementValueSignature(observation),
      )
      .sort((left, right) =>
        left.status !== right.status
          ? left.status === 'confirmed'
            ? -1
            : 1
          : left.id.localeCompare(right.id),
      )
      .at(0)
    if (!candidate) {
      const message = `O arquivo estruturado contém o lançamento "${observation.description}" dentro de um período já controlado por PDF, mas não existe uma linha idêntica em data, valor e moeda. Revise ou rejeite o arquivo; nenhuma duplicidade foi criada.`
      await db
        .update(schema.imports)
        .set(
          nextValidationState({
            current: importRow,
            evaluated: {
              validationStatus: 'divergent',
              validationReason: 'blocked',
              validationMessage: message,
            },
          }),
        )
        .where(eq(schema.imports.id, importRow.id))
      throw new Error(message)
    }
    reservedTransactionIds.add(candidate.id)
    assignments.set(observation.id, {
      transactionId: candidate.id,
      externalId: observation.externalId,
    })
  }

  return assignments
}
