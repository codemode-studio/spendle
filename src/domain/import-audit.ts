export interface ImportAuditTransaction {
  amountCents: number
  postedAt: string
}

export {
  identifyDuplicateReasons,
  type CanonicalIdentity as ImportIdentity,
  type DuplicateReason,
} from './canonicalization'

export type ImportAuditStatus =
  'imported' | 'reconciled' | 'warning' | 'divergent'

export const IDENTICAL_FILE_CONFLICT_MESSAGE =
  'O mesmo arquivo já foi associado a outro destino. O lote foi bloqueado.'
export const DESTINATION_CONFLICT_MESSAGE =
  'O tipo de documento não corresponde ao destino selecionado.'

export type ImportAuditReasonCode =
  | 'ready'
  | 'needs_balance'
  | 'needs_manual_review'
  | 'pending_correction'
  | 'identical_file'
  | 'destination_conflict'
  | 'missing_statement_transactions'
  | 'statement_match_candidates'
  | 'invalid_rows'
  | 'balance_mismatch'
  | 'blocked'

const HARD_IMPORT_REVIEW_REASONS = [
  'blocked',
  'identical_file',
  'destination_conflict',
] as const

export type HardImportReviewReason = (typeof HARD_IMPORT_REVIEW_REASONS)[number]

export function isHardImportReviewReason(
  reason: ImportAuditReasonCode | null,
): reason is HardImportReviewReason {
  return (
    reason !== null &&
    (
      HARD_IMPORT_REVIEW_REASONS as ReadonlyArray<ImportAuditReasonCode>
    ).includes(reason)
  )
}

interface ImportValidationReasonRow {
  validationReason: ImportAuditReasonCode | null
  validationStatus: ImportAuditStatus
  validationMessage: string | null
  status?: 'review' | 'committed' | 'evidence' | 'rejected' | 'failed'
  parser?: 'ofx' | 'csv' | 'pdf_inspector' | 'pdf_local' | 'pdf_ai'
  accountId?: string | null
  creditCardId?: string | null
  documentKind?: 'bank_statement' | 'card_statement' | 'unknown'
  invalidTransactionCount?: number
  balanceDifferenceCents?: number | null
  pagesNeedingOcrJson?: string | null
  extractionDiagnosticsJson?: string | null
  hasDestinationConflict?: boolean
}

export function effectiveValidationReason(
  row: ImportValidationReasonRow,
): ImportAuditReasonCode | null {
  const liveHardReason =
    row.validationMessage === IDENTICAL_FILE_CONFLICT_MESSAGE
      ? ('identical_file' as const)
      : row.hasDestinationConflict ||
          (row.accountId !== null &&
            row.accountId !== undefined &&
            row.documentKind === 'card_statement') ||
          (row.creditCardId !== null &&
            row.creditCardId !== undefined &&
            row.documentKind === 'bank_statement') ||
          row.validationMessage === DESTINATION_CONFLICT_MESSAGE ||
          row.validationMessage?.startsWith('O documento parece ser de ') ||
          row.validationMessage?.startsWith('O documento termina em •') ||
          row.validationMessage?.startsWith('O CSV termina em •')
        ? ('destination_conflict' as const)
        : null
  if (liveHardReason) {
    return resolveImportReviewReason({
      stored: row.validationReason,
      derived: liveHardReason,
    })
  }
  if (row.validationReason !== null) return row.validationReason
  if (row.validationStatus !== 'divergent') return null

  let hasExtractionBlock =
    row.status === 'failed' ||
    row.parser === 'pdf_ai' ||
    Boolean(
      row.pagesNeedingOcrJson &&
      row.pagesNeedingOcrJson !== '[]' &&
      row.pagesNeedingOcrJson !== 'null',
    )
  if (!hasExtractionBlock && row.extractionDiagnosticsJson) {
    try {
      const diagnostics = JSON.parse(row.extractionDiagnosticsJson) as {
        suspiciousTextLoss?: boolean
        disagreesWithLegacy?: boolean
        aiConfirmation?: { status?: string }
      }
      hasExtractionBlock = Boolean(
        diagnostics.suspiciousTextLoss ||
        diagnostics.disagreesWithLegacy ||
        ['divergent', 'failed', 'fallback_unverified'].includes(
          diagnostics.aiConfirmation?.status ?? '',
        ),
      )
    } catch {
      // An unreadable diagnostic does not prove that extraction was quarantined.
    }
  }
  if (hasExtractionBlock) return 'blocked'
  if ((row.invalidTransactionCount ?? 0) > 0) return 'invalid_rows'
  if (
    row.balanceDifferenceCents !== null &&
    row.balanceDifferenceCents !== undefined &&
    row.balanceDifferenceCents !== 0
  ) {
    return 'balance_mismatch'
  }

  return null
}

