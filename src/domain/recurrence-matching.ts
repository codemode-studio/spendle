import { normalizeDescription } from './finance'

const DAY_MS = 86_400_000

export function addRecurrencePeriod(
  date: string,
  frequency: 'monthly' | 'yearly',
  scheduleAnchor = date,
) {
  const [year, month] = date.split('-').map(Number)
  const [, anchorMonth, anchorDay] = scheduleAnchor.split('-').map(Number)
  const targetYear =
    frequency === 'monthly' ? year + Math.floor(month / 12) : year + 1
  const normalizedMonth = frequency === 'monthly' ? month % 12 : anchorMonth - 1
  const lastDay = new Date(
    Date.UTC(targetYear, normalizedMonth + 1, 0),
  ).getUTCDate()
  return new Date(
    Date.UTC(targetYear, normalizedMonth, Math.min(anchorDay, lastDay)),
  )
    .toISOString()
    .slice(0, 10)
}

export const acceptedRecurrenceMatchStatuses = [
  'confirmed',
  'auto_confirmed',
] as const

export type AcceptedRecurrenceMatchStatus =
  (typeof acceptedRecurrenceMatchStatuses)[number]

export function isAcceptedRecurrenceMatchStatus(
  status: string,
): status is AcceptedRecurrenceMatchStatus {
  return acceptedRecurrenceMatchStatuses.includes(
    status as AcceptedRecurrenceMatchStatus,
  )
}

export type RecurrenceCandidate = {
  transactionId: string
  score: number
  reason: string
  evidence: {
    amount: number
    date: number
    description: number
    destination: number
    daysApart: number
    amountDifferenceCents: number
    exactLearnedAlias: boolean
  }
  autoConfirm: boolean
}

export type RecurrenceRuleInput = {
  expectedDate: string
  expectedAmountCents: number
  currency: string
  direction: 'income' | 'expense'
  amountMode: 'fixed' | 'variable'
  destinationMode: 'automatic' | 'fixed'
  accountId: string | null
  creditCardId: string | null
  dateToleranceDays: number
  amountToleranceBps: number
  autoMatchEnabled: boolean
  minimumConfirmations: number
}

export type RecurrenceReconciliationType =
  'transfer' | 'fx_transfer' | 'card_payment' | 'refund' | 'profit_distribution'

export type RecurrenceTransactionInput = {
  id: string
  postedAt: string
  amountCents: number
  currency: string
  description: string
  status: 'pending' | 'confirmed' | 'excluded'
  accountId: string | null
  creditCardId: string | null
  counterpartyAccountId?: string | null
  categoryId?: string | null
  reconciliationType?: RecurrenceReconciliationType | null
}

/**
 * Transferências entre contas próprias e pagamento de fatura só movem dinheiro
 * de lugar, então nunca pagam uma recorrência. Estornos e distribuições de
 * lucro têm efeito financeiro real: a distribuição sai da empresa e entra na
 * pessoa física, e é assim que um salário de sócio aparece no extrato.
 */
export function transactionEligibleForRecurrence(transaction: {
  counterpartyAccountId?: string | null
  reconciliationType?: RecurrenceReconciliationType | null
}) {
  const type = transaction.reconciliationType ?? null
  if (type === 'profit_distribution') return true
  if (type && type !== 'refund') return false
  return !transaction.counterpartyAccountId
}

