import { and, eq } from 'drizzle-orm'

import { db } from '#/db/index.server'
import * as schema from '#/db/schema'
import {
  matchStatementValueSubset,
  sameStatementValues,
} from '#/domain/canonicalization'
import {
  evaluateImportAudit,
  getEffectiveImportValidationState,
  nextValidationState,
} from '#/domain/import-audit'

const SAME_BATCH_PARTIAL_CSV_WARNING =
  'O PDF definitivo contém movimentações posteriores ao CSV e será a fonte canônica deste período.'
const SAME_BATCH_EXACT_PDF_WARNING =
  'Este PDF será preservado como evidência quando o arquivo estruturado equivalente for consolidado.'

export async function reconcileSameBatchControls(input: {
  importRows: Array<typeof schema.imports.$inferSelect>
  stagedByImport: Map<
    string,
    Array<typeof schema.stagedTransactions.$inferSelect>
  >
  pdfControls: Array<typeof schema.imports.$inferSelect>
  liveConflictIds: Set<string>
  targetType: 'account' | 'card'
  targetId: string
}) {
  const { importRows, stagedByImport, pdfControls, liveConflictIds } = input
  const matchedPdfIds = new Set<string>()
  const canonicalDependencyByImport = new Map(
    importRows.flatMap((item) =>
      item.dependsOnImportId
        ? [[item.id, item.dependsOnImportId] as const]
        : [],
    ),
  )

  const accountAnchor =
    input.targetType === 'account'
      ? await db
          .select({
            balanceCents: schema.accounts.statementBalanceCents,
            balanceAt: schema.accounts.statementBalanceAt,
          })
          .from(schema.accounts)
          .where(eq(schema.accounts.id, input.targetId))
          .limit(1)
      : []
  const anchor = accountAnchor.at(0)
  const existingTransactions =
    input.targetType === 'account'
      ? await db
          .select({
            postedAt: schema.transactions.postedAt,
            amountCents: schema.transactions.amountCents,
          })
          .from(schema.transactions)
          .where(eq(schema.transactions.accountId, input.targetId))
      : []

  for (const csvImport of importRows.filter(
    (item) =>
      !liveConflictIds.has(item.id) &&
      item.parser === 'csv' &&
      item.status === 'review' &&
      getEffectiveImportValidationState(item).remediation.links,
  )) {
    const csvStaged = stagedByImport.get(csvImport.id) ?? []
    const pdfControl = pdfControls.find((candidate) =>
      sameStatementValues(csvStaged, stagedByImport.get(candidate.id) ?? []),
    )
    if (!pdfControl) {
      if (!csvStaged.length) continue
      const partialPdf = pdfControls.find((candidate) => {
        const result = matchStatementValueSubset(
          stagedByImport.get(candidate.id) ?? [],
          csvStaged,
        )
        return Boolean(result?.unmatched.length)
      })
      if (!partialPdf) continue
      const pdfStaged = stagedByImport.get(partialPdf.id) ?? []
      const partialBalanceAsOf = partialPdf.balanceAsOf!
      const partialExistingMovementCents = anchor?.balanceAt
        ? existingTransactions
            .filter(
              (transaction) =>
                transaction.postedAt > anchor.balanceAt! &&
                transaction.postedAt <= partialBalanceAsOf,
            )
            .reduce((sum, transaction) => sum + transaction.amountCents, 0)
        : 0
      const partialNewMovementCents = pdfStaged
        .filter(
          (transaction) =>
            (!anchor?.balanceAt || transaction.postedAt > anchor.balanceAt) &&
            transaction.postedAt <= partialBalanceAsOf,
        )
        .reduce((total, item) => total + item.amountCents, 0)
      const audit = evaluateImportAudit({
        targetType: input.targetType,
        sourceTransactionCount: partialPdf.sourceTransactionCount,
        parsedTransactionCount: partialPdf.parsedTransactionCount,
        invalidTransactionCount: partialPdf.invalidTransactionCount,
        openingBalanceCents: partialPdf.openingBalanceCents,
        openingBalanceAt: partialPdf.openingBalanceAt,
        closingBalanceCents: partialPdf.closingBalanceCents,
        balanceAsOf: partialPdf.balanceAsOf,
        statementPeriodStart: partialPdf.periodStart,
        anchorBalanceCents: anchor?.balanceCents ?? null,
        anchorBalanceAt: anchor?.balanceAt ?? null,
        existingMovementCents: partialExistingMovementCents,
        newMovementCents: partialNewMovementCents,
        documentMovementCents: pdfStaged.reduce(
          (total, item) => total + item.amountCents,
          0,
        ),
      })
      if (audit.status !== 'reconciled') continue
      const documentLabel = input.targetType === 'card' ? 'fatura' : 'extrato'
      const dependencyId =
        canonicalDependencyByImport.get(partialPdf.id) ?? partialPdf.id
      db.transaction((transaction) => {
        transaction
          .update(schema.imports)
          .set({
            dependsOnImportId: dependencyId,
            ...nextValidationState({
              current: csvImport,
              evaluated: {
                validationStatus: 'reconciled',
                validationReason: audit.reasonCode,
                validationMessage: `Aguardando a consolidação do ${documentLabel} definitivo. Depois disso, este CSV parcial será preservado como evidência dos lançamentos já vistos.`,
              },
            }),
            warning: SAME_BATCH_PARTIAL_CSV_WARNING,
          })
          .where(eq(schema.imports.id, csvImport.id))
          .run()
        transaction
          .update(schema.imports)
          .set({
            ...nextValidationState({
              current: partialPdf,
              evaluated: {
                validationStatus: 'reconciled',
                validationReason: audit.reasonCode,
                validationMessage: `${documentLabel === 'fatura' ? 'Fatura definitiva reconciliada' : 'Extrato definitivo reconciliado'}. O documento inclui os lançamentos do CSV parcial e as movimentações ocorridas depois da última exportação.`,
              },
            }),
            expectedBalanceCents: audit.expectedBalanceCents,
            balanceDifferenceCents: audit.balanceDifferenceCents,
            warning:
              'Ao consolidar, o PDF será canônico e o CSV parcial permanecerá ligado como evidência, sem duplicar lançamentos.',
          })
          .where(eq(schema.imports.id, partialPdf.id))
          .run()
      })
      canonicalDependencyByImport.set(csvImport.id, dependencyId)
      continue
    }

    const balanceAsOf = pdfControl.balanceAsOf!
    const existingMovementCents = anchor?.balanceAt
      ? existingTransactions
          .filter(
            (transaction) =>
              transaction.postedAt > anchor.balanceAt! &&
              transaction.postedAt <= balanceAsOf,
          )
          .reduce((sum, transaction) => sum + transaction.amountCents, 0)
      : 0
    const newMovementCents = csvStaged
      .filter(
        (transaction) =>
          (!anchor?.balanceAt || transaction.postedAt > anchor.balanceAt) &&
          transaction.postedAt <= balanceAsOf,
      )
      .reduce((sum, transaction) => sum + transaction.amountCents, 0)
    const audit = evaluateImportAudit({
      targetType: input.targetType,
      sourceTransactionCount: csvImport.sourceTransactionCount,
      parsedTransactionCount: csvImport.parsedTransactionCount,
      invalidTransactionCount: csvImport.invalidTransactionCount,
      openingBalanceCents: pdfControl.openingBalanceCents,
      openingBalanceAt: pdfControl.openingBalanceAt,
      closingBalanceCents: pdfControl.closingBalanceCents,
      balanceAsOf,
      statementPeriodStart: pdfControl.periodStart ?? csvImport.periodStart,
      anchorBalanceCents: anchor?.balanceCents ?? null,
      anchorBalanceAt: anchor?.balanceAt ?? null,
      existingMovementCents,
      newMovementCents,
      documentMovementCents: csvStaged.reduce(
        (sum, transaction) => sum + transaction.amountCents,
        0,
      ),
    })
    if (audit.status !== 'reconciled') continue

    db.transaction((transaction) => {
      transaction
        .update(schema.imports)
        .set({
          openingBalanceCents: pdfControl.openingBalanceCents,
          openingBalanceAt: pdfControl.openingBalanceAt,
          closingBalanceCents: pdfControl.closingBalanceCents,
          closingBalanceType: pdfControl.closingBalanceType,
          balanceAsOf,
          periodStart: pdfControl.periodStart ?? csvImport.periodStart,
          periodEnd: pdfControl.periodEnd ?? csvImport.periodEnd,
          statementDueDate: pdfControl.statementDueDate,
          expectedBalanceCents: audit.expectedBalanceCents,
          balanceDifferenceCents: audit.balanceDifferenceCents,
          ...nextValidationState({
            current: csvImport,
            evaluated: {
              validationStatus: audit.status,
              validationReason: audit.reasonCode,
              validationMessage: `${audit.message} Valores conferidos contra o PDF enviado no mesmo lote.`,
            },
          }),
          warning:
            'O CSV é a fonte canônica dos lançamentos; o PDF foi preservado como evidência de controle.',
        })
        .where(eq(schema.imports.id, csvImport.id))
        .run()
      transaction
        .update(schema.imports)
        .set({
          dependsOnImportId: csvImport.id,
          validationMessage:
            'Aguardando a consolidação do arquivo estruturado equivalente. Depois disso, este PDF será preservado como evidência do saldo informado.',
          warning: SAME_BATCH_EXACT_PDF_WARNING,
        })
        .where(eq(schema.imports.id, pdfControl.id))
        .run()
      transaction
        .update(schema.imports)
        .set({ dependsOnImportId: csvImport.id })
        .where(
          and(
            eq(schema.imports.dependsOnImportId, pdfControl.id),
            eq(schema.imports.status, 'review'),
          ),
        )
        .run()
    })
    canonicalDependencyByImport.set(pdfControl.id, csvImport.id)
    for (const [dependentId, dependencyId] of canonicalDependencyByImport) {
      if (dependencyId === pdfControl.id) {
        canonicalDependencyByImport.set(dependentId, csvImport.id)
      }
    }
    matchedPdfIds.add(pdfControl.id)
  }
  return matchedPdfIds
}
