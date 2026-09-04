/**
 * Detecção de recorrências a partir dos lançamentos reais.
 *
 * Cálculo puro: agrupa por estabelecimento, mede a cadência pelos intervalos
 * entre pagamentos e a estabilidade do valor. O resultado é uma fila de
 * candidatos para a pessoa revisar e aprovar; nada é criado automaticamente.
 */
import { normalizeDescription } from './finance'
import {
  merchantSignature,
  transactionEligibleForRecurrence,
} from './recurrence-book'
import type { RecurrenceReconciliationType } from './recurrence-book'
import {
  LOOKBACK_DAYS,
  addRecurrencePeriod,
  median,
  shiftDays,
} from './recurrence-schedule'

const DAY_MS = 86_400_000

export type DetectionTransaction = {
  id: string
  postedAt: string
  amountCents: number
  currency: string
  description: string
  status: 'pending' | 'confirmed' | 'excluded'
  accountId: string | null
  creditCardId: string | null
  categoryId: string | null
  counterpartyAccountId: string | null
  reconciliationTypes?: ReadonlySet<RecurrenceReconciliationType> | null
}

export type DetectedRecurrence = {
  /** Identidade estável do candidato: assinatura + direção + moeda. */
  key: string
  signature: string
  name: string
  direction: 'income' | 'expense'
  currency: string
  frequency: 'monthly' | 'yearly'
  amountMode: 'fixed' | 'variable'
  typicalAmountCents: number
  minAmountCents: number
  maxAmountCents: number
  accountId: string | null
  creditCardId: string | null
  categoryId: string | null
  nextExpectedDate: string
  /** 0–100. Cresce com o número de pagamentos e a regularidade. */
  confidence: number
  transactions: Array<{ id: string; postedAt: string; amountCents: number }>
}

export function detectionKey(
  signature: string,
  direction: 'income' | 'expense',
) {
  return `${signature}|${direction}`
}

function daysBetween(left: string, right: string) {
  return Math.round(
    (Date.parse(`${right}T12:00:00Z`) - Date.parse(`${left}T12:00:00Z`)) /
      DAY_MS,
  )
}

function mostFrequent<T>(values: T[]): T | null {
  const counts = new Map<T, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best: T | null = null
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}

