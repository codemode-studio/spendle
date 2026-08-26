export interface ImportAuditTransaction {
  amountCents: number
  postedAt: string
}

export {
  identifyDuplicateReasons,
  type CanonicalIdentity as ImportIdentity,
  type DuplicateReason,
} from './canonicalization'

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
        status: 'divergent' as const,
        expectedBalanceCents,
        balanceDifferenceCents,
        message:
          'Saldo inicial, movimentações e saldo final não fecham. A consolidação foi bloqueada.',
      }
    }
    return {
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
        status: 'divergent' as const,
        expectedBalanceCents,
        balanceDifferenceCents,
        message:
          'A soma das compras e créditos não corresponde ao total da fatura.',
      }
    }
    return {
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
        status: 'divergent' as const,
        expectedBalanceCents,
        balanceDifferenceCents,
        message:
          'O saldo calculado não corresponde ao saldo informado pelo extrato. A consolidação foi bloqueada.',
      }
    }

    return {
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
      status: 'imported' as const,
      expectedBalanceCents: input.closingBalanceCents,
      balanceDifferenceCents: null,
      message:
        'Importação concluída. Este saldo estabelece o primeiro ponto de controle; a reconciliação começa no próximo saldo datado.',
    }
  }

  if (input.targetType === 'account' && input.closingBalanceCents === null) {
    return {
      status: 'imported' as const,
      expectedBalanceCents: null,
      balanceDifferenceCents: null,
      message:
        'Todos os lançamentos foram lidos. O arquivo não informa saldo final; confirme um saldo datado na conta para iniciar a reconciliação.',
    }
  }

  if (input.targetType === 'card' && input.closingBalanceCents === null) {
    return {
      status: 'imported' as const,
      expectedBalanceCents: null,
      balanceDifferenceCents: null,
      message:
        'Todos os lançamentos foram lidos como provisórios. Confirme o total quando a fatura fechar.',
    }
  }

  return {
    status: 'warning' as const,
    expectedBalanceCents: null,
    balanceDifferenceCents: null,
    message: hasCompleteCount
      ? 'Todos os lançamentos foram lidos, mas não há um saldo anterior compatível. Importe um extrato anterior com saldo ou confira este lote manualmente.'
      : 'O arquivo não oferece contagem e saldos suficientes. Confira a conta, o período e os totais antes de consolidar.',
  }
}

export function canCommitImportAudit(
  status: 'imported' | 'reconciled' | 'warning' | 'divergent',
  manualReviewConfirmed: boolean,
) {
  return (
    status === 'imported' ||
    status === 'reconciled' ||
    (status === 'warning' && manualReviewConfirmed)
  )
}