export function pendingTransactionCoversRecurrence(input: {
  recurrenceName: string
  categoryId: string
  rule: RecurrenceRuleInput
  transaction: RecurrenceTransactionInput
}) {
  const { rule, transaction } = input
  if (
    transaction.status !== 'pending' ||
    transaction.currency !== rule.currency ||
    Math.sign(transaction.amountCents) !==
      (rule.direction === 'expense' ? -1 : 1)
  ) {
    return false
  }
  if (
    rule.destinationMode === 'fixed' &&
    ((rule.accountId && transaction.accountId !== rule.accountId) ||
      (rule.creditCardId && transaction.creditCardId !== rule.creditCardId))
  ) {
    return false
  }
  if (
    daysBetween(rule.expectedDate, transaction.postedAt) >
    rule.dateToleranceDays
  ) {
    return false
  }
  const amountDifference = Math.abs(
    Math.abs(transaction.amountCents) - rule.expectedAmountCents,
  )
  const allowedDifference =
    rule.amountMode === 'fixed'
      ? 1
      : Math.max(
          100,
          Math.round(
            (rule.expectedAmountCents * rule.amountToleranceBps) / 10_000,
          ),
        )
  if (amountDifference > allowedDifference) return false

  const transactionSignature = merchantSignature(transaction.description)
  const recurrenceSignature = merchantSignature(input.recurrenceName)
  const descriptionMatches =
    transactionSignature.length > 1 &&
    recurrenceSignature.length > 1 &&
    (transactionSignature.includes(recurrenceSignature) ||
      recurrenceSignature.includes(transactionSignature))
  return transaction.categoryId === input.categoryId || descriptionMatches
}

export type RecurrenceLearning = {
  confirmedCount: number
  aliases: string[]
  accountIds: string[]
  creditCardIds: string[]
  medianDateOffsetDays?: number
  dateSpreadDays?: number
  amountRangeCents?: { min: number; max: number }
  rejectionCount?: number
}

function daysBetween(left: string, right: string) {
  const leftTime = new Date(`${left.slice(0, 10)}T12:00:00Z`).getTime()
  const rightTime = new Date(`${right.slice(0, 10)}T12:00:00Z`).getTime()
  return Math.abs(leftTime - rightTime) / DAY_MS
}

