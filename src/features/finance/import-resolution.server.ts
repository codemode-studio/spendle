import { randomUUID } from 'node:crypto'
import { and, eq, gte, inArray, lte } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import {
  findTransactionsAbsentFromStatement,
  matchOptionalStatementValues,
  statementLinkIsCompatible,
} from '#/domain/canonicalization'
import { convertMinorUnitsAtRate } from '#/domain/currency'
import { evaluateImportAudit, nextValidationState } from '#/domain/import-audit'
import {
  invalidateCheckpointChain,
  refreshStatementAnchor,
} from './checkpoint-chain.server'
import { applyCanonicalEvidenceLink } from './canonical-outcome.server'
import { assertImportActionable } from './import-guards.server'
import { reopenRestoredExclusionOwners } from './statement-exclusions.server'

export async function refreshStatementResolutionState(importId: string) {
  const importRows = await db
    .select()
    .from(schema.imports)
    .where(eq(schema.imports.id, importId))
    .limit(1)
  const importRow = importRows.at(0)
  if (
    !importRow ||
    !['review', 'committed', 'evidence'].includes(importRow.status) ||
    importRow.parser !== 'pdf_inspector' ||
    !importRow.creditCardId ||
    !importRow.periodStart ||
    !importRow.periodEnd
  ) {
    return null
  }

  const [observations, transactions] = await Promise.all([
    db
      .select({
        externalId: schema.stagedTransactions.externalId,
        postedAt: schema.stagedTransactions.postedAt,
        amountCents: schema.stagedTransactions.amountCents,
        currency: schema.stagedTransactions.currency,
      })
      .from(schema.stagedTransactions)
      .where(eq(schema.stagedTransactions.importId, importId)),
    db
      .select({
        externalId: schema.transactions.externalId,
        postedAt: schema.transactions.postedAt,
        amountCents: schema.transactions.amountCents,
        currency: schema.transactions.currency,
        status: schema.transactions.status,
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.creditCardId, importRow.creditCardId),
          gte(schema.transactions.postedAt, importRow.periodStart),
          lte(schema.transactions.postedAt, importRow.periodEnd),
        ),
      ),
  ])

  const eligibleTransactions = transactions.filter(
    (item) =>
      item.status !== 'excluded' &&
      (importRow.status === 'review' || item.status === 'pending'),
  )
  const statementResolution = matchOptionalStatementValues(
    observations,
    eligibleTransactions,
  )
  // Statement rows without any counterpart proceed as new transactions on
  // commit (ADR 001: overlapping imports add only what is new). Only existing
  // transactions that changed or are absent keep the reconciliation blocked.
  const absentTransactionCount = findTransactionsAbsentFromStatement(
    observations,
    eligibleTransactions,
  ).length
  const changedPairCount = statementResolution.changed.length
  const unresolvedCount = absentTransactionCount + changedPairCount
  const hasStatementMatchCandidates = changedPairCount > 0

  const audit = evaluateImportAudit({
    targetType: 'card',
    sourceTransactionCount: importRow.sourceTransactionCount,
    parsedTransactionCount: importRow.parsedTransactionCount,
    invalidTransactionCount: importRow.invalidTransactionCount,
    openingBalanceCents: importRow.openingBalanceCents,
    openingBalanceAt: importRow.openingBalanceAt,
    closingBalanceCents: importRow.closingBalanceCents,
    balanceAsOf: importRow.balanceAsOf,
    statementPeriodStart: importRow.periodStart,
    anchorBalanceCents: null,
    anchorBalanceAt: null,
    existingMovementCents: 0,
    newMovementCents: observations.reduce(
      (total, observation) => total + observation.amountCents,
      0,
    ),
  })
  const auditResolved = audit.status === 'reconciled'
  const resolvedCommittedState =
    importRow.status !== 'review' && unresolvedCount === 0
      ? {
          validationStatus:
            importRow.closingBalanceCents !== null && importRow.balanceAsOf
              ? ('reconciled' as const)
              : ('imported' as const),
          validationReason:
            importRow.closingBalanceCents !== null && importRow.balanceAsOf
              ? ('ready' as const)
              : ('needs_balance' as const),
          validationMessage:
            'A restauração foi conferida pela importação posterior e não deixou diferenças pendentes.',
        }
      : null
  const resolutionState = nextValidationState({
    current: importRow,
    evaluated:
      unresolvedCount > 0
        ? {
            validationStatus: 'divergent' as const,
            validationReason: hasStatementMatchCandidates
              ? ('statement_match_candidates' as const)
              : ('missing_statement_transactions' as const),
            validationMessage: hasStatementMatchCandidates
              ? `${unresolvedCount} linha(s) da fatura ainda não correspondem aos lançamentos atuais. Vincule ou corrija todas as diferenças antes de consolidar.`
              : `${unresolvedCount} lançamento(s) anterior(es) ainda não correspondem à fatura definitiva. Resolva todas as diferenças antes de consolidar.`,
          }
        : resolvedCommittedState
          ? resolvedCommittedState
          : auditResolved
            ? {
                validationStatus: 'reconciled' as const,
                validationReason: audit.reasonCode,
                validationMessage:
                  importRow.status === 'review'
                    ? 'Todas as diferenças da fatura foram resolvidas. Revise as categorias e consolide para concluir o fechamento.'
                    : 'Todas as diferenças da fatura foram resolvidas e o estado da conciliação foi atualizado automaticamente.',
              }
            : audit.status === 'divergent'
              ? {
                  validationStatus: audit.status,
                  validationReason: audit.reasonCode,
                  validationMessage: `${audit.message} Confira no PDF o total da fatura e se todas as linhas foram lidas; rejeite o arquivo se os valores continuarem diferentes.`,
                }
              : {
                  validationStatus: audit.status,
                  validationReason: audit.reasonCode,
                  validationMessage: audit.message,
                },
  })

  await db
    .update(schema.imports)
    .set(resolutionState)
    .where(eq(schema.imports.id, importId))

  return { unresolvedCount, auditResolved }
}