interface ImportValidationState extends ImportValidationReasonRow {
  validationStatus: ImportAuditStatus
  validationReason: ImportAuditReasonCode | null
  validationMessage: string | null
}

export function nextValidationState<T extends ImportValidationState>(input: {
  current: ImportValidationState
  evaluated: T
}): T {
  const currentReason = effectiveValidationReason(input.current)
  if (!isHardImportReviewReason(currentReason)) {
    return input.evaluated
  }

  return {
    ...input.evaluated,
    validationStatus: 'divergent',
    validationReason: currentReason,
    validationMessage: input.current.validationMessage,
  }
}

type ImportTargetType = 'account' | 'card'
type ImportSourceType = 'csv' | 'ofx' | 'file'

interface ImportReviewGuidanceBase {
  targetType: ImportTargetType
  message: string | null
}

export type ImportReviewGuidance = ImportReviewGuidanceBase &
  (
    | {
        kind: 'ready'
        mode: 'reconciled' | 'imported'
      }
    | {
        kind: 'needs_balance'
        mode: 'imported' | 'manual_review'
        sourceType: ImportSourceType
        parsedTransactionCount: number
      }
    | {
        kind: 'needs_manual_review'
        reason: 'unreliable_count' | 'missing_anchor'
        parsedTransactionCount: number
      }
    | { kind: 'pending_correction' }
    | { kind: 'identical_file' }
    | { kind: 'destination_conflict' }
    | { kind: 'missing_statement_transactions' }
    | { kind: 'statement_match_candidates' }
    | { kind: 'invalid_rows'; invalidTransactionCount: number }
    | { kind: 'balance_mismatch'; balanceDifferenceCents: number | null }
    | { kind: 'blocked'; reason: 'currency_mismatch' | 'generic' }
  )

export interface ImportReviewGuidanceInput {
  targetType: ImportTargetType
  parser: 'ofx' | 'csv' | 'pdf_inspector' | 'pdf_local' | 'pdf_ai'
  validationStatus: ImportAuditStatus
  reasonCode: ImportAuditReasonCode | null
  validationMessage: string | null
  parsedTransactionCount: number
  sourceTransactionCount: number | null
  closingBalanceCents: number | null
  balanceDifferenceCents: number | null
  invalidTransactionCount: number
  conflictReasonCode: 'identical_file' | 'destination_conflict' | null
  hasPendingCorrection: boolean
  hasStatementMatchCandidates: boolean
  hasStatementCurrencyMismatch?: boolean
  hasMissingStatementTransactions: boolean
  hasBalanceConflict: boolean
}

export function resolveImportReviewReason(input: {
  stored: ImportAuditReasonCode | null
  derived: ImportAuditReasonCode
}): ImportAuditReasonCode {
  return isHardImportReviewReason(input.stored) ? input.stored : input.derived
}

