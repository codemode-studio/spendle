import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'

import { db } from '#/db/index.server'
import * as schema from '#/db/schema'
import { parseInstallmentDescription } from '#/domain/credit-card'
import { nextValidationState } from '#/domain/import-audit'
import {
  applyImportOutcome,
  resolveImportOutcome,
} from './canonical-outcome.server'

type StagedRow = typeof schema.stagedTransactions.$inferSelect
type TransactionRow = typeof schema.transactions.$inferSelect
type Assignment = { observation: StagedRow; transaction: TransactionRow }

function installmentFor(
  creditCardId: string,
  observation: StagedRow,
  transactionId: string,
) {
  const installment =
    observation.amountCents < 0
      ? parseInstallmentDescription(observation.description)
      : null
  return installment
    ? {
        id: randomUUID(),
        creditCardId,
        sourceTransactionId: transactionId,
        description: installment.cleanDescription,
        categoryId: observation.suggestedCategoryId,
        installmentAmountCents: Math.abs(observation.amountCents),
        totalInstallments: installment.totalInstallments,
        currentInstallment: installment.currentInstallment,
        firstChargeDate: observation.postedAt,
        autoDetected: true,
      }
    : null
}

export function applyCardPdfOutcome(input: {
  targetId: string
  pdfControl: typeof schema.imports.$inferSelect
  assignments: Assignment[]
  createdFromPdf: Array<{
    observation: StagedRow
    transaction: typeof schema.transactions.$inferInsert
  }>
  matchedImportIds: string[]
  obsoleteOpenCycles: Array<typeof schema.cardStatementCycles.$inferSelect>
  confirmedPending: boolean
  checkpointAtDate: { status: 'none' | 'identical' | 'conflict' }
  audit: {
    reasonCode: typeof schema.imports.$inferSelect.validationReason
    expectedBalanceCents: number | null
    balanceDifferenceCents: number | null
  }
}) {
  db.transaction((transaction) => {
    const createdByObservation = new Map(
      input.createdFromPdf.map(({ observation, transaction: created }) => [
        observation.id,
        created.id,
      ]),
    )
    const outcome = resolveImportOutcome(transaction, input.pdfControl.id, {
      assignments: input.assignments.map(
        ({ observation, transaction: match }) => ({
          observationId: observation.id,
          transactionId: match.id,
          externalId: observation.externalId,
        }),
      ),
      auditStatus: 'reconciled',
      balanceDifferenceCents: input.audit.balanceDifferenceCents,
      checkpointMethod: 'date_amount_currency_multiset',
      createdTransactionByObservation: createdByObservation,
      createdTransactions: input.createdFromPdf.map(
        ({ transaction: created }) => ({
          id: created.id,
          externalId: created.externalId ?? null,
        }),
      ),
    })
    if (
      input.assignments.some(
        ({ transaction: match }) => match.status === 'excluded',
      ) &&
      outcome.checkpoint.kind === 'anchor'
    ) {
      outcome.checkpoint.create = true
    }
    outcome.restoration = {
      exclusionReasonSuffix:
        'Reaberta automaticamente porque uma fatura posterior comprovou a movimentação.',
      validationMessage:
        'Uma movimentação antes marcada como autorização ausente apareceu em uma fatura posterior. O fechamento foi reaberto para conferência.',
      reconciliationReason:
        'Reaberta porque uma autorização antes excluída reapareceu em uma fatura posterior.',
      checkpointReason:
        'Uma autorização antes excluída reapareceu em uma fatura posterior.',
    }
    const installments = input.createdFromPdf.flatMap(
      ({ observation, transaction: created }) => {
        const installment = installmentFor(
          input.targetId,
          observation,
          created.id,
        )
        return installment ? [installment] : []
      },
    )
    outcome.commit = {
      importPatch: {
        warning: input.createdFromPdf.length
          ? 'Os lançamentos já vistos preservam o CSV como origem; somente as compras ausentes no último CSV vieram do PDF de fechamento.'
          : 'O CSV anterior continua como fonte canônica; este PDF comprova o fechamento e o total da fatura.',
      },
      transactions: input.createdFromPdf.map((item) => item.transaction),
      installments,
      validation: {
        status: 'reconciled',
        reason: input.audit.reasonCode,
        message: input.createdFromPdf.length
          ? `PDF definitivo conferido: ${input.assignments.length} lançamento(s) já existente(s) foram ligados e ${input.createdFromPdf.length} lançamento(s) do fechamento foram incluídos uma única vez.`
          : input.confirmedPending
            ? 'PDF definitivo conferido contra os lançamentos já importados. Os pendentes foram confirmados sem duplicação.'
            : 'PDF definitivo repetido conferido contra os lançamentos já consolidados e preservado como evidência adicional.',
        expectedBalanceCents: input.audit.expectedBalanceCents,
        balanceDifferenceCents: input.audit.balanceDifferenceCents,
      },
    }
    applyImportOutcome(transaction, outcome)

    for (const matchedImportId of input.matchedImportIds) {
      const matchedImport = transaction
        .select()
        .from(schema.imports)
        .where(eq(schema.imports.id, matchedImportId))
        .get()
      if (!matchedImport) continue
      transaction
        .update(schema.imports)
        .set({
          closingBalanceCents: input.pdfControl.closingBalanceCents,
          balanceAsOf: input.pdfControl.balanceAsOf,
          statementDueDate: input.pdfControl.statementDueDate,
          ...nextValidationState({
            current: matchedImport,
            evaluated: {
              validationStatus: 'reconciled',
              validationReason: input.audit.reasonCode,
              validationMessage:
                'Fatura encerrada pelo PDF definitivo importado posteriormente; os lançamentos do CSV foram preservados e confirmados.',
            },
          }),
          expectedBalanceCents: input.audit.expectedBalanceCents,
          balanceDifferenceCents: input.audit.balanceDifferenceCents,
        })
        .where(eq(schema.imports.id, matchedImportId))
        .run()
    }
    for (const obsoleteCycle of input.obsoleteOpenCycles) {
      transaction
        .delete(schema.cardStatementCycles)
        .where(eq(schema.cardStatementCycles.id, obsoleteCycle.id))
        .run()
    }
  })
}
