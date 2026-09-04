import { randomUUID } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'

import { db } from '#/db/index.server'
import * as schema from '#/db/schema'
import { classifyCheckpointAtDate } from '#/domain/balance-checkpoint'
import {
  matchOptionalStatementValues,
  matchStatementValueSubset,
} from '#/domain/canonicalization'
import { convertMinorUnitsAtRate } from '#/domain/currency'
import { evaluateImportAudit, nextValidationState } from '#/domain/import-audit'
import { fetchPtax } from './currency.server'
import { loadEffectiveImportValidationStates } from './import-guards.server'
import { reconcileSameBatchControls } from './import-control-batch.server'
import { reconcileAccountPdfControls } from './import-control-account.server'
import { applyCardPdfOutcome } from './import-control-card-apply.server'

interface ReconcileInput {
  importIds: string[]
  targetType: 'account' | 'card'
  targetId: string
  finalize?: boolean
}

export async function reconcileCsvWithPdfControl(input: ReconcileInput) {
  if (!input.importIds.length) return
  const [importRows, stagedRows] = await Promise.all([
    db
      .select()
      .from(schema.imports)
      .where(inArray(schema.imports.id, input.importIds)),
    db
      .select()
      .from(schema.stagedTransactions)
      .where(inArray(schema.stagedTransactions.importId, input.importIds)),
  ])
  const stagedByImport = new Map<string, typeof stagedRows>()
  for (const row of stagedRows) {
    const current = stagedByImport.get(row.importId) ?? []
    current.push(row)
    stagedByImport.set(row.importId, current)
  }
  const validationStates = await loadEffectiveImportValidationStates(
    importRows,
    {
      targetType: input.targetType,
      targetId: input.targetId,
    },
  )
  const liveConflictIds = new Set(
    importRows.flatMap((item) =>
      validationStates.get(item.id)?.remediation.links ? [] : [item.id],
    ),
  )

  const pdfControls = importRows.filter(
    (item) =>
      !liveConflictIds.has(item.id) &&
      item.parser === 'pdf_inspector' &&
      item.status === 'review' &&
      item.validationStatus !== 'divergent' &&
      validationStates.get(item.id)?.remediation.links &&
      item.closingBalanceCents !== null &&
      item.closingBalanceType !== 'available' &&
      item.balanceAsOf !== null,
  )
  if (!pdfControls.length) return
  const matchedPdfIds = await reconcileSameBatchControls({
    importRows,
    stagedByImport,
    pdfControls,
    liveConflictIds,
    targetType: input.targetType,
    targetId: input.targetId,
  })

  const remainingPdfControls = pdfControls.filter(
    (item) =>
      !matchedPdfIds.has(item.id) &&
      item.periodStart &&
      item.periodEnd &&
      ['metadata', 'filename', 'user'].includes(item.periodSource),
  )
  if (!remainingPdfControls.length) return

  const loadTargetCheckpoints = () =>
    db
      .select()
      .from(schema.balanceCheckpoints)
      .where(
        input.targetType === 'account'
          ? eq(schema.balanceCheckpoints.accountId, input.targetId)
          : eq(schema.balanceCheckpoints.creditCardId, input.targetId),
      )

  if (input.targetType === 'account') {
    await reconcileAccountPdfControls({
      targetId: input.targetId,
      controls: remainingPdfControls,
      stagedByImport,
      finalize: input.finalize,
    })
    return
  }

  const [priorTransactions, existingCycles] = await Promise.all([
    db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.creditCardId, input.targetId)),
    db
      .select()
      .from(schema.cardStatementCycles)
      .where(eq(schema.cardStatementCycles.creditCardId, input.targetId)),
  ])

  for (const pdfControl of remainingPdfControls) {
    const checkpointAtDate = classifyCheckpointAtDate(
      await loadTargetCheckpoints(),
      {
        balanceType: 'card_statement',
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
                'Já existe outro total de fatura ativo para este cartão na mesma data. Invalide o ponto anterior antes de consolidar.',
            },
          }),
        )
        .where(eq(schema.imports.id, pdfControl.id))
      continue
    }
    const canonicalInPeriod = priorTransactions.filter(
      (transaction) =>
        transaction.status !== 'excluded' &&
        transaction.postedAt >= pdfControl.periodStart! &&
        transaction.postedAt <= pdfControl.periodEnd!,
    )
    const pdfStaged = stagedByImport.get(pdfControl.id) ?? []
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
    const unresolvedStatementValues = resolution
      ? null
      : matchOptionalStatementValues(pdfStaged, canonicalInPeriod)
    const unresolvedStatementReason = unresolvedStatementValues?.unmatched
      .length
      ? ('statement_match_candidates' as const)
      : unresolvedStatementValues?.unmatchedTransactions.some(
            (transaction) => transaction.status === 'pending',
          )
        ? ('missing_statement_transactions' as const)
        : ('statement_match_candidates' as const)
    const audit = evaluateImportAudit({
      targetType: 'card',
      sourceTransactionCount: pdfControl.sourceTransactionCount,
      parsedTransactionCount: pdfControl.parsedTransactionCount,
      invalidTransactionCount: pdfControl.invalidTransactionCount,
      openingBalanceCents: pdfControl.openingBalanceCents,
      openingBalanceAt: pdfControl.openingBalanceAt,
      closingBalanceCents: pdfControl.closingBalanceCents,
      balanceAsOf: pdfControl.balanceAsOf,
      statementPeriodStart: pdfControl.periodStart,
      anchorBalanceCents: null,
      anchorBalanceAt: null,
      existingMovementCents: 0,
      newMovementCents: pdfStaged.reduce(
        (total, item) => total + item.amountCents,
        0,
      ),
    })

    if (!resolution || audit.status !== 'reconciled') {
      await db
        .update(schema.imports)
        .set(
          nextValidationState({
            current: pdfControl,
            evaluated: {
              validationStatus: 'divergent',
              validationReason: resolution
                ? audit.reasonCode
                : unresolvedStatementReason,
              validationMessage:
                'Já existem lançamentos deste cartão no período, mas eles não correspondem exatamente ao PDF definitivo. Compare as diferenças, corrija o período ou rejeite esta importação; nada novo será consolidado enquanto houver ambiguidade.',
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
                validationStatus: 'reconciled',
                validationReason: audit.reasonCode,
                validationMessage: `Fatura conferida: ${assignments.length} lançamento(s) já importado(s) foram reconhecidos. Revise os ${resolution.unmatched.length} lançamento(s) novos antes de consolidar.`,
              },
            }),
            expectedBalanceCents: audit.expectedBalanceCents,
            balanceDifferenceCents: audit.balanceDifferenceCents,
            warning:
              'As compras novas do PDF ainda não entraram nos relatórios. Revise as categorias e clique em Consolidar.',
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
            creditCardId: input.targetId,
            categoryId: observation.suggestedCategoryId,
            counterpartyAccountId: observation.counterpartyAccountId,
            externalId: observation.externalId,
            sourceKey: `card:${input.targetId}:statement:${pdfControl.id}:${observation.id}`,
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
    const matchedImportIds = [
      ...new Set(
        assignments.flatMap(({ transaction }) =>
          transaction.importId ? [transaction.importId] : [],
        ),
      ),
    ]
    const obsoleteOpenCycles = existingCycles.filter(
      (cycle) =>
        cycle.status === 'open' &&
        cycle.importId &&
        matchedImportIds.includes(cycle.importId) &&
        (cycle.periodStart !== pdfControl.periodStart ||
          cycle.periodEnd !== pdfControl.periodEnd),
    )
    const confirmedPending = assignments.some(
      ({ transaction }) => transaction.status === 'pending',
    )
    applyCardPdfOutcome({
      targetId: input.targetId,
      pdfControl,
      assignments,
      createdFromPdf,
      matchedImportIds,
      obsoleteOpenCycles,
      confirmedPending,
      checkpointAtDate,
      audit,
    })
  }
}