export async function resolveStatementExclusion(input: {
  importId: string
  transactionId: string
  action: 'exclude' | 'restore'
}) {
  await ensureDatabase()
  const rows = await db
    .select({ import: schema.imports, transaction: schema.transactions })
    .from(schema.imports)
    .innerJoin(
      schema.transactions,
      eq(schema.transactions.id, input.transactionId),
    )
    .where(eq(schema.imports.id, input.importId))
    .limit(1)
  const row = rows.at(0)
  if (
    !row ||
    row.import.parser !== 'pdf_inspector' ||
    !row.import.creditCardId ||
    row.transaction.creditCardId !== row.import.creditCardId ||
    !row.import.periodStart ||
    !row.import.periodEnd ||
    row.transaction.postedAt < row.import.periodStart ||
    row.transaction.postedAt > row.import.periodEnd
  ) {
    throw new Error('Este lançamento não pertence ao ciclo desta fatura.')
  }
  await assertImportActionable(row.import, 'resolve_statement_exclusion')
  const exclusions = await db
    .select()
    .from(schema.statementExclusions)
    .where(
      and(
        eq(schema.statementExclusions.importId, input.importId),
        eq(schema.statementExclusions.transactionId, input.transactionId),
      ),
    )
    .limit(1)
  const exclusion = exclusions.at(0)
  if (input.action === 'exclude') {
    if (
      row.import.status !== 'review' ||
      row.transaction.status !== 'pending'
    ) {
      throw new Error(
        'Somente um lançamento pendente de uma fatura em revisão pode ser marcado como ausente.',
      )
    }
    const [statementRows, pendingRows] = await Promise.all([
      db
        .select({
          externalId: schema.stagedTransactions.externalId,
          postedAt: schema.stagedTransactions.postedAt,
          amountCents: schema.stagedTransactions.amountCents,
          currency: schema.stagedTransactions.currency,
        })
        .from(schema.stagedTransactions)
        .where(eq(schema.stagedTransactions.importId, input.importId)),
      db
        .select({
          id: schema.transactions.id,
          externalId: schema.transactions.externalId,
          postedAt: schema.transactions.postedAt,
          amountCents: schema.transactions.amountCents,
          currency: schema.transactions.currency,
        })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.creditCardId, row.import.creditCardId),
            eq(schema.transactions.status, 'pending'),
            gte(schema.transactions.postedAt, row.import.periodStart),
            lte(schema.transactions.postedAt, row.import.periodEnd),
          ),
        )
        .orderBy(schema.transactions.id),
    ])
    const missingTransactions = findTransactionsAbsentFromStatement(
      statementRows,
      pendingRows,
    )
    if (!missingTransactions.some((item) => item.id === input.transactionId)) {
      throw new Error(
        'Este lançamento consta na fatura e não pode ser marcado como ausente.',
      )
    }
    db.transaction((transaction) => {
      transaction
        .insert(schema.statementExclusions)
        .values({
          id: exclusion?.id ?? randomUUID(),
          importId: input.importId,
          transactionId: input.transactionId,
          previousStatus: 'pending',
          reason:
            'O usuário confirmou que a autorização pendente não consta na fatura definitiva.',
          reversedAt: null,
        })
        .onConflictDoUpdate({
          target: [
            schema.statementExclusions.importId,
            schema.statementExclusions.transactionId,
          ],
          set: { reversedAt: null },
        })
        .run()
      transaction
        .update(schema.transactions)
        .set({ status: 'excluded' })
        .where(eq(schema.transactions.id, input.transactionId))
        .run()
      transaction
        .update(schema.imports)
        .set(
          nextValidationState({
            current: row.import,
            evaluated: {
              validationStatus: 'imported',
              validationReason: 'ready',
              validationMessage:
                'Autorização ausente da fatura marcada como cancelada. Consolide para conferir novamente o ciclo.',
            },
          }),
        )
        .where(eq(schema.imports.id, input.importId))
        .run()
    })
    await refreshStatementResolutionState(input.importId)
    return { success: true }
  }

  if (!exclusion || exclusion.reversedAt) return { success: true }
  db.transaction((transaction) => {
    transaction
      .update(schema.statementExclusions)
      .set({ reversedAt: new Date() })
      .where(eq(schema.statementExclusions.id, exclusion.id))
      .run()
    transaction
      .update(schema.transactions)
      .set({ status: 'pending' })
      .where(eq(schema.transactions.id, input.transactionId))
      .run()
    transaction
      .update(schema.imports)
      .set({
        status: 'review',
        ...nextValidationState({
          current: row.import,
          evaluated: {
            validationStatus: 'divergent',
            validationReason: 'missing_statement_transactions',
            validationMessage:
              'A exclusão foi desfeita. Resolva novamente a diferença antes de consolidar.',
          },
        }),
      })
      .where(eq(schema.imports.id, input.importId))
      .run()
    if (row.import.batchId) {
      transaction
        .update(schema.importBatches)
        .set({ status: 'review' })
        .where(eq(schema.importBatches.id, row.import.batchId))
        .run()
    }
    transaction
      .update(schema.cardStatementCycles)
      .set({ status: 'closed' })
      .where(
        and(
          eq(schema.cardStatementCycles.creditCardId, row.import.creditCardId!),
          lte(schema.cardStatementCycles.periodStart, row.transaction.postedAt),
          gte(schema.cardStatementCycles.periodEnd, row.transaction.postedAt),
        ),
      )
      .run()
    invalidateCheckpointChain(transaction, {
      targetType: 'card',
      targetId: row.import.creditCardId!,
      from: row.transaction.postedAt,
      reason:
        'A exclusão de uma autorização ausente foi desfeita pelo usuário.',
    })
    refreshStatementAnchor(transaction, {
      targetType: 'card',
      targetId: row.import.creditCardId!,
      balanceType: 'card_statement',
    })
  })
  await refreshStatementResolutionState(input.importId)
  return { success: true }
}

