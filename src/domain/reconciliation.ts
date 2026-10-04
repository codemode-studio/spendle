import {
  isCardPaymentDescription,
  isIdentifiedCardPaymentReceipt,
} from './card-payment'
import { minorUnitsToMajor } from './currency'
import { normalizeDescription } from './finance'
import { daysBetween } from './period'

export interface ReconciliationTransaction {
  id: string
  amountCents: number
  currency: string
  postedAt: string
  description: string
  accountId: string | null
  creditCardId: string | null
  counterpartyAccountId?: string | null
  // Provider classification of the observed fact (Pluggy category), if any.
  providerCategory?: string | null
  scopeType?: 'household' | 'person' | 'company_br' | 'company_us' | null
}

export interface ReconciliationSuggestion {
  type:
    | 'transfer'
    | 'fx_transfer'
    | 'card_payment'
    | 'refund'
    | 'profit_distribution'
  transactionIds: [string, string]
  confidence: number
  reason: string
  exchangeRateMicros?: number
  autoConfirm?: boolean
}

export interface LearnedTransferRule {
  pattern: string
  accountId: string | null
  counterpartyAccountId: string | null
  direction: 'incoming' | 'outgoing' | null
  categoryId: string
}

export function matchLearnedTransferRule(input: {
  description: string
  amountCents: number
  sourceAccountId: string | null
  rules: LearnedTransferRule[]
}) {
  if (!input.sourceAccountId) return null
  const normalized = normalizeDescription(input.description)
  const direction = input.amountCents < 0 ? 'outgoing' : 'incoming'
  const rule = input.rules.find(
    (candidate) =>
      candidate.accountId === input.sourceAccountId &&
      candidate.counterpartyAccountId !== null &&
      candidate.counterpartyAccountId !== input.sourceAccountId &&
      candidate.direction === direction &&
      normalized.includes(candidate.pattern),
  )
  return rule
    ? {
        categoryId: rule.categoryId,
        counterpartyAccountId: rule.counterpartyAccountId,
      }
    : null
}

type ScopeType = 'household' | 'person' | 'company_br' | 'company_us' | null

export function detectOwnedTransferCategory(input: {
  amountCents: number
  description: string
  raw?: unknown
  sourceScopeName: string
  sourceScopeType: ScopeType
}) {
  const rawValues =
    input.raw && typeof input.raw === 'object' && !Array.isArray(input.raw)
      ? Object.values(input.raw).filter(
          (value): value is string | number =>
            typeof value === 'string' || typeof value === 'number',
        )
      : []
  const transactionText = normalizeDescription(
    [input.description, ...rawValues].join(' '),
  )
  const transferLike =
    /\b(?:pix|ted|doc|transferencia)\b.*\b(?:enviado|enviada|recebido|recebida|envio|recebimento)\b/.test(
      transactionText,
    )
  if (!transferLike) return null

  const counterparty = normalizeDescription(input.description)
  const sourceScopeName = normalizeDescription(input.sourceScopeName)
  if (counterparty.length < 8 || !sourceScopeName.includes(counterparty)) {
    return null
  }

  const companySource =
    input.sourceScopeType === 'company_br' ||
    input.sourceScopeType === 'company_us'
  if (companySource && input.amountCents < 0) {
    return 'profit_distribution_income' as const
  }
  return 'transfer' as const
}

function merchantDescription(value: string) {
  return normalizeDescription(value)
    .replace(/^(estorno|cancelamento|credito|reembolso)\s+/, '')
    .replace(/\s+(estorno|cancelamento|credito|reembolso)$/, '')
    .trim()
}

function sameAmount(
  left: ReconciliationTransaction,
  right: ReconciliationTransaction,
) {
  return (
    left.currency === right.currency &&
    Math.abs(left.amountCents) === Math.abs(right.amountCents)
  )
}

function differentTargets(
  left: ReconciliationTransaction,
  right: ReconciliationTransaction,
) {
  return (
    left.accountId !== right.accountId ||
    left.creditCardId !== right.creditCardId
  )
}

// Equal amounts between accounts a person already linked by a confirmed
// transfer.
function isLearnedAccountPair(
  left: ReconciliationTransaction,
  right: ReconciliationTransaction,
  days: number,
) {
  const source = left.amountCents < 0 ? left : right
  const destination = left.amountCents < 0 ? right : left
  return (
    sameAmount(left, right) &&
    days <= 3 &&
    differentTargets(left, right) &&
    Boolean(source.accountId && destination.accountId) &&
    (source.counterpartyAccountId === destination.accountId ||
      destination.counterpartyAccountId === source.accountId)
  )
}

function crossesBrazilianCompanyBoundary(
  left: ReconciliationTransaction,
  right: ReconciliationTransaction,
) {
  return (
    (left.scopeType === 'company_br') !== (right.scopeType === 'company_br')
  )
}

