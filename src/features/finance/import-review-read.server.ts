import { desc } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import {
  findTransactionsAbsentFromStatement,
  matchOptionalStatementValues,
  statementLinkIsCompatible,
  statementValueSignature,
} from '#/domain/canonicalization'
import {
  classifyImportReviewGuidance,
  effectiveValidationReason,
  getImportBalanceReview,
  getImportCoverageProvenance,
  isHardImportReviewReason,
  resolveImportReviewReason,
} from '#/domain/import-audit'
import { hasImportDestinationConflict } from './import-guards.server'
import { effectiveImportReviewValidationMessage } from './import-review-guidance'

function previousDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

export async function getImportReviewSnapshot() {
  await ensureDatabase()
  const [
    accounts,
    cards,
    cardInstruments,
    categories,
    institutions,
    importRows,
    sourceFiles,
    stagedRows,
    transactionRows,
    correctionRows,
    statementExclusionRows,
    checkpointRows,
  ] = await Promise.all([
    db.select().from(schema.accounts).orderBy(schema.accounts.name),
    db.select().from(schema.creditCards).orderBy(schema.creditCards.name),
    db.select().from(schema.creditCardInstruments),
    db.select().from(schema.categories).orderBy(schema.categories.name),
    db.select().from(schema.institutions),
    db.select().from(schema.imports).orderBy(desc(schema.imports.createdAt)),
    db.select().from(schema.sourceFiles),
    db
      .select()
      .from(schema.stagedTransactions)
      .orderBy(schema.stagedTransactions.postedAt),
    db
      .select()
      .from(schema.transactions)
      .orderBy(desc(schema.transactions.postedAt)),
    db
      .select()
      .from(schema.transactionCorrections)
      .orderBy(desc(schema.transactionCorrections.createdAt)),
    db
      .select()
      .from(schema.statementExclusions)
      .orderBy(desc(schema.statementExclusions.createdAt)),
    db
      .select()
      .from(schema.balanceCheckpoints)
      .orderBy(desc(schema.balanceCheckpoints.asOf)),
  ])
  const sourceFileById = new Map(sourceFiles.map((item) => [item.id, item]))
  const accountById = new Map(accounts.map((item) => [item.id, item]))
  const cardById = new Map(cards.map((item) => [item.id, item]))
  const institutionById = new Map(institutions.map((item) => [item.id, item]))

  const statementMissingCandidates = (
    importRow: (typeof importRows)[number],
  ) => {
    if (
      importRow.parser !== 'pdf_inspector' ||
      !importRow.creditCardId ||
      importRow.status !== 'review' ||
      !importRow.periodStart ||
      !importRow.periodEnd
    ) {
      return []
    }
    const staged = stagedRows.filter((item) => item.importId === importRow.id)
    const pending = transactionRows
      .filter(
        (item) =>
          item.creditCardId === importRow.creditCardId &&
          item.status === 'pending' &&
          item.postedAt >= importRow.periodStart! &&
          item.postedAt <= importRow.periodEnd!,
      )
      .sort((left, right) => left.id.localeCompare(right.id))
    const unmatchedTransactions = findTransactionsAbsentFromStatement(
      staged,
      pending,
    )

    return unmatchedTransactions.map((transaction) => ({
      id: transaction.id,
      postedAt: transaction.postedAt,
      description: transaction.description,
      amountCents: transaction.amountCents,
      currency: transaction.currency,
    }))
  }

  const statementReviewRows = (
    importRow: (typeof importRows)[number],
    staged: typeof stagedRows,
  ) => {
    if (
      importRow.parser !== 'pdf_inspector' ||
      !importRow.creditCardId ||
      importRow.status !== 'review' ||
      importRow.validationStatus !== 'divergent'
    ) {
      return { differenceRows: [], blockedRows: [] }
    }

    const eligibleTransactions = transactionRows.filter(
      (transaction) =>
        transaction.creditCardId === importRow.creditCardId &&
        transaction.importId !== importRow.id &&
        (!importRow.periodStart ||
          transaction.postedAt >= importRow.periodStart) &&
        (!importRow.periodEnd || transaction.postedAt <= importRow.periodEnd),
    )
    const { changed, unmatched, unmatchedTransactions } =
      matchOptionalStatementValues(staged, eligibleTransactions)

    const candidateFor = (transaction: (typeof transactionRows)[number]) => ({
      id: transaction.id,
      postedAt: transaction.postedAt,
      description: transaction.description,
      amountCents: transaction.amountCents,
      currency: transaction.currency,
      status: transaction.status,
    })
    const isReservedForAnotherObservation = (
      transaction: (typeof transactionRows)[number],
      observation: (typeof stagedRows)[number],
    ) =>
      correctionRows.some(
        (correction) =>
          correction.transactionId === transaction.id &&
          correction.status !== 'rejected' &&
          staged.some(
            (reservedStaged) =>
              reservedStaged.id === correction.stagedTransactionId &&
              reservedStaged.id !== observation.id,
          ),
      )

    // Only offer changed pairs the link action can accept: same currency.
    const changedRows = changed.flatMap(({ observation, transaction }) =>
      isReservedForAnotherObservation(transaction, observation) ||
      transaction.currency !== observation.currency
        ? []
        : [
            {
              observation: {
                id: observation.id,
                postedAt: observation.postedAt,
                description: observation.description,
                amountCents: observation.amountCents,
                currency: observation.currency,
              },
              candidates: [candidateFor(transaction)],
            },
          ],
    )
    const blockedRows = changed.flatMap(({ observation, transaction }) =>
      transaction.currency === observation.currency
        ? []
        : [
            {
              reason: 'currency_mismatch' as const,
              linkable: false as const,
              observation: {
                id: observation.id,
                postedAt: observation.postedAt,
                description: observation.description,
                amountCents: observation.amountCents,
                currency: observation.currency,
              },
              transaction: candidateFor(transaction),
            },
          ],
    )

    const changedObservationIds = new Set(
      changed.map(({ observation }) => observation.id),
    )

    const unmatchedRows = unmatched.flatMap((observation) => {
      if (changedObservationIds.has(observation.id)) return []
      const observationSignature = statementValueSignature(observation)
      const candidates = unmatchedTransactions
        .filter(
          (transaction) =>
            // Excluded transactions are linkable only through the same-id
            // restoration path, which the `changed` pass already handles.
            transaction.status !== 'excluded' &&
            transaction.currency === observation.currency &&
            statementLinkIsCompatible(
              observation,
              transaction,
              staged,
              eligibleTransactions,
            ) &&
            statementValueSignature(transaction) !== observationSignature &&
            !isReservedForAnotherObservation(transaction, observation),
        )
        .sort((left, right) => {
          const leftSameId =
            observation.externalId && left.externalId === observation.externalId
              ? 0
              : 1
          const rightSameId =
            observation.externalId &&
            right.externalId === observation.externalId
              ? 0
              : 1
          const leftExact = left.amountCents === observation.amountCents ? 0 : 1
          const rightExact =
            right.amountCents === observation.amountCents ? 0 : 1
          return (
            leftSameId - rightSameId ||
            leftExact - rightExact ||
            left.postedAt.localeCompare(right.postedAt)
          )
        })
        .map(candidateFor)

      return candidates.length
        ? [
            {
              observation: {
                id: observation.id,
                postedAt: observation.postedAt,
                description: observation.description,
                amountCents: observation.amountCents,
                currency: observation.currency,
              },
              candidates,
            },
          ]
        : []
    })

    return {
      differenceRows: [...changedRows, ...unmatchedRows],
      blockedRows,
    }
  }

  return {
    accounts,
    cards,
    categories,
    imports: importRows.map((importRow) => {
      const staged = stagedRows.filter((item) => item.importId === importRow.id)
      const corrections = correctionRows.filter((correction) =>
        staged.some((item) => item.id === correction.stagedTransactionId),
      )
      const targetAccount = importRow.accountId
        ? accountById.get(importRow.accountId)
        : null
      const targetCard = importRow.creditCardId
        ? cardById.get(importRow.creditCardId)
        : null
      const target = targetAccount ?? targetCard ?? null
      const targetInstitution = target?.institutionId
        ? institutionById.get(target.institutionId)
        : null
      const targetIdentifiers = targetAccount
        ? [targetAccount.externalId]
        : targetCard
          ? [
              targetCard.lastFour,
              ...cardInstruments
                .filter((item) => item.creditCardId === targetCard.id)
                .map((item) => item.lastFour),
            ]
          : []
      const hasDestinationConflict = hasImportDestinationConflict(importRow, {
        targetIdentifiers,
        targetInstitutionName: targetInstitution?.name ?? null,
      })
      const effectiveReasonCode = effectiveValidationReason({
        ...importRow,
        hasDestinationConflict,
      })
      const effectiveValidationMessage = effectiveImportReviewValidationMessage(
        {
          persistedReason: importRow.validationReason,
          effectiveReason: effectiveReasonCode,
          persistedMessage: importRow.validationMessage,
        },
      )
      const hasEffectiveDestinationConflict =
        effectiveReasonCode === 'identical_file' ||
        effectiveReasonCode === 'destination_conflict'
      const effectiveValidationStatus = hasEffectiveDestinationConflict
        ? ('divergent' as const)
        : importRow.validationStatus
      const remediationAvailable =
        !isHardImportReviewReason(effectiveReasonCode)
      const statementRows = remediationAvailable
        ? statementReviewRows(importRow, staged)
        : { differenceRows: [], blockedRows: [] }
      const differenceRows = statementRows.differenceRows
      const blockedRows = statementRows.blockedRows
      const missingStatementTransactions = remediationAvailable
        ? statementMissingCandidates(importRow)
        : []
      const conflictReasonCode = hasEffectiveDestinationConflict
        ? effectiveReasonCode
        : null
      const duplicateCount = staged.filter((item) => item.duplicate).length
      const coverageProvenance = getImportCoverageProvenance({
        source: importRow.periodSource,
        periodStart: importRow.periodStart,
        periodEnd: importRow.periodEnd,
      })
      const targetType = importRow.accountId
        ? ('account' as const)
        : ('card' as const)
      const conflictingCheckpoint =
        !remediationAvailable || importRow.status !== 'review'
          ? null
          : (checkpointRows.find(
              (checkpoint) =>
                checkpoint.reviewState !== 'invalidated' &&
                importRow.closingBalanceCents !== null &&
                importRow.balanceAsOf === checkpoint.asOf &&
                checkpoint.balanceCents !== importRow.closingBalanceCents &&
                checkpoint.balanceType ===
                  (importRow.creditCardId
                    ? 'card_statement'
                    : importRow.closingBalanceType === 'available'
                      ? 'available'
                      : 'posted') &&
                (importRow.accountId
                  ? checkpoint.accountId === importRow.accountId
                  : checkpoint.creditCardId === importRow.creditCardId),
            ) ??
            (importRow.accountId &&
            importRow.openingBalanceCents !== null &&
            importRow.openingBalanceAt
              ? (checkpointRows.find(
                  (checkpoint) =>
                    checkpoint.accountId === importRow.accountId &&
                    checkpoint.reviewState !== 'invalidated' &&
                    checkpoint.balanceType === 'posted' &&
                    checkpoint.asOf === importRow.openingBalanceAt &&
                    checkpoint.balanceCents !== importRow.openingBalanceCents,
                ) ??
                checkpointRows.find(
                  (checkpoint) =>
                    checkpoint.accountId === importRow.accountId &&
                    checkpoint.reviewState !== 'invalidated' &&
                    checkpoint.balanceType === 'posted' &&
                    checkpoint.asOf ===
                      previousDate(importRow.openingBalanceAt!) &&
                    checkpoint.balanceCents !== importRow.openingBalanceCents,
                ) ??
                null)
              : null))
      const guidanceInput = {
        targetType,
        parser: importRow.parser,
        validationStatus: effectiveValidationStatus,
        validationMessage: effectiveValidationMessage,
        parsedTransactionCount: importRow.parsedTransactionCount,
        sourceTransactionCount: importRow.sourceTransactionCount,
        closingBalanceCents: importRow.closingBalanceCents,
        balanceDifferenceCents: importRow.balanceDifferenceCents,
        invalidTransactionCount: importRow.invalidTransactionCount,
        conflictReasonCode,
        hasPendingCorrection: corrections.some(
          (correction) => correction.status === 'pending',
        ),
        hasStatementMatchCandidates: differenceRows.length > 0,
        hasStatementCurrencyMismatch: blockedRows.length > 0,
        hasMissingStatementTransactions:
          missingStatementTransactions.length > 0,
        hasBalanceConflict: Boolean(conflictingCheckpoint),
      }
      const derivedReason = classifyImportReviewGuidance({
        ...guidanceInput,
        reasonCode: null,
      }).kind
      const reasonCode = resolveImportReviewReason({
        stored: effectiveReasonCode,
        derived: derivedReason,
      })
      const guidance = classifyImportReviewGuidance({
        ...guidanceInput,
        reasonCode,
      })

      return {
        ...importRow,
        validationStatus: effectiveValidationStatus,
        validationReason: effectiveReasonCode,
        validationMessage: effectiveValidationMessage,
        sourceFile: sourceFileById.get(importRow.sourceFileId) ?? null,
        target,
        staged,
        corrections,
        reasonCode,
        guidance,
        needsCoverageConfirmation: !coverageProvenance.reliable,
        hasIncompleteTransfer: staged.some(
          (item) =>
            !item.duplicate &&
            item.suggestedCategoryId === 'transfer' &&
            !item.counterpartyAccountId,
        ),
        coverageProvenance,
        balanceReview: getImportBalanceReview({
          targetType,
          closingBalanceCents: importRow.closingBalanceCents,
          balanceDifferenceCents: importRow.balanceDifferenceCents,
        }),
        duplicateCount,
        newCount: staged.length - duplicateCount,
        statementDifferenceRows: differenceRows,
        statementBlockedRows: blockedRows,
        statementMissingCandidates: missingStatementTransactions,
        statementExclusions: statementExclusionRows
          .filter((exclusion) => exclusion.importId === importRow.id)
          .map((exclusion) => ({
            ...exclusion,
            transaction:
              transactionRows.find(
                (transaction) => transaction.id === exclusion.transactionId,
              ) ?? null,
          })),
        conflictingCheckpoint,
      }
    }),
  }
}