export async function linkStatementObservation(input: {
  stagedTransactionId: string
  transactionId: string
}) {
  await ensureDatabase()
  const rows = await db
    .select({
      staged: schema.stagedTransactions,
      import: schema.imports,
      transaction: schema.transactions,
    })
    .from(schema.stagedTransactions)
    .innerJoin(
      schema.imports,
      eq(schema.imports.id, schema.stagedTransactions.importId),
    )
    .innerJoin(
      schema.transactions,
      eq(schema.transactions.id, input.transactionId),
    )
    .where(eq(schema.stagedTransactions.id, input.stagedTransactionId))
    .limit(1)
  const row = rows.at(0)
  const restoresExcludedSameIdentity = Boolean(
    row?.transaction.status === 'excluded' &&
    row.staged.externalId &&
    row.staged.externalId === row.transaction.externalId,
  )
  if (
    !row ||
    row.import.status !== 'review' ||
    row.import.parser !== 'pdf_inspector' ||
    !row.import.creditCardId ||
    row.transaction.creditCardId !== row.import.creditCardId ||
    (row.transaction.status === 'excluded' && !restoresExcludedSameIdentity) ||
    row.transaction.importId === row.import.id
  ) {
    throw new Error('Este vínculo não é válido para a fatura em revisão.')
  }
  await assertImportActionable(row.import, 'link_statement_observation')
  const [stagedObservations, ledgerTransactions] = await Promise.all([
    db
      .select({ externalId: schema.stagedTransactions.externalId })
      .from(schema.stagedTransactions)
      .where(eq(schema.stagedTransactions.importId, row.import.id)),
    db
      .select({
        id: schema.transactions.id,
        externalId: schema.transactions.externalId,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.creditCardId, row.import.creditCardId)),
  ])
  if (
    !statementLinkIsCompatible(
      row.staged,
      row.transaction,
      stagedObservations,
      ledgerTransactions,
    )
  ) {
    throw new Error(
      row.staged.externalId
        ? 'Não é possível vincular lançamentos com identificadores externos diferentes.'
        : 'Este lançamento está reservado para outra linha desta fatura.',
    )
  }
  if (row.transaction.currency !== row.staged.currency) {
    throw new Error('Vincule apenas lançamentos na mesma moeda.')
  }
  if (
    !row.import.periodStart ||
    !row.import.periodEnd ||
    row.transaction.postedAt < row.import.periodStart ||
    row.transaction.postedAt > row.import.periodEnd
  ) {
    throw new Error(
      'O lançamento escolhido está fora do período confirmado da fatura.',
    )
  }
  const reservations = await db
    .select({
      correction: schema.transactionCorrections,
      staged: schema.stagedTransactions,
    })
    .from(schema.transactionCorrections)
    .innerJoin(
      schema.stagedTransactions,
      eq(
        schema.stagedTransactions.id,
        schema.transactionCorrections.stagedTransactionId,
      ),
    )
    .where(eq(schema.transactionCorrections.transactionId, row.transaction.id))
  const evidenceReservations = await db
    .select({ staged: schema.stagedTransactions })
    .from(schema.transactionEvidence)
    .innerJoin(
      schema.stagedTransactions,
      eq(
        schema.stagedTransactions.id,
        schema.transactionEvidence.stagedTransactionId,
      ),
    )
    .where(eq(schema.transactionEvidence.transactionId, row.transaction.id))
  if (
    reservations.some(
      (reservation) =>
        reservation.staged.importId === row.import.id &&
        reservation.staged.id !== row.staged.id &&
        reservation.correction.status !== 'rejected',
    ) ||
    evidenceReservations.some(
      (reservation) =>
        reservation.staged.importId === row.import.id &&
        reservation.staged.id !== row.staged.id,
    )
  ) {
    throw new Error(
      'Este lançamento já foi vinculado a outra linha desta fatura.',
    )
  }
  const existing = await db
    .select()
    .from(schema.transactionCorrections)
    .where(
      eq(
        schema.transactionCorrections.stagedTransactionId,
        input.stagedTransactionId,
      ),
    )
    .limit(1)
  if (existing[0]?.status === 'accepted') return { success: true }

  const correctionId = existing[0]?.id ?? randomUUID()
  const values = {
    transactionId: row.transaction.id,
    previousJson: JSON.stringify({
      postedAt: row.transaction.postedAt,
      description: row.transaction.description,
      amountCents: row.transaction.amountCents,
      currency: row.transaction.currency,
      fingerprint: row.transaction.fingerprint,
    }),
    proposedJson: JSON.stringify({
      postedAt: row.staged.postedAt,
      description: row.staged.description,
      amountCents: row.staged.amountCents,
      currency: row.staged.currency,
      fingerprint: row.staged.fingerprint,
    }),
    status: 'pending' as const,
    resolvedAt: null,
  }
  await resolveTransactionCorrectionInternal(
    { correctionId, action: 'accept' },
    {
      row,
      existing: existing[0] ?? null,
      values,
    },
  )
  return { success: true }
}

