import { formatCurrency } from './currency'

interface ImportAuditTransaction {
  amountCents: number
  postedAt: string
}

export { identifyDuplicateReasons } from './canonicalization'

type ImportAuditStatus = 'imported' | 'reconciled' | 'warning' | 'divergent'

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

type HardImportReviewReason = (typeof HARD_IMPORT_REVIEW_REASONS)[number]

function isHardImportReviewReason(
  reason: ImportAuditReasonCode | null,
): reason is HardImportReviewReason {
  return HARD_IMPORT_REVIEW_REASONS.includes(reason as HardImportReviewReason)
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
  detectedInstitution?: string | null
  detectedLastFour?: string | null
  invalidTransactionCount?: number
  balanceDifferenceCents?: number | null
  pagesNeedingOcrJson?: string | null
  extractionDiagnosticsJson?: string | null
  parsedTransactionCount?: number
  sourceTransactionCount?: number | null
  closingBalanceCents?: number | null
}

interface ImportDestinationMetadata {
  targetIdentifiers: Array<string | null | undefined>
  targetInstitutionName: string | null
}

interface LiveImportValidationFacts {
  destination?: ImportDestinationMetadata
  hasDestinationConflict?: boolean
  hasPendingCorrection?: boolean
  hasStatementMatchCandidates?: boolean
  hasStatementCurrencyMismatch?: boolean
  hasMissingStatementTransactions?: boolean
  hasBalanceConflict?: boolean
  manualReviewConfirmed?: boolean
}

function normalizeLastFour(value: string | null | undefined) {
  const digits = value?.replace(/\D/g, '') ?? ''
  return digits.length >= 4 ? digits.slice(-4) : null
}

export function hasImportDestinationConflict(
  importRow: Pick<
    ImportValidationReasonRow,
    'detectedInstitution' | 'detectedLastFour'
  >,
  metadata: ImportDestinationMetadata,
) {
  const detectedInstitution = importRow.detectedInstitution?.toLowerCase()
  const targetInstitution = metadata.targetInstitutionName?.toLowerCase()
  const detectedLastFour = normalizeLastFour(importRow.detectedLastFour)
  // Same semantics as the original guard: any non-empty detected value is
  // checked, and a value that cannot normalise to four digits never matches.
  const lastFourMatchesTarget = Boolean(
    detectedLastFour &&
    metadata.targetIdentifiers.some(
      (identifier) => normalizeLastFour(identifier) === detectedLastFour,
    ),
  )

  return Boolean(
    (importRow.detectedLastFour &&
      metadata.targetIdentifiers.some(Boolean) &&
      !lastFourMatchesTarget) ||
    (detectedInstitution &&
      targetInstitution &&
      !targetInstitution.includes(detectedInstitution) &&
      !detectedInstitution.includes(targetInstitution)),
  )
}

function preferImportReviewReason(
  stored: ImportAuditReasonCode | null,
  derived: ImportAuditReasonCode,
) {
  return isHardImportReviewReason(stored) ? stored : derived
}

