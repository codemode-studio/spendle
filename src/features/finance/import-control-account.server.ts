import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'

import { db } from '#/db/index.server'
import * as schema from '#/db/schema'
import { classifyCheckpointAtDate } from '#/domain/balance-checkpoint'
import {
  matchOptionalStatementValues,
  matchStatementValueSubset,
} from '#/domain/canonicalization'
import { convertMinorUnitsAtRate } from '#/domain/currency'
import { evaluateImportAudit, nextValidationState } from '#/domain/import-audit'
import { applyAccountPdfOutcome } from './import-control-account-apply.server'
import { fetchPtax } from './currency.server'

export async function reconcileAccountPdfControls(input: {
  targetId: string
  controls: Array<typeof schema.imports.$inferSelect>
  stagedByImport: Map<
    string,
    Array<typeof schema.stagedTransactions.$inferSelect>
  >
  finalize?: boolean
}) {
  const remainingPdfControls = input.controls
  const stagedByImport = input.stagedByImport
  const loadTargetCheckpoints = () =>
    db
      .select()
      .from(schema.balanceCheckpoints)
      .where(eq(schema.balanceCheckpoints.accountId, input.targetId))
  const [priorTransactions, accountRows] = await Promise.all([
    db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, input.targetId)),
    db
      .select({
        balanceCents: schema.accounts.statementBalanceCents,
        balanceAt: schema.accounts.statementBalanceAt,
        coverageStart: schema.accounts.coverageStart,
      })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, input.targetId))
      .limit(1),
  ])
  const account = accountRows.at(0)
  for (const pdfControl of remainingPdfControls) {
    const checkpointAtDate = classifyCheckpointAtDate(
      await loadTargetCheckpoints(),
      {
        balanceType: 'posted',
        balanceCents: pdfControl.closingBalanceCents!,
        asOf: pdfControl.balanceAsOf!,
      },
    )
    if (checkpointAtDate.status === 'conflict') {
      await db
        .update(schema.imports)
        .set(
          nextValidationState({
            current: pdfControl,
            evaluated: {
              validationStatus: 'divergent',
              validationReason: 'balance_mismatch',
              validationMessage:
                'Já existe outro saldo contábil ativo para esta conta na mesma data. Invalide o ponto anterior antes de consolidar este extrato.',
            },
          }),
        )
        .where(eq(schema.imports.id, pdfControl.id))
      continue
    }
    const pdfStaged = stagedByImport.get(pdfControl.id) ?? []
    const canonicalInPeriod = priorTransactions.filter(
      (transaction) =>
        transaction.status !== 'excluded' &&
        transaction.postedAt >= pdfControl.periodStart! &&
        transaction.postedAt <= pdfControl.periodEnd!,
    )
    const excludedInPeriod = priorTransactions.filter(
      (transaction) =>
        transaction.status === 'excluded' &&
        transaction.postedAt >= pdfControl.periodStart! &&
        transaction.postedAt <= pdfControl.periodEnd!,
    )
    if (!canonicalInPeriod.length && !excludedInPeriod.length) continue
    let resolution = canonicalInPeriod.length
      ? matchStatementValueSubset(pdfStaged, canonicalInPeriod)
      : { matches: [], unmatched: pdfStaged }
    if (resolution) {
      const restored = matchOptionalStatementValues(
        resolution.unmatched,
        excludedInPeriod,
      )
      resolution = restored.changed.length
        ? null
        : {
            matches: [...resolution.matches, ...restored.matches],
            unmatched: restored.unmatched,
          }
    }
    const existingMovementCents = account?.balanceAt
      ? priorTransactions
          .filter(
            (transaction) =>
              transaction.status === 'confirmed' &&
              transaction.postedAt > account.balanceAt! &&
              transaction.postedAt <= pdfControl.balanceAsOf!,
          )
          .reduce((total, transaction) => total + transaction.amountCents, 0)
      : 0
    const audit = evaluateImportAudit({
      targetType: 'account',
      sourceTransactionCount: pdfControl.sourceTransactionCount,
      parsedTransactionCount: pdfControl.parsedTransactionCount,
      invalidTransactionCount: pdfControl.invalidTransactionCount,
      openingBalanceCents: pdfControl.openingBalanceCents,
      openingBalanceAt: pdfControl.openingBalanceAt,
      closingBalanceCents: pdfControl.closingBalanceCents,
      balanceAsOf: pdfControl.balanceAsOf,
      statementPeriodStart: pdfControl.periodStart,
      anchorBalanceCents: account?.balanceCents ?? null,
      anchorBalanceAt: account?.balanceAt ?? null,
      existingMovementCents,
      newMovementCents:
        pdfControl.openingBalanceCents !== null
          ? pdfStaged.reduce(
              (total, transaction) => total + transaction.amountCents,
              0,
            )
          : resolution
            ? [
                ...resolution.unmatched,
                ...resolution.matches.flatMap(({ observation, transaction }) =>
                  transaction.status === 'excluded' ? [observation] : [],
                ),
              ].reduce(
                (total, transaction) => total + transaction.amountCents,
                0,
              )
            : 0,
      documentMovementCents: pdfStaged.reduce(
        (total, transaction) => total + transaction.amountCents,
        0,
      ),
    })
    if (!resolution || audit.status === 'divergent') {
      await db
        .update(schema.imports)
        .set(
          nextValidationState({
            current: pdfControl,
            evaluated: {
              validationStatus: 'divergent',
              validationReason: resolution ? audit.reasonCode : 'blocked',
              validationMessage: resolution
                ? audit.message
                : 'Já existem lançamentos desta conta no período, mas o PDF não corresponde exatamente a eles em data, valor e moeda. A importação foi bloqueada para evitar duplicidades.',
            },
          }),
        )
        .where(eq(schema.imports.id, pdfControl.id))
      continue
    }

    const assignments = resolution.matches
    if (resolution.unmatched.length && !input.finalize) {
      db.transaction((transaction) => {
        for (const { observation } of assignments) {
          transaction
            .update(schema.stagedTransactions)
            .set({ duplicate: true, duplicateReason: null })
            .where(eq(schema.stagedTransactions.id, observation.id))
            .run()
        }
        for (const observation of resolution.unmatched) {
          transaction
            .update(schema.stagedTransactions)
            .set({ duplicate: false, duplicateReason: null })
            .where(eq(schema.stagedTransactions.id, observation.id))
            .run()
        }
        transaction
          .update(schema.imports)
          .set({
            ...nextValidationState({
              current: pdfControl,
              evaluated: {
                validationStatus: audit.status,
                validationReason: audit.reasonCode,
                validationMessage: `PDF conferido: ${assignments.length} lançamento(s) já existente(s) foram reconhecidos. Revise os ${resolution.unmatched.length} lançamento(s) novos antes de consolidar.`,
              },
            }),
            expectedBalanceCents: audit.expectedBalanceCents,
            balanceDifferenceCents: audit.balanceDifferenceCents,
            warning:
              'As linhas já importadas não serão duplicadas. Somente os lançamentos novos do PDF entrarão ao consolidar.',
          })
          .where(eq(schema.imports.id, pdfControl.id))
          .run()
      })
      continue
    }

    const createdFromPdf = await Promise.all(
      resolution.unmatched.map(async (observation) => {
        let baseAmountCents: number | null = observation.amountCents
        let exchangeRateMicros: number | null = 1_000_000
        if (observation.currency === 'USD') {
          exchangeRateMicros = await fetchPtax(
            observation.postedAt.slice(0, 10),
          )
          baseAmountCents = exchangeRateMicros
            ? convertMinorUnitsAtRate(
                observation.amountCents,
                observation.currency,
                'BRL',
                exchangeRateMicros,
              )
            : null
        } else if (observation.currency !== 'BRL') {
          baseAmountCents = null
          exchangeRateMicros = null
        }
        return {
          observation,
          transaction: {
            id: randomUUID(),
            importId: pdfControl.id,
            accountId: input.targetId,
            categoryId: observation.suggestedCategoryId,
            counterpartyAccountId: observation.counterpartyAccountId,
            externalId: observation.externalId,
            sourceKey: `account:${input.targetId}:statement:${pdfControl.id}:${observation.id}`,
            fingerprint: observation.fingerprint,
            postedAt: observation.postedAt,
            description: observation.description,
            normalizedDescription: observation.normalizedDescription,
            amountCents: observation.amountCents,
            currency: observation.currency,
            baseAmountCents,
            exchangeRateMicros,
            status: 'confirmed' as const,
          },
        }
      }),
    )
    const restoredAssignments = assignments.filter(
      ({ transaction: matched }) => matched.status === 'excluded',
    )
    applyAccountPdfOutcome({
      targetId: input.targetId,
      pdfControl,
      assignments,
      createdFromPdf,
      restoredAssignments,
      checkpointAtDate,
      audit,
      account,
    })
  }
}