export function classifyImportReviewGuidance(
  input: ImportReviewGuidanceInput,
): ImportReviewGuidance {
  const base = {
    targetType: input.targetType,
    message: input.validationMessage,
  }
  const sourceType =
    input.parser === 'csv'
      ? ('csv' as const)
      : input.parser === 'ofx'
        ? ('ofx' as const)
        : ('file' as const)

  if (input.reasonCode) {
    switch (input.reasonCode) {
      case 'ready':
        return {
          ...base,
          kind: 'ready',
          mode:
            input.validationStatus === 'reconciled' ? 'reconciled' : 'imported',
        }
      case 'needs_balance':
        return {
          ...base,
          kind: 'needs_balance',
          mode:
            input.validationStatus === 'warning' ? 'manual_review' : 'imported',
          sourceType,
          parsedTransactionCount: input.parsedTransactionCount,
        }
      case 'needs_manual_review':
        return {
          ...base,
          kind: 'needs_manual_review',
          reason:
            input.sourceTransactionCount === null
              ? 'unreliable_count'
              : 'missing_anchor',
          parsedTransactionCount: input.parsedTransactionCount,
        }
      case 'invalid_rows':
        return {
          ...base,
          kind: 'invalid_rows',
          invalidTransactionCount: input.invalidTransactionCount,
        }
      case 'balance_mismatch':
        return {
          ...base,
          kind: 'balance_mismatch',
          balanceDifferenceCents: input.balanceDifferenceCents,
        }
      case 'pending_correction':
      case 'identical_file':
      case 'destination_conflict':
      case 'missing_statement_transactions':
      case 'statement_match_candidates':
        return { ...base, kind: input.reasonCode }
      case 'blocked':
        return {
          ...base,
          kind: 'blocked',
          reason: input.hasStatementCurrencyMismatch
            ? 'currency_mismatch'
            : 'generic',
        }
    }
  }

  if (input.validationStatus === 'reconciled') {
    return { ...base, kind: 'ready', mode: 'reconciled' }
  }

  if (input.validationStatus === 'imported') {
    return input.closingBalanceCents === null
      ? {
          ...base,
          kind: 'needs_balance',
          mode: 'imported',
          sourceType,
          parsedTransactionCount: input.parsedTransactionCount,
        }
      : { ...base, kind: 'ready', mode: 'imported' }
  }

  if (input.validationStatus === 'warning') {
    if (input.closingBalanceCents === null) {
      return {
        ...base,
        kind: 'needs_balance',
        mode: 'manual_review',
        sourceType,
        parsedTransactionCount: input.parsedTransactionCount,
      }
    }
    return {
      ...base,
      kind: 'needs_manual_review',
      reason:
        input.sourceTransactionCount === null
          ? 'unreliable_count'
          : 'missing_anchor',
      parsedTransactionCount: input.parsedTransactionCount,
    }
  }

  if (input.hasPendingCorrection) {
    return { ...base, kind: 'pending_correction' }
  }
  if (input.conflictReasonCode) {
    return { ...base, kind: input.conflictReasonCode }
  }
  if (input.invalidTransactionCount > 0) {
    return {
      ...base,
      kind: 'invalid_rows',
      invalidTransactionCount: input.invalidTransactionCount,
    }
  }
  if (input.hasStatementCurrencyMismatch) {
    return { ...base, kind: 'blocked', reason: 'currency_mismatch' }
  }
  if (input.hasMissingStatementTransactions) {
    return { ...base, kind: 'missing_statement_transactions' }
  }
  if (input.hasStatementMatchCandidates) {
    return { ...base, kind: 'statement_match_candidates' }
  }
  if (input.hasBalanceConflict || input.balanceDifferenceCents !== null) {
    return {
      ...base,
      kind: 'balance_mismatch',
      balanceDifferenceCents: input.balanceDifferenceCents,
    }
  }
  return { ...base, kind: 'blocked', reason: 'generic' }
}

export type ImportCoverageSource =
  'metadata' | 'filename' | 'user' | 'activity' | 'unknown'

export interface ImportCoverageProvenance {
  source: ImportCoverageSource
  evidence: 'declared_period' | 'activity_only'
  reliable: boolean
}

export function getImportCoverageProvenance(input: {
  source: ImportCoverageSource
  periodStart: string | null
  periodEnd: string | null
}): ImportCoverageProvenance {
  const hasDeclaredPeriod =
    input.source === 'metadata' ||
    input.source === 'filename' ||
    input.source === 'user'

  return {
    source: input.source,
    evidence: hasDeclaredPeriod ? 'declared_period' : 'activity_only',
    reliable: Boolean(
      hasDeclaredPeriod && input.periodStart && input.periodEnd,
    ),
  }
}

export type ImportBalanceReview =
  | { kind: 'difference'; differenceCents: number }
  | { kind: 'missing'; targetType: ImportTargetType }
  | { kind: 'missing_anchor' }

export function getImportBalanceReview(input: {
  targetType: ImportTargetType
  closingBalanceCents: number | null
  balanceDifferenceCents: number | null
}): ImportBalanceReview {
  if (input.balanceDifferenceCents !== null) {
    return {
      kind: 'difference',
      differenceCents: input.balanceDifferenceCents,
    }
  }
  if (input.closingBalanceCents === null) {
    return { kind: 'missing', targetType: input.targetType }
  }
  return { kind: 'missing_anchor' }
}