function effectivePersistedValidationReason(
  row: ImportValidationReasonRow,
  hasDestinationConflict = false,
): ImportAuditReasonCode | null {
  const liveHardReason =
    row.validationMessage === IDENTICAL_FILE_CONFLICT_MESSAGE
      ? ('identical_file' as const)
      : hasDestinationConflict ||
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
    return preferImportReviewReason(row.validationReason, liveHardReason)
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

function validationMessageForReason(input: {
  persistedReason: ImportAuditReasonCode | null
  effectiveReason: ImportAuditReasonCode | null
  persistedMessage: string | null
}) {
  if (input.effectiveReason === input.persistedReason) {
    return input.persistedMessage
  }
  const fallback: Partial<Record<ImportAuditReasonCode, string>> = {
    identical_file: IDENTICAL_FILE_CONFLICT_MESSAGE,
    destination_conflict: DESTINATION_CONFLICT_MESSAGE,
    blocked: 'A auditoria encontrou uma divergência que precisa ser corrigida.',
  }
  return (
    (input.effectiveReason && fallback[input.effectiveReason]) ??
    input.persistedMessage
  )
}

function statusIsCommittable(
  status: ImportAuditStatus,
  manualReviewConfirmed: boolean,
) {
  return (
    status === 'imported' ||
    status === 'reconciled' ||
    (status === 'warning' && manualReviewConfirmed)
  )
}

export function getEffectiveImportValidationState(
  row: ImportValidationReasonRow,
  live: LiveImportValidationFacts = {},
) {
  const hasDestinationConflict =
    live.hasDestinationConflict ??
    (live.destination
      ? hasImportDestinationConflict(row, live.destination)
      : false)
  const persistedReason = effectivePersistedValidationReason(
    row,
    hasDestinationConflict,
  )
  const hasEffectiveDestinationConflict =
    persistedReason === 'identical_file' ||
    persistedReason === 'destination_conflict'
  const status = hasEffectiveDestinationConflict
    ? ('divergent' as const)
    : row.validationStatus
  const message = validationMessageForReason({
    persistedReason: row.validationReason,
    effectiveReason: persistedReason,
    persistedMessage: row.validationMessage,
  })
  const targetType = row.accountId ? ('account' as const) : ('card' as const)
  const derivedReason = classifyImportReviewGuidance({
    targetType,
    parser: row.parser ?? 'pdf_local',
    validationStatus: status,
    reasonCode: null,
    validationMessage: message,
    parsedTransactionCount: row.parsedTransactionCount ?? 0,
    sourceTransactionCount: row.sourceTransactionCount ?? null,
    closingBalanceCents: row.closingBalanceCents ?? null,
    balanceDifferenceCents: row.balanceDifferenceCents ?? null,
    invalidTransactionCount: row.invalidTransactionCount ?? 0,
    conflictReasonCode: hasEffectiveDestinationConflict
      ? persistedReason
      : null,
    hasPendingCorrection: live.hasPendingCorrection ?? false,
    hasStatementMatchCandidates: live.hasStatementMatchCandidates ?? false,
    hasStatementCurrencyMismatch: live.hasStatementCurrencyMismatch ?? false,
    hasMissingStatementTransactions:
      live.hasMissingStatementTransactions ?? false,
    hasBalanceConflict: live.hasBalanceConflict ?? false,
  }).kind
  const reason = preferImportReviewReason(persistedReason, derivedReason)
  const remediationAvailable = !isHardImportReviewReason(persistedReason)

  return {
    status,
    reason,
    message,
    committable:
      !isHardImportReviewReason(reason) &&
      statusIsCommittable(status, live.manualReviewConfirmed ?? false),
    remediation: {
      links: remediationAvailable,
      exclusions: remediationAvailable,
      checkpointReplacement: remediationAvailable,
    },
  }
}

export function nextValidationState<
  T extends ImportValidationReasonRow,
>(input: { current: ImportValidationReasonRow; evaluated: T }): T {
  const current = getEffectiveImportValidationState(input.current)
  if (current.remediation.links) {
    return input.evaluated
  }

  return {
    ...input.evaluated,
    validationStatus: 'divergent',
    validationReason: current.reason,
    validationMessage: input.current.validationMessage,
  }
}

type ImportTargetType = 'account' | 'card'
type ImportSourceType = 'csv' | 'ofx' | 'file'

interface ImportReviewGuidanceBase {
  targetType: ImportTargetType
  message: string | null
}

type ImportReviewGuidance = ImportReviewGuidanceBase &
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

function derivedImportReviewReason(
  input: ImportReviewGuidanceInput,
): ImportAuditReasonCode {
  if (input.validationStatus === 'reconciled') return 'ready'
  if (input.validationStatus === 'imported') {
    return input.closingBalanceCents === null ? 'needs_balance' : 'ready'
  }
  if (input.validationStatus === 'warning') {
    return input.closingBalanceCents === null
      ? 'needs_balance'
      : 'needs_manual_review'
  }
  if (input.hasPendingCorrection) return 'pending_correction'
  if (input.conflictReasonCode) return input.conflictReasonCode
  if (input.invalidTransactionCount > 0) return 'invalid_rows'
  if (input.hasStatementCurrencyMismatch) return 'blocked'
  if (input.hasMissingStatementTransactions) {
    return 'missing_statement_transactions'
  }
  if (input.hasStatementMatchCandidates) return 'statement_match_candidates'
  if (input.hasBalanceConflict || input.balanceDifferenceCents !== null) {
    return 'balance_mismatch'
  }
  return 'blocked'
}

export function classifyImportReviewGuidance(
  input: ImportReviewGuidanceInput,
): ImportReviewGuidance {
  const base = {
    targetType: input.targetType,
    message: input.validationMessage,
  }
  const reason = input.reasonCode ?? derivedImportReviewReason(input)
  switch (reason) {
    case 'ready':
      return {
        ...base,
        kind: reason,
        mode:
          input.validationStatus === 'reconciled' ? 'reconciled' : 'imported',
      }
    case 'needs_balance':
      return {
        ...base,
        kind: reason,
        mode:
          input.validationStatus === 'warning' ? 'manual_review' : 'imported',
        sourceType:
          input.parser === 'csv'
            ? 'csv'
            : input.parser === 'ofx'
              ? 'ofx'
              : 'file',
        parsedTransactionCount: input.parsedTransactionCount,
      }
    case 'needs_manual_review':
      return {
        ...base,
        kind: reason,
        reason:
          input.sourceTransactionCount === null
            ? 'unreliable_count'
            : 'missing_anchor',
        parsedTransactionCount: input.parsedTransactionCount,
      }
    case 'invalid_rows':
      return {
        ...base,
        kind: reason,
        invalidTransactionCount: input.invalidTransactionCount,
      }
    case 'balance_mismatch':
      return {
        ...base,
        kind: reason,
        balanceDifferenceCents: input.balanceDifferenceCents,
      }
    case 'blocked':
      return {
        ...base,
        kind: reason,
        reason: input.hasStatementCurrencyMismatch
          ? 'currency_mismatch'
          : 'generic',
      }
    default:
      return { ...base, kind: reason }
  }
}

interface ImportReviewGuidanceCopy {
  title: string
  explanation: string
  steps: string[]
}

interface ImportReviewGuidanceCopyContext {
  targetName: string
  period: string
  totals: string
  currency?: string
}

type GuidanceKind = ImportReviewGuidance['kind']
type GuidanceFor<TKind extends GuidanceKind> = Extract<
  ImportReviewGuidance,
  { kind: TKind }
>
type GuidanceCopyFactories = {
  [Kind in GuidanceKind]: (
    guidance: GuidanceFor<Kind>,
    context: ImportReviewGuidanceCopyContext,
  ) => ImportReviewGuidanceCopy
}

function importedGuidance(
  guidance: Pick<ImportReviewGuidance, 'message' | 'targetType'>,
): ImportReviewGuidanceCopy {
  return {
    title: 'Arquivo lido com sucesso',
    explanation:
      guidance.message ??
      'Os lançamentos foram lidos e podem ser consolidados. Este arquivo não fornece sozinho um saldo reconciliado.',
    steps: [
      'Revise as categorias e as transferências abaixo.',
      'Clique em Consolidar para incluir as transações.',
      guidance.targetType === 'account'
        ? 'Depois, use Atualizar saldo na página Contas para informar o valor exibido pelo banco.'
        : 'Quando a fatura fechar, use Confirmar fatura na página Cartões.',
    ],
  }
}

function manualReviewSteps(
  guidance: Pick<ImportReviewGuidance, 'targetType'> & {
    parsedTransactionCount: number
  },
  context: ImportReviewGuidanceCopyContext,
) {
  const targetKind = guidance.targetType === 'account' ? 'conta' : 'cartão'
  return [
    `Confirme que o arquivo pertence à ${targetKind} ${context.targetName}.`,
    `Compare com o extrato original: período ${context.period}, ${guidance.parsedTransactionCount} lançamentos, ${context.totals}.`,
    'Se estiver correto, marque a confirmação abaixo e consolide. Se algo não conferir, rejeite o lote e envie o extrato correto.',
  ]
}

function blockedGuidance(
  message: string | null,
  steps: string[],
): ImportReviewGuidanceCopy {
  return {
    title: 'Este lote não pode ser consolidado',
    explanation:
      message ??
      'A auditoria encontrou uma divergência que precisa ser corrigida.',
    steps,
  }
}

export const importReviewGuidanceCopy = {
  ready: (guidance) =>
    guidance.mode === 'imported'
      ? importedGuidance(guidance)
      : {
          title: 'Conferência automática concluída',
          explanation:
            guidance.message ??
            'A contagem, as movimentações e os saldos conferem.',
          steps: [
            'Revise as categorias dos lançamentos abaixo.',
            'Clique em Consolidar para incluir as transações nos relatórios.',
          ],
        },
  needs_balance: (guidance, context) => {
    if (guidance.mode === 'imported') return importedGuidance(guidance)
    const sourceKind =
      guidance.sourceType === 'csv'
        ? 'CSV'
        : guidance.sourceType === 'ofx'
          ? 'OFX'
          : 'arquivo'
    return {
      title: 'Confira estes dados antes de consolidar',
      explanation:
        guidance.targetType === 'account'
          ? `Os ${guidance.parsedTransactionCount} lançamentos foram lidos, mas este ${sourceKind} não informa o saldo final. Sem esse valor, o sistema não consegue provar que as movimentações fecham o saldo da conta.`
          : `Os ${guidance.parsedTransactionCount} lançamentos foram lidos, mas este ${sourceKind} não informa o total da fatura. Sem esse valor, o sistema não consegue conferir as compras e os créditos.`,
      steps: manualReviewSteps(guidance, context),
    }
  },
  needs_manual_review: (guidance, context) => ({
    title: 'Confira estes dados antes de consolidar',
    explanation:
      guidance.reason === 'unreliable_count'
        ? 'O arquivo informa um saldo final, mas não traz uma contagem confiável dos lançamentos. Por isso, a conferência precisa ser manual.'
        : `Os ${guidance.parsedTransactionCount} lançamentos foram lidos, mas ainda não existe um saldo anterior compatível para conferir o saldo final deste período.`,
    steps: manualReviewSteps(guidance, context),
  }),
  pending_correction: (guidance) =>
    blockedGuidance(guidance.message, [
      'Compare a nova observação com o lançamento atual.',
      'Aceite a correção ou mantenha o original usando as ações abaixo.',
      'Se aceitar, confira novamente os saldos posteriores indicados pelo app.',
    ]),
  identical_file: (guidance, context) =>
    blockedGuidance(guidance.message, [
      `Confirme se ${context.targetName} é o destino correto para este arquivo.`,
      'Rejeite este lote. Depois, crie um novo lote e escolha a conta ou o cartão correto.',
    ]),
  destination_conflict: (guidance, context) =>
    blockedGuidance(guidance.message, [
      `Confirme se ${context.targetName} é o destino correto para este arquivo.`,
      'Rejeite este lote. Depois, crie um novo lote e escolha a conta ou o cartão correto.',
    ]),
  missing_statement_transactions: (guidance) =>
    blockedGuidance(guidance.message, [
      'Confira as autorizações listadas em “não constam na fatura”.',
      'Se foram canceladas ou expiraram, confirme a ausência. O app preservará essa decisão na auditoria.',
      'Depois, revise as categorias restantes e clique em Consolidar.',
    ]),
  statement_match_candidates: (guidance) =>
    blockedGuidance(guidance.message, [
      'Compare as linhas do PDF com os lançamentos pendentes sugeridos abaixo.',
      'Clique em Vincular no par correto. A data, a descrição ou o valor do lançamento serão atualizados com auditoria.',
      'Depois que todas as diferenças forem resolvidas, revise as categorias e clique em Consolidar.',
    ]),
  invalid_rows: (guidance) =>
    blockedGuidance(guidance.message, [
      'Rejeite este lote e exporte o extrato novamente. Prefira OFX ou CSV.',
      'Envie o novo arquivo e confira se todos os lançamentos foram lidos.',
    ]),
  balance_mismatch: (guidance, context) => {
    const targetKind = guidance.targetType === 'account' ? 'conta' : 'cartão'
    return blockedGuidance(guidance.message, [
      `Confira se o arquivo pertence à ${targetKind} ${context.targetName}.`,
      guidance.balanceDifferenceCents === null
        ? 'Os saldos não conferem. Rejeite o lote e obtenha um novo extrato antes de tentar novamente.'
        : `O saldo difere em ${formatCurrency(Math.abs(guidance.balanceDifferenceCents), context.currency)}. Rejeite o lote e obtenha um novo extrato antes de tentar novamente.`,
    ])
  },
  blocked: (guidance) =>
    guidance.reason === 'currency_mismatch'
      ? blockedGuidance(
          'Uma linha da fatura e o lançamento com o mesmo identificador estão em moedas diferentes.',
          [
            'Rejeite este lote e confira a moeda do arquivo e do cartão.',
            'Corrija a origem dos dados e importe a fatura novamente.',
          ],
        )
      : blockedGuidance(guidance.message, [
          'Rejeite este lote e confira se selecionou a conta ou o cartão correto.',
          'Exporte o extrato novamente, prefira OFX ou CSV, e crie um novo lote.',
        ]),
} satisfies GuidanceCopyFactories

export function effectiveImportReviewValidationMessage(input: {
  persistedReason: ImportAuditReasonCode | null
  effectiveReason: ImportAuditReasonCode | null
  persistedMessage: string | null
}) {
  return validationMessageForReason(input)
}

type ImportCoverageSource =
  'metadata' | 'filename' | 'user' | 'activity' | 'unknown'

interface ImportCoverageProvenance {
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

export const importCoverageProvenanceCopy: Record<
  ImportCoverageSource,
  string
> = {
  filename: 'Período identificado no nome do arquivo. ',
  metadata: 'Período informado pelo banco. ',
  user: 'Período confirmado por você. ',
  activity: 'Somente dias com movimentação; não prova cobertura completa. ',
  unknown: 'Somente dias com movimentação; não prova cobertura completa. ',
}

type ImportBalanceReview =
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

export function getImportBalanceReviewCopy(
  balanceReview: ImportBalanceReview,
  currency?: string,
) {
  switch (balanceReview.kind) {
    case 'difference':
      return `Diferença de saldo: ${formatCurrency(balanceReview.differenceCents, currency)}.`
    case 'missing':
      return balanceReview.targetType === 'account'
        ? 'Saldo final não informado.'
        : 'Total da fatura não informado.'
    case 'missing_anchor':
      return 'Sem saldo anterior compatível.'
  }
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
  return statusIsCommittable(status, manualReviewConfirmed)
}