function isCardPaymentPair(
  left: ReconciliationTransaction,
  right: ReconciliationTransaction,
  days: number,
) {
  return (
    sameAmount(left, right) &&
    days <= 5 &&
    differentTargets(left, right) &&
    Boolean(left.creditCardId || right.creditCardId) &&
    (isCardPaymentDescription(left.description) ||
      isCardPaymentDescription(right.description))
  )
}

function cardPaymentReceipt(
  left: ReconciliationTransaction,
  right: ReconciliationTransaction,
) {
  return [left, right].find(
    (transaction) => transaction.creditCardId && transaction.amountCents > 0,
  )
}

/**
 * Whether an automatically confirmed match still holds for the current facts
 * of its two rows: the same pair evidence that allowed the automatic
 * confirmation. Competition from rows that arrived later does not undo a
 * settlement that is still valid; a correction that changes the facts does.
 */
export function isAutomaticMatchStillValid(
  type: ReconciliationSuggestion['type'],
  left: ReconciliationTransaction,
  right: ReconciliationTransaction,
) {
  const leftSign = Math.sign(left.amountCents)
  const rightSign = Math.sign(right.amountCents)
  if (!leftSign || !rightSign || leftSign === rightSign) return false
  const days = daysBetween(left.postedAt, right.postedAt, {
    inclusive: false,
    absolute: true,
  })
  if (type === 'card_payment') {
    const receipt = cardPaymentReceipt(left, right)
    return Boolean(
      isCardPaymentPair(left, right, days) &&
      receipt &&
      isIdentifiedCardPaymentReceipt(receipt),
    )
  }
  if (type === 'transfer') {
    return (
      isLearnedAccountPair(left, right, days) &&
      !crossesBrazilianCompanyBoundary(left, right)
    )
  }
  return false
}

/**
 * Category a confirmed match assigns to both of its rows, or null when the
 * match keeps the rows' own categories (a refund).
 */
export function reconciliationCategory(type: ReconciliationSuggestion['type']) {
  if (type === 'card_payment') return 'card_payment'
  if (type === 'profit_distribution') return 'profit_distribution_income'
  if (type === 'refund') return null
  return 'transfer'
}

