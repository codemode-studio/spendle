import { db } from '#/db/index.server'
import type * as schema from '#/db/schema'
import {
  applyImportOutcome,
  resolveImportOutcome,
} from './canonical-outcome.server'

type StagedRow = typeof schema.stagedTransactions.$inferSelect
type TransactionRow = typeof schema.transactions.$inferSelect

export function applyAccountPdfOutcome(input: {
  targetId: string
  pdfControl: typeof schema.imports.$inferSelect
  assignments: Array<{ observation: StagedRow; transaction: TransactionRow }>
  createdFromPdf: Array<{
    observation: StagedRow
    transaction: typeof schema.transactions.$inferInsert
  }>
  restoredAssignments: Array<{
    observation: StagedRow
    transaction: TransactionRow
  }>
  checkpointAtDate: { status: 'none' | 'identical' | 'conflict' }
  audit: {
    status: 'imported' | 'warning' | 'reconciled' | 'divergent'
    reasonCode: typeof schema.imports.$inferSelect.validationReason
    message: string
    expectedBalanceCents: number | null
    balanceDifferenceCents: number | null
  }
  account:
    | {
        balanceCents: number | null
        balanceAt: string | null
        coverageStart: string | null
      }
    | undefined
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
      auditStatus: input.audit.status,
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
      input.restoredAssignments.length &&
      outcome.checkpoint.kind === 'anchor'
    ) {
      outcome.checkpoint.create = true
    }
    outcome.restoration = {
      exclusionReasonSuffix:
        'Reaberta automaticamente porque um extrato posterior comprovou a movimentação.',
      validationMessage:
        'Uma movimentação antes excluída apareceu em um extrato posterior. Os saldos seguintes foram reabertos para conferência.',
      reconciliationReason:
        'Reaberta porque uma movimentação antes excluída reapareceu em um extrato posterior.',
      checkpointReason:
        'Uma movimentação antes excluída reapareceu em um extrato posterior.',
    }
    outcome.commit = {
      importPatch: {
        warning: input.createdFromPdf.length
          ? 'As linhas já existentes preservam sua origem; somente os lançamentos ausentes vieram do PDF.'
          : 'Os lançamentos estruturados continuam como fonte canônica; este PDF comprova o período e o saldo informado.',
      },
      transactions: input.createdFromPdf.map((item) => item.transaction),
      installments: [],
      validation: {
        status: input.audit.status,
        reason: input.audit.reasonCode,
        message: input.createdFromPdf.length
          ? `${input.audit.message} ${input.assignments.length} lançamento(s) existente(s) foram ligados e ${input.createdFromPdf.length} novo(s) foram incluídos uma única vez.`
          : `${input.audit.message} O PDF foi ligado aos lançamentos já existentes e não criou duplicidades.`,
        expectedBalanceCents: input.audit.expectedBalanceCents,
        balanceDifferenceCents: input.audit.balanceDifferenceCents,
      },
    }
    applyImportOutcome(transaction, outcome)
  })
}