export function summarizeImport(
  transactions: Array<ImportAuditTransaction>,
  sourceTransactionCount: number | null,
) {
  const dates = transactions.map((transaction) => transaction.postedAt).sort()
  const totalCreditsCents = transactions
    .filter((transaction) => transaction.amountCents > 0)
    .reduce((sum, transaction) => sum + transaction.amountCents, 0)
  const totalDebitsCents = transactions
    .filter((transaction) => transaction.amountCents < 0)
    .reduce((sum, transaction) => sum + Math.abs(transaction.amountCents), 0)

  return {
    sourceTransactionCount,
    parsedTransactionCount: transactions.length,
    invalidTransactionCount:
      sourceTransactionCount === null
        ? 0
        : Math.max(0, sourceTransactionCount - transactions.length),
    periodStart: dates.at(0) ?? null,
    periodEnd: dates.at(-1) ?? null,
    totalCreditsCents,
    totalDebitsCents,
    netMovementCents: totalCreditsCents - totalDebitsCents,
  }
}

function nextDate(date: string) {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + 1)
  return value.toISOString().slice(0, 10)
}

export function evaluateImportAudit(input: {
  targetType: 'account' | 'card'
  sourceTransactionCount: number | null
  parsedTransactionCount: number
  invalidTransactionCount: number
  openingBalanceCents: number | null
  openingBalanceAt: string | null
  closingBalanceCents: number | null
  balanceAsOf: string | null
  statementPeriodStart: string | null
  anchorBalanceCents: number | null
  anchorBalanceAt: string | null
  existingMovementCents: number
  newMovementCents: number
  documentMovementCents?: number
}) {
  if (input.invalidTransactionCount > 0) {
    return {
      reasonCode: 'invalid_rows' as const,
      status: 'divergent' as const,
      expectedBalanceCents: null,
      balanceDifferenceCents: null,
      message: `${input.invalidTransactionCount} lançamento(s) do arquivo não foram interpretados. A consolidação foi bloqueada.`,
    }
  }

  const hasCompleteCount =
    input.sourceTransactionCount !== null &&
    input.sourceTransactionCount === input.parsedTransactionCount

  if (
    input.targetType === 'account' &&
    input.closingBalanceCents !== null &&
    input.balanceAsOf !== null &&
    input.anchorBalanceCents !== null &&
    input.anchorBalanceAt === input.balanceAsOf &&
    input.anchorBalanceCents !== input.closingBalanceCents
  ) {
    return {
      reasonCode: 'balance_mismatch' as const,
      status: 'divergent' as const,
      expectedBalanceCents: input.anchorBalanceCents,
      balanceDifferenceCents:
        input.closingBalanceCents - input.anchorBalanceCents,
      message:
        'Já existe um saldo diferente confirmado para esta mesma data. Corrija ou invalide o ponto de controle anterior antes de consolidar.',
    }
  }

  if (
    input.targetType === 'account' &&
    input.openingBalanceCents !== null &&
    input.closingBalanceCents !== null &&
    input.balanceAsOf !== null
  ) {
    if (
      input.openingBalanceAt !== null &&
      input.anchorBalanceCents !== null &&
      input.anchorBalanceAt !== null &&
      (input.anchorBalanceAt === input.openingBalanceAt ||
        nextDate(input.anchorBalanceAt) === input.openingBalanceAt) &&
      input.anchorBalanceCents !== input.openingBalanceCents
    ) {
      return {
        reasonCode: 'balance_mismatch' as const,
        status: 'divergent' as const,
        expectedBalanceCents: input.anchorBalanceCents,
        balanceDifferenceCents:
          input.openingBalanceCents - input.anchorBalanceCents,
        message:
          'O saldo inicial do arquivo contradiz o saldo já confirmado para a mesma data. Corrija o ponto de controle ou escolha outro período.',
      }
    }
    const expectedBalanceCents =
      input.openingBalanceCents +
      (input.documentMovementCents ?? input.newMovementCents)
    const balanceDifferenceCents =
      input.closingBalanceCents - expectedBalanceCents
    if (balanceDifferenceCents !== 0) {
      return {
        reasonCode: 'balance_mismatch' as const,
        status: 'divergent' as const,
        expectedBalanceCents,
        balanceDifferenceCents,
        message:
          'Saldo inicial, movimentações e saldo final não fecham. A consolidação foi bloqueada.',
      }
    }
    return {
      reasonCode: 'ready' as const,
      status: 'reconciled' as const,
      expectedBalanceCents,
      balanceDifferenceCents,
      message: 'Saldo inicial, movimentações e saldo final reconciliados.',
    }
  }

  if (
    input.targetType === 'card' &&
    input.closingBalanceCents !== null &&
    input.balanceAsOf !== null
  ) {
    const expectedBalanceCents = Math.max(0, -input.newMovementCents)
    const balanceDifferenceCents =
      input.closingBalanceCents - expectedBalanceCents
    if (balanceDifferenceCents !== 0) {
      return {
        reasonCode: 'balance_mismatch' as const,
        status: 'divergent' as const,
        expectedBalanceCents,
        balanceDifferenceCents,
        message:
          'A soma das compras e créditos não corresponde ao total da fatura.',
      }
    }
    return {
      reasonCode: 'ready' as const,
      status: 'reconciled' as const,
      expectedBalanceCents,
      balanceDifferenceCents,
      message: 'Total da fatura reconciliado com compras e créditos.',
    }
  }

  const canReconcileBalance =
    input.targetType === 'account' &&
    input.closingBalanceCents !== null &&
    input.balanceAsOf !== null &&
    input.statementPeriodStart !== null &&
    input.anchorBalanceCents !== null &&
    input.anchorBalanceAt !== null &&
    input.statementPeriodStart <= nextDate(input.anchorBalanceAt) &&
    input.balanceAsOf >= input.anchorBalanceAt

  if (canReconcileBalance) {
    const expectedBalanceCents =
      input.anchorBalanceCents! +
      input.existingMovementCents +
      input.newMovementCents
    const balanceDifferenceCents =
      input.closingBalanceCents! - expectedBalanceCents

    if (balanceDifferenceCents !== 0) {
      return {
        reasonCode: 'balance_mismatch' as const,
        status: 'divergent' as const,
        expectedBalanceCents,
        balanceDifferenceCents,
        message:
          'O saldo calculado não corresponde ao saldo informado pelo extrato. A consolidação foi bloqueada.',
      }
    }

    return {
      reasonCode: 'ready' as const,
      status: 'reconciled' as const,
      expectedBalanceCents,
      balanceDifferenceCents,
      message: hasCompleteCount
        ? 'Contagem de lançamentos e saldo final reconciliados.'
        : 'Saldo final reconciliado; o formato não informa uma contagem estrutural confiável.',
    }
  }

  if (
    input.targetType === 'account' &&
    hasCompleteCount &&
    input.closingBalanceCents !== null &&
    input.balanceAsOf !== null
  ) {
    return {
      reasonCode: 'ready' as const,
      status: 'imported' as const,
      expectedBalanceCents: input.closingBalanceCents,
      balanceDifferenceCents: null,
      message:
        'Importação concluída. Este saldo estabelece o primeiro ponto de controle; a reconciliação começa no próximo saldo datado.',
    }
  }

  if (input.targetType === 'account' && input.closingBalanceCents === null) {
    return {
      reasonCode: 'needs_balance' as const,
      status: 'imported' as const,
      expectedBalanceCents: null,
      balanceDifferenceCents: null,
      message:
        'Todos os lançamentos foram lidos. O arquivo não informa saldo final; confirme um saldo datado na conta para iniciar a reconciliação.',
    }
  }

  if (input.targetType === 'card' && input.closingBalanceCents === null) {
    return {
      reasonCode: 'needs_balance' as const,
      status: 'imported' as const,
      expectedBalanceCents: null,
      balanceDifferenceCents: null,
      message:
        'Todos os lançamentos foram lidos como provisórios. Confirme o total quando a fatura fechar.',
    }
  }

  return {
    reasonCode: 'needs_manual_review' as const,
    status: 'warning' as const,
    expectedBalanceCents: null,
    balanceDifferenceCents: null,
    message: hasCompleteCount
      ? 'Todos os lançamentos foram lidos, mas não há um saldo anterior compatível. Importe um extrato anterior com saldo ou confira este lote manualmente.'
      : 'O arquivo não oferece contagem e saldos suficientes. Confira a conta, o período e os totais antes de consolidar.',
  }
}

export function canCommitImportAudit(
  status: ImportAuditStatus,
  manualReviewConfirmed: boolean,
) {
  return (
    status === 'imported' ||
    status === 'reconciled' ||
    (status === 'warning' && manualReviewConfirmed)
  )
}