export function merchantSignature(value: string) {
  return normalizeDescription(value)
    .replace(
      /\b(?:pix|ted|doc|pg|pagamento|pgto|compra|debito|credito|cartao|visa|mastercard)\b/g,
      ' ',
    )
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g, ' ')
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildRecurrenceCandidates(input: {
  recurrenceName: string
  rule: RecurrenceRuleInput
  transactions: RecurrenceTransactionInput[]
  learning: RecurrenceLearning
  unavailableTransactionIds?: Set<string>
}) {
  const unavailable = input.unavailableTransactionIds ?? new Set<string>()
  const expectedSign = input.rule.direction === 'expense' ? -1 : 1
  const expectedSignature = merchantSignature(input.recurrenceName)
  const aliases = new Set(input.learning.aliases.map(merchantSignature))

  const candidates = input.transactions.flatMap((transaction) => {
    if (
      transaction.status !== 'confirmed' ||
      transaction.currency !== input.rule.currency ||
      Math.sign(transaction.amountCents) !== expectedSign ||
      unavailable.has(transaction.id) ||
      !transactionEligibleForRecurrence(transaction)
    ) {
      return []
    }
    // Destino fixo: aceita o destino cadastrado e também os destinos de
    // pagamentos já confirmados. O histórico real vale mais que o cadastro.
    if (
      input.rule.destinationMode === 'fixed' &&
      (input.rule.accountId || input.rule.creditCardId)
    ) {
      const knownAccount =
        transaction.accountId !== null &&
        input.learning.accountIds.includes(transaction.accountId)
      const knownCard =
        transaction.creditCardId !== null &&
        input.learning.creditCardIds.includes(transaction.creditCardId)
      if (!knownAccount && !knownCard) return []
    }

    const rawDateOffset =
      (new Date(`${transaction.postedAt.slice(0, 10)}T12:00:00Z`).getTime() -
        new Date(`${input.rule.expectedDate}T12:00:00Z`).getTime()) /
      DAY_MS
    const learnedDateDistance = Math.abs(
      rawDateOffset - (input.learning.medianDateOffsetDays ?? 0),
    )
    const effectiveDateTolerance = input.learning.confirmedCount
      ? Math.max(2, (input.learning.dateSpreadDays ?? 0) + 2)
      : input.rule.dateToleranceDays
    const daysApart = daysBetween(input.rule.expectedDate, transaction.postedAt)
    if (learnedDateDistance > effectiveDateTolerance) return []

    const amountDifferenceCents = Math.abs(
      Math.abs(transaction.amountCents) - input.rule.expectedAmountCents,
    )
    const learnedRange = input.learning.amountRangeCents
    const absoluteAmount = Math.abs(transaction.amountCents)
    const learnedPadding = learnedRange
      ? Math.max(100, Math.round((learnedRange.max - learnedRange.min) * 0.25))
      : 0
    const outsideLearnedRange = learnedRange
      ? absoluteAmount < learnedRange.min - learnedPadding ||
        absoluteAmount > learnedRange.max + learnedPadding
      : false
    if (outsideLearnedRange) return []
    const allowedDifference = learnedRange
      ? Math.max(
          1,
          Math.abs(input.rule.expectedAmountCents - learnedRange.min) +
            learnedPadding,
          Math.abs(learnedRange.max - input.rule.expectedAmountCents) +
            learnedPadding,
        )
      : input.rule.amountMode === 'fixed'
        ? 1
        : Math.max(
            100,
            Math.round(
              (input.rule.expectedAmountCents * input.rule.amountToleranceBps) /
                10_000,
            ),
          )
    if (amountDifferenceCents > allowedDifference) return []

    const amountScore = Math.round(
      40 * (1 - amountDifferenceCents / Math.max(1, allowedDifference)),
    )
    const dateScore = Math.round(
      25 * (1 - learnedDateDistance / Math.max(1, effectiveDateTolerance)),
    )
    const signature = merchantSignature(transaction.description)
    const exactLearnedAlias = signature.length > 1 && aliases.has(signature)
    const expectedWords = new Set(
      expectedSignature.split(' ').filter((word) => word.length >= 4),
    )
    const sharesDistinctiveWord = signature
      .split(' ')
      .some((word) => expectedWords.has(word))
    const descriptionScore = exactLearnedAlias
      ? 35
      : signature &&
          expectedSignature &&
          (signature.includes(expectedSignature) ||
            expectedSignature.includes(signature) ||
            sharesDistinctiveWord)
        ? 25
        : 0
    const destinationScore =
      (transaction.accountId &&
        input.learning.accountIds.includes(transaction.accountId)) ||
      (transaction.creditCardId &&
        input.learning.creditCardIds.includes(transaction.creditCardId))
        ? 15
        : 0
    const negativeEvidencePenalty = Math.min(
      12,
      (input.learning.rejectionCount ?? 0) * 3,
    )
    const positiveEvidenceScore = Math.min(
      100,
      amountScore + dateScore + descriptionScore + destinationScore,
    )
    const score = Math.max(0, positiveEvidenceScore - negativeEvidencePenalty)
    if (score < 75) return []

    return [
      {
        transactionId: transaction.id,
        score,
        reason: [
          `valor ${amountDifferenceCents === 0 ? 'exato' : 'compatível'}`,
          `data a ${Math.round(daysApart)} dia(s)`,
          exactLearnedAlias
            ? 'estabelecimento já confirmado'
            : descriptionScore
              ? 'descrição semelhante'
              : null,
          destinationScore ? 'destino já observado' : null,
        ]
          .filter(Boolean)
          .join(' · '),
        evidence: {
          amount: amountScore,
          date: dateScore,
          description: descriptionScore,
          destination: destinationScore,
          daysApart,
          amountDifferenceCents,
          exactLearnedAlias,
        },
        autoConfirm: false,
      } satisfies RecurrenceCandidate,
    ]
  })

  candidates.sort((left, right) => right.score - left.score)
  const ambiguous =
    candidates.length > 1 && candidates[0].score - candidates[1].score < 10
  return candidates.map((candidate, index) => ({
    ...candidate,
    autoConfirm:
      index === 0 &&
      !ambiguous &&
      input.rule.autoMatchEnabled &&
      input.learning.confirmedCount >= input.rule.minimumConfirmations &&
      candidate.score >= 95 &&
      candidate.evidence.exactLearnedAlias &&
      candidate.evidence.destination > 0 &&
      input.transactions.find((item) => item.id === candidate.transactionId)
        ?.status === 'confirmed',
  }))
}