interface LinkedStatementCorrection {
  row: {
    staged: typeof schema.stagedTransactions.$inferSelect
    import: typeof schema.imports.$inferSelect
    transaction: typeof schema.transactions.$inferSelect
  }
  existing: typeof schema.transactionCorrections.$inferSelect | null
  values: {
    transactionId: string
    previousJson: string
    proposedJson: string
    status: 'pending'
    resolvedAt: null
  }
}

async function resolveTransactionCorrectionInternal(
  input: {
    correctionId: string
    action: 'accept' | 'reject'
  },
  linkedCorrection?: LinkedStatementCorrection,
) {
  await ensureDatabase()
  const rows = linkedCorrection
    ? []
    : await db
        .select({
          correction: schema.transactionCorrections,
          staged: schema.stagedTransactions,
          transaction: schema.transactions,
          import: schema.imports,
        })
        .from(schema.transactionCorrections)
        .innerJoin(
          schema.stagedTransactions,
          eq(
            schema.stagedTransactions.id,
            schema.transactionCorrections.stagedTransactionId,
          ),
        )
        .innerJoin(
          schema.transactions,
          eq(
            schema.transactions.id,
            schema.transactionCorrections.transactionId,
          ),
        )
        .innerJoin(
          schema.imports,
          eq(schema.imports.id, schema.stagedTransactions.importId),
        )
        .where(eq(schema.transactionCorrections.id, input.correctionId))
        .limit(1)
  const persistedRow = rows.at(0)
  const row = linkedCorrection?.row ?? persistedRow
  const correctionStatus = linkedCorrection
    ? (linkedCorrection.existing?.status ?? 'pending')
    : persistedRow?.correction.status
  if (!row || !correctionStatus) throw new Error('Correção não encontrada.')
  if (correctionStatus !== 'pending' && !linkedCorrection) {
    return { success: true }
  }
  if (input.action === 'accept' && !linkedCorrection) {
    await assertImportActionable(row.import, 'resolve_transaction_correction')
  }

  const restoresExcludedSameIdentity = Boolean(
    input.action === 'accept' &&
    row.transaction.status === 'excluded' &&
    row.staged.externalId &&
    row.staged.externalId === row.transaction.externalId,
  )
  if (
    input.action === 'accept' &&
    row.transaction.status === 'excluded' &&
    !restoresExcludedSameIdentity
  ) {
    throw new Error(
      'Uma transação excluída só pode ser restaurada pelo mesmo ID.',
    )
  }

  const affectedFrom =
    row.staged.postedAt < row.transaction.postedAt
      ? row.staged.postedAt
      : row.transaction.postedAt
  const cachedRates =
    input.action === 'accept' && row.staged.currency !== 'BRL'
      ? await db
          .select({ rateMicros: schema.exchangeRates.rateMicros })
          .from(schema.exchangeRates)
          .where(
            and(
              eq(schema.exchangeRates.date, row.staged.postedAt.slice(0, 10)),
              eq(schema.exchangeRates.fromCurrency, row.staged.currency),
              eq(schema.exchangeRates.toCurrency, 'BRL'),
            ),
          )
          .limit(1)
      : []
  const exchangeRateMicros =
    row.staged.currency === 'BRL'
      ? 1_000_000
      : (cachedRates[0]?.rateMicros ?? null)
  const baseAmountCents = exchangeRateMicros
    ? convertMinorUnitsAtRate(
        row.staged.amountCents,
        row.staged.currency,
        'BRL',
        exchangeRateMicros,
      )
    : null
  const affectedGroups = await db
    .select({ groupId: schema.reconciliationLinks.groupId })
    .from(schema.reconciliationLinks)
    .where(eq(schema.reconciliationLinks.transactionId, row.transaction.id))
  const linkedGroups = affectedGroups.length
    ? await db
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
        .where(
          inArray(
            schema.reconciliationLinks.groupId,
            affectedGroups.map((item) => item.groupId),
          ),
        )
    : []

  db.transaction((transaction) => {
    if (linkedCorrection) {
      if (linkedCorrection.existing) {
        transaction
          .update(schema.transactionCorrections)
          .set(linkedCorrection.values)
          .where(eq(schema.transactionCorrections.id, input.correctionId))
          .run()
      } else {
        transaction
          .insert(schema.transactionCorrections)
          .values({
            id: input.correctionId,
            stagedTransactionId: row.staged.id,
            ...linkedCorrection.values,
          })
          .run()
      }
    }

    if (input.action === 'accept') {
      if (restoresExcludedSameIdentity) {
        reopenRestoredExclusionOwners(transaction, {
          transactionIds: [row.transaction.id],
          exclusionReasonSuffix:
            'Reaberta porque uma importação posterior comprovou a movimentação.',
          validationMessage:
            'Uma movimentação antes marcada como autorização ausente apareceu em uma importação posterior. O fechamento e os saldos seguintes foram reabertos para conferência.',
        })
      }
      transaction
        .update(schema.transactions)
        .set({
          externalId: row.staged.externalId ?? row.transaction.externalId,
          fingerprint: row.staged.fingerprint,
          postedAt: row.staged.postedAt,
          description: row.staged.description,
          normalizedDescription: row.staged.normalizedDescription,
          amountCents: row.staged.amountCents,
          currency: row.staged.currency,
          baseAmountCents,
          exchangeRateMicros,
          ...(restoresExcludedSameIdentity
            ? { status: 'pending' as const }
            : {}),
        })
        .where(eq(schema.transactions.id, row.transaction.id))
        .run()
      if (linkedGroups.length) {
        for (const link of linkedGroups) {
          if (link.status !== 'confirmed') continue
          transaction
            .update(schema.transactions)
            .set({ categoryId: link.previousCategoryId })
            .where(eq(schema.transactions.id, link.transactionId))
            .run()
        }
        transaction
          .update(schema.reconciliationGroups)
          .set({
            status: 'suggested',
            aiValidation: null,
            aiConfidence: null,
            aiReason: null,
            aiValidatedAt: null,
            reason: 'Reaberta porque uma movimentação vinculada foi corrigida.',
          })
          .where(
            inArray(
              schema.reconciliationGroups.id,
              linkedGroups.map((item) => item.groupId),
            ),
          )
          .run()
      }
      if (row.transaction.creditCardId) {
        transaction
          .update(schema.cardStatementCycles)
          .set({ status: 'closed' })
          .where(
            and(
              eq(
                schema.cardStatementCycles.creditCardId,
                row.transaction.creditCardId,
              ),
              gte(schema.cardStatementCycles.periodEnd, affectedFrom),
            ),
          )
          .run()
      }
      invalidateCheckpointChain(transaction, {
        targetType: row.transaction.accountId ? 'account' : 'card',
        targetId: row.transaction.accountId ?? row.transaction.creditCardId!,
        from: affectedFrom,
        reason:
          'Uma correção aceita alterou uma movimentação anterior a este ponto de controle.',
      })
      refreshStatementAnchor(transaction, {
        targetType: row.transaction.accountId ? 'account' : 'card',
        targetId: row.transaction.accountId ?? row.transaction.creditCardId!,
        balanceType: row.transaction.accountId ? 'posted' : 'card_statement',
      })
      transaction
        .update(schema.imports)
        .set(
          nextValidationState({
            current: row.import,
            evaluated: {
              validationStatus: 'imported',
              validationReason: 'ready',
              validationMessage:
                'Correção aplicada e checkpoints posteriores reabertos para conferência.',
            },
          }),
        )
        .where(eq(schema.imports.id, row.staged.importId))
        .run()
      applyCanonicalEvidenceLink(transaction, {
        stagedTransactionId: row.staged.id,
        transactionId: row.transaction.id,
        matchKind: 'manual_correction',
      })
    } else {
      transaction
        .update(schema.imports)
        .set({
          status: 'review',
          ...nextValidationState({
            current: row.import,
            evaluated: {
              validationStatus: 'imported',
              validationReason: 'ready',
              validationMessage:
                'A correção proposta foi rejeitada. O lançamento original foi preservado e a nova observação ficou na auditoria.',
            },
          }),
        })
        .where(eq(schema.imports.id, row.staged.importId))
        .run()
      applyCanonicalEvidenceLink(transaction, {
        stagedTransactionId: row.staged.id,
        transactionId: row.transaction.id,
        matchKind: 'rejected_correction',
      })
    }
    transaction
      .update(schema.transactionCorrections)
      .set({
        status: input.action === 'accept' ? 'accepted' : 'rejected',
        resolvedAt: new Date(),
      })
      .where(eq(schema.transactionCorrections.id, input.correctionId))
      .run()
  })
  if (input.action === 'accept') {
    await refreshStatementResolutionState(row.staged.importId)
  }
  return { success: true }
}

export async function resolveTransactionCorrection(input: {
  correctionId: string
  action: 'accept' | 'reject'
}) {
  return resolveTransactionCorrectionInternal(input)
}