/** Nome legível a partir da descrição mais comum do grupo. */
export function displayNameFromDescriptions(descriptions: string[]) {
  const cleaned = descriptions.map((value) =>
    value
      .replace(/^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}\*/, '')
      .replace(/\s+-\s+parcela\s+\d+\/\d+$/i, '')
      .trim(),
  )
  const chosen = mostFrequent(cleaned) ?? ''
  if (chosen !== chosen.toUpperCase() || !/[A-Z]/.test(chosen)) return chosen
  return chosen
    .toLowerCase()
    .replace(
      /(^|[\s(/-])([a-zà-ú])/g,
      (_, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`,
    )
}

const CADENCES = [
  { frequency: 'monthly' as const, min: 24, max: 37, spread: 7, minCount: 2 },
  { frequency: 'yearly' as const, min: 350, max: 380, spread: 20, minCount: 2 },
]

export function detectRecurrences(input: {
  transactions: DetectionTransaction[]
  /** Transações já vinculadas a recorrências existentes. */
  excludedTransactionIds?: Set<string>
  /** Assinaturas de recorrências já cadastradas (nome e aliases confirmados). */
  knownSignatures?: Set<string>
  /** Candidatos que a pessoa mandou ignorar (`detectionKey`). */
  ignoredKeys?: Set<string>
  /** Categorias que nunca formam recorrência (transferências, pagamento de fatura). */
  excludedCategoryIds?: Set<string>
  today?: string
}): DetectedRecurrence[] {
  const today = input.today ?? new Date().toISOString().slice(0, 10)
  const excludedIds = input.excludedTransactionIds ?? new Set<string>()
  const knownSignatures = input.knownSignatures ?? new Set<string>()
  const ignoredKeys = input.ignoredKeys ?? new Set<string>()
  const excludedCategories = input.excludedCategoryIds ?? new Set<string>()

  type Row = DetectionTransaction & {
    signature: string
    direction: 'income' | 'expense'
  }
  const rows: Row[] = []
  for (const transaction of input.transactions) {
    if (transaction.status !== 'confirmed') continue
    if (transaction.amountCents === 0) continue
    if (excludedIds.has(transaction.id)) continue
    if (!transactionEligibleForRecurrence(transaction)) continue
    if (
      transaction.categoryId &&
      excludedCategories.has(transaction.categoryId)
    ) {
      continue
    }
    const signature = merchantSignature(transaction.description)
    if (signature.length < 3 || !/[a-z]/.test(signature)) continue
    rows.push({
      ...transaction,
      signature,
      direction: transaction.amountCents < 0 ? 'expense' : 'income',
    })
  }

  // Tarifa e cashback do banco aparecem como pares entrada/saída no mesmo dia,
  // com a mesma descrição. Não são recorrências da família.
  const noisySignatures = new Set<string>()
  const byDay = new Map<string, Set<'income' | 'expense'>>()
  for (const row of rows) {
    const dayKey = `${row.signature}|${row.currency}|${row.postedAt}`
    const directions = byDay.get(dayKey) ?? new Set()
    directions.add(row.direction)
    byDay.set(dayKey, directions)
  }
  const pairCounts = new Map<string, number>()
  for (const [dayKey, directions] of byDay) {
    if (directions.size < 2) continue
    const signature = dayKey.split('|')[0]
    pairCounts.set(signature, (pairCounts.get(signature) ?? 0) + 1)
  }
  for (const [signature, count] of pairCounts) {
    if (count >= 2) noisySignatures.add(signature)
  }

  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    if (noisySignatures.has(row.signature)) continue
    if (knownSignatures.has(row.signature)) continue
    if (ignoredKeys.has(detectionKey(row.signature, row.direction))) continue
    const groupKey = `${row.signature}|${row.direction}|${row.currency}`
    const list = groups.get(groupKey) ?? []
    list.push(row)
    groups.set(groupKey, list)
  }

  const detected: DetectedRecurrence[] = []
  for (const [groupKey, items] of groups) {
    items.sort((left, right) => left.postedAt.localeCompare(right.postedAt))
    if (items.length < 2) continue
    const months = new Set(items.map((item) => item.postedAt.slice(0, 7)))
    if (months.size < 2) continue

    const gaps = items
      .slice(1)
      .map((item, index) => daysBetween(items[index].postedAt, item.postedAt))
    const medianGap = median(gaps) ?? 0
    const cadence = CADENCES.find(
      (candidate) =>
        medianGap >= candidate.min &&
        medianGap <= candidate.max &&
        items.length >= candidate.minCount &&
        gaps.every((gap) => Math.abs(gap - medianGap) <= candidate.spread),
    )
    if (!cadence) continue

    const amounts = items.map((item) => Math.abs(item.amountCents))
    const typical = Math.round(median(amounts) ?? 0)
    const variation =
      typical > 0
        ? Math.max(...amounts.map((amount) => Math.abs(amount - typical))) /
          typical
        : 1
    if (variation > 0.25) continue
    const amountMode = variation <= 0.02 ? 'fixed' : 'variable'

    // Recorrência que parou de acontecer não vira candidato.
    const last = items[items.length - 1]
    const staleAfterDays = cadence.frequency === 'monthly' ? 75 : 400
    if (daysBetween(last.postedAt, today) > staleAfterDays) continue

    const maxDeviation = Math.max(
      ...gaps.map((gap) => Math.abs(gap - medianGap)),
    )
    const confidence = Math.max(
      30,
      Math.min(
        100,
        50 +
          15 * Math.min(items.length - 2, 3) +
          (amountMode === 'fixed' ? 5 : 0) -
          Math.max(0, maxDeviation - 2) * 2,
      ),
    )

    const anchorDay = Math.round(
      median(items.map((item) => Number(item.postedAt.slice(8, 10)))) ?? 1,
    )
    const anchor = `${last.postedAt.slice(0, 8)}${String(anchorDay).padStart(2, '0')}`
    let nextExpectedDate = addRecurrencePeriod(
      last.postedAt,
      cadence.frequency,
      anchor,
    )
    while (nextExpectedDate < shiftDays(today, -LOOKBACK_DAYS)) {
      nextExpectedDate = addRecurrencePeriod(
        nextExpectedDate,
        cadence.frequency,
        anchor,
      )
    }

    const [signature, direction] = groupKey.split('|') as [
      string,
      'income' | 'expense',
    ]
    const categoryId =
      mostFrequent(
        items
          .map((item) => item.categoryId)
          .filter(
            (value): value is string =>
              value !== null && value !== 'uncategorized',
          ),
      ) ?? null
    detected.push({
      key: groupKey,
      signature,
      name: displayNameFromDescriptions(items.map((item) => item.description)),
      direction,
      currency: last.currency,
      frequency: cadence.frequency,
      amountMode,
      typicalAmountCents: typical,
      minAmountCents: Math.min(...amounts),
      maxAmountCents: Math.max(...amounts),
      accountId: mostFrequent(items.map((item) => item.accountId)),
      creditCardId: mostFrequent(items.map((item) => item.creditCardId)),
      categoryId,
      nextExpectedDate,
      confidence,
      transactions: items.map((item) => ({
        id: item.id,
        postedAt: item.postedAt,
        amountCents: item.amountCents,
      })),
    })
  }

  return detected.sort(
    (left, right) =>
      right.confidence - left.confidence ||
      right.typicalAmountCents - left.typicalAmountCents ||
      normalizeDescription(left.name).localeCompare(
        normalizeDescription(right.name),
      ),
  )
}