export function buildReconciliationSuggestions(
  transactions: ReconciliationTransaction[],
) {
  const suggestions: ReconciliationSuggestion[] = []

  // Keep original pair order: equal-priority suggestions use it to break ties.
  const dated = transactions.map((transaction, index) => ({
    index,
    day: daysBetween('1970-01-01', transaction.postedAt, { inclusive: false }),
    sign: Math.sign(transaction.amountCents),
  }))
  const bySign = new Map<number, typeof dated>()
  for (const entry of dated) {
    const entries = bySign.get(entry.sign) ?? []
    entries.push(entry)
    bySign.set(entry.sign, entries)
  }
  for (const entries of bySign.values()) entries.sort((a, b) => a.day - b.day)

  for (const entry of dated) {
    const candidateIndices: number[] = []
    for (const [sign, entries] of bySign) {
      if (sign === entry.sign) continue
      let low = 0
      let high = entries.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (entries[middle].day < entry.day - 120) low = middle + 1
        else high = middle
      }
      for (let index = low; index < entries.length; index += 1) {
        const candidate = entries[index]
        if (candidate.day > entry.day + 120) break
        if (candidate.index > entry.index)
          candidateIndices.push(candidate.index)
      }
    }
    candidateIndices.sort((a, b) => a - b)
    for (const rightIndex of candidateIndices) {
      const left = transactions[entry.index]
      const right = transactions[rightIndex]
      const days = Math.abs(entry.day - dated[rightIndex].day)

      const pairSameAmount = sameAmount(left, right)
      const pairDifferentTargets = differentTargets(left, right)

      const transferSource = left.amountCents < 0 ? left : right
      const transferDestination = left.amountCents < 0 ? right : left
      const crossesCompanyBoundary = crossesBrazilianCompanyBoundary(
        left,
        right,
      )

      if (isLearnedAccountPair(left, right, days)) {
        suggestions.push({
          type: crossesCompanyBoundary ? 'profit_distribution' : 'transfer',
          transactionIds: [left.id, right.id],
          confidence: crossesCompanyBoundary ? 97 : 100,
          reason: crossesCompanyBoundary
            ? 'Contas PJ e PF já relacionadas; a natureza da distribuição ainda precisa ser confirmada.'
            : 'Contas vinculadas por uma confirmação manual anterior.',
          autoConfirm: !crossesCompanyBoundary,
        })
        continue
      }

      if (isCardPaymentPair(left, right, days)) {
        suggestions.push({
          type: 'card_payment',
          transactionIds: [left.id, right.id],
          confidence: 96,
          reason: 'Pagamento de fatura com valor correspondente.',
        })
        continue
      }

      if (
        pairSameAmount &&
        days <= 3 &&
        pairDifferentTargets &&
        left.currency === right.currency
      ) {
        suggestions.push({
          type: crossesCompanyBoundary ? 'profit_distribution' : 'transfer',
          transactionIds: [left.id, right.id],
          confidence: crossesCompanyBoundary
            ? days === 0
              ? 97
              : 94
            : days === 0
              ? 98
              : 92,
          reason: crossesCompanyBoundary
            ? 'Saída PJ e entrada PF de mesmo valor, sugerida como distribuição de lucros.'
            : 'Entradas e saídas de mesmo valor em contas diferentes.',
        })
        continue
      }

      const linkedFxAccounts = Boolean(
        transferSource.accountId &&
        transferDestination.accountId &&
        (transferSource.counterpartyAccountId ===
          transferDestination.accountId ||
          transferDestination.counterpartyAccountId ===
            transferSource.accountId),
      )
      const fxDescription = (description: string) =>
        /\b(?:cambio|remessa|resgate|conversao|exchange|conversion)\b/.test(
          normalizeDescription(description),
        )
      const hasFxEvidence =
        linkedFxAccounts ||
        (fxDescription(left.description) && fxDescription(right.description))
      if (
        days <= 3 &&
        pairDifferentTargets &&
        left.currency !== right.currency &&
        left.accountId &&
        right.accountId &&
        !left.creditCardId &&
        !right.creditCardId &&
        hasFxEvidence
      ) {
        const source = Math.abs(
          minorUnitsToMajor(left.amountCents, left.currency),
        )
        const destination = Math.abs(
          minorUnitsToMajor(right.amountCents, right.currency),
        )
        const rate = destination / Math.max(1, source)
        const normalizedRate = rate < 1 ? 1 / rate : rate
        if (normalizedRate >= 2 && normalizedRate <= 10) {
          suggestions.push({
            type: 'fx_transfer',
            transactionIds: [left.id, right.id],
            confidence: 82,
            reason:
              'Remessa entre contas com indicação de câmbio e valores compatíveis.',
            exchangeRateMicros: Math.round(normalizedRate * 1_000_000),
          })
          continue
        }
      }

      const sameMerchant =
        merchantDescription(left.description) ===
        merchantDescription(right.description)
      if (pairSameAmount && sameMerchant && days <= 120) {
        suggestions.push({
          type: 'refund',
          transactionIds: [left.id, right.id],
          confidence: days <= 30 ? 92 : 82,
          reason: 'Crédito e débito do mesmo estabelecimento e valor.',
        })
      }
    }
  }

  const priority: Record<ReconciliationSuggestion['type'], number> = {
    card_payment: 0,
    refund: 1,
    fx_transfer: 2,
    profit_distribution: 3,
    transfer: 4,
  }
  // Auto-confirm a bill payment only when neither side could pair with any
  // other candidate and the card side is an identified payment receipt; two
  // cards with equal totals, refunds and unidentified credits stay a manual
  // decision.
  const byId = new Map(
    transactions.map((transaction) => [transaction.id, transaction]),
  )
  const cardPaymentUses = new Map<string, number>()
  for (const suggestion of suggestions) {
    if (suggestion.type !== 'card_payment') continue
    for (const transactionId of suggestion.transactionIds) {
      cardPaymentUses.set(
        transactionId,
        (cardPaymentUses.get(transactionId) ?? 0) + 1,
      )
    }
  }
  for (const suggestion of suggestions) {
    if (suggestion.type !== 'card_payment') continue
    const [left, right] = suggestion.transactionIds.map((transactionId) =>
      byId.get(transactionId),
    )
    const cardReceipt = left && right && cardPaymentReceipt(left, right)
    if (
      cardReceipt &&
      isIdentifiedCardPaymentReceipt(cardReceipt) &&
      suggestion.transactionIds.every(
        (transactionId) => cardPaymentUses.get(transactionId) === 1,
      )
    ) {
      suggestion.autoConfirm = true
      suggestion.confidence = 100
      suggestion.reason =
        'Pagamento de fatura com valor e data correspondentes, sem outro candidato.'
    }
  }
  const matchedIds = new Set<string>()
  return suggestions
    .sort(
      (left, right) =>
        priority[left.type] - priority[right.type] ||
        right.confidence - left.confidence,
    )
    .filter((suggestion) => {
      if (
        suggestion.transactionIds.some((transactionId) =>
          matchedIds.has(transactionId),
        )
      ) {
        return false
      }
      suggestion.transactionIds.forEach((transactionId) =>
        matchedIds.add(transactionId),
      )
      return true
    })
}
