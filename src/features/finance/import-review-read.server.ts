import { desc } from 'drizzle-orm'

import { db, ensureDatabase } from '#/db/index.server'
import * as schema from '#/db/schema'
import { statementValueSignature } from '#/domain/canonicalization'

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
    categories,
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
    db.select().from(schema.categories).orderBy(schema.categories.name),
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
    const stagedCounts = new Map<string, number>()
    for (const staged of stagedRows.filter(
      (item) => item.importId === importRow.id,
    )) {
      const signature = statementValueSignature(staged)
      stagedCounts.set(signature, (stagedCounts.get(signature) ?? 0) + 1)
    }
    const missing: typeof transactionRows = []
    for (const transaction of transactionRows
      .filter(
        (item) =>
          item.creditCardId === importRow.creditCardId &&
          item.status === 'pending' &&
          item.postedAt >= importRow.periodStart! &&
          item.postedAt <= importRow.periodEnd!,
      )
      .sort((left, right) => left.id.localeCompare(right.id))) {
      const signature = statementValueSignature(transaction)
      const available = stagedCounts.get(signature) ?? 0
      if (available > 0) stagedCounts.set(signature, available - 1)
      else missing.push(transaction)
    }
    return missing.map((transaction) => ({
      id: transaction.id,
      postedAt: transaction.postedAt,
      description: transaction.description,
      amountCents: transaction.amountCents,
      currency: transaction.currency,
    }))
  }

  return {
    accounts,
    cards,
    categories,
    imports: importRows.map((importRow) => ({
      ...importRow,
      sourceFile: sourceFileById.get(importRow.sourceFileId) ?? null,
      target:
        (importRow.accountId
          ? accountById.get(importRow.accountId)
          : importRow.creditCardId
            ? cardById.get(importRow.creditCardId)
            : null) ?? null,
      staged: stagedRows.filter((staged) => staged.importId === importRow.id),
      corrections: correctionRows.filter((correction) =>
        stagedRows.some(
          (staged) =>
            staged.importId === importRow.id &&
            staged.id === correction.stagedTransactionId,
        ),
      ),
      statementMatchCandidates:
        importRow.parser === 'pdf_inspector' &&
        importRow.creditCardId &&
        importRow.status === 'review'
          ? stagedRows
              .filter((staged) => staged.importId === importRow.id)
              .map((staged) => ({
                stagedTransactionId: staged.id,
                candidates: transactionRows
                  .filter(
                    (transaction) =>
                      transaction.creditCardId === importRow.creditCardId &&
                      transaction.importId !== importRow.id &&
                      transaction.status !== 'excluded' &&
                      transaction.currency === staged.currency &&
                      !correctionRows.some(
                        (correction) =>
                          correction.transactionId === transaction.id &&
                          correction.status !== 'rejected' &&
                          stagedRows.some(
                            (reservedStaged) =>
                              reservedStaged.id ===
                                correction.stagedTransactionId &&
                              reservedStaged.importId === importRow.id &&
                              reservedStaged.id !== staged.id,
                          ),
                      ) &&
                      (!importRow.periodStart ||
                        transaction.postedAt >= importRow.periodStart) &&
                      (!importRow.periodEnd ||
                        transaction.postedAt <= importRow.periodEnd),
                  )
                  .sort((left, right) => {
                    const leftExact =
                      left.amountCents === staged.amountCents ? 0 : 1
                    const rightExact =
                      right.amountCents === staged.amountCents ? 0 : 1
                    return (
                      leftExact - rightExact ||
                      left.postedAt.localeCompare(right.postedAt)
                    )
                  })
                  .map((transaction) => ({
                    id: transaction.id,
                    postedAt: transaction.postedAt,
                    description: transaction.description,
                    amountCents: transaction.amountCents,
                    currency: transaction.currency,
                    status: transaction.status,
                  })),
              }))
          : [],
      statementMissingCandidates: statementMissingCandidates(importRow),
      statementExclusions: statementExclusionRows
        .filter((exclusion) => exclusion.importId === importRow.id)
        .map((exclusion) => ({
          ...exclusion,
          transaction:
            transactionRows.find(
              (transaction) => transaction.id === exclusion.transactionId,
            ) ?? null,
        })),
      conflictingCheckpoint:
        importRow.status !== 'review'
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
              : null)),
    })),
  }
}
