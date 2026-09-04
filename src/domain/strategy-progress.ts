import type { AllocationBucket } from './finance'

export type BucketAmounts = Record<AllocationBucket, number>

export type BucketStatus = 'on_track' | 'attention' | 'over' | 'done' | 'behind'

export type StrategyBucketProgress = {
  bucket: AllocationBucket
  label: string
  /** Gasto (essenciais, estilo de vida) ou aporte (investimentos, reserva). */
  kind: 'spending' | 'contribution'
  targetCents: number
  actualCents: number
  /** Gasto: realizado + pendências e recorrências previstas. Aporte: realizado. */
  projectedCents: number
  /** Positivo: ainda cabe. Negativo: passou da meta. */
  remainingCents: number
  ratio: number
  status: BucketStatus
}

export type StrategyProgress = {
  month: string
  /** Fração do mês já decorrida, de 0 a 1. */
  elapsed: number
  dayOfMonth: number | null
  daysInMonth: number
  monthEnded: boolean
  buckets: StrategyBucketProgress[]
  spending: { targetCents: number; actualCents: number; projectedCents: number }
  income: { baseCents: number; actualCents: number }
  overall: 'on_track' | 'attention' | 'over'
}

export const bucketLabels: Record<AllocationBucket, string> = {
  essential: 'Essenciais',
  lifestyle: 'Estilo de vida',
  investment: 'Investimentos',
  reserve: 'Reserva',
}

export const bucketStatusLabels: Record<BucketStatus, string> = {
  on_track: 'No ritmo',
  attention: 'Atenção',
  over: 'Estourou',
  done: 'Meta batida',
  behind: 'Abaixo da meta',
}

export function daysInMonth(month: string) {
  const [year, monthNumber] = month.split('-').map(Number)
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
}

/** Quanto do mês já passou, considerando o dia de hoje inclusive. */
export function monthElapsed(month: string, today: string) {
  const total = daysInMonth(month)
  if (today.slice(0, 7) < month) return { elapsed: 0, dayOfMonth: null, total }
  if (today.slice(0, 7) > month) return { elapsed: 1, dayOfMonth: null, total }
  const day = Number(today.slice(8, 10))
  return { elapsed: Math.min(1, day / total), dayOfMonth: day, total }
}

const spendingBuckets: AllocationBucket[] = ['essential', 'lifestyle']
const contributionBuckets: AllocationBucket[] = ['investment', 'reserve']

/** Tolerância antes de sinalizar ritmo acima do esperado no meio do mês. */
const PACE_TOLERANCE = 1.15

export function buildStrategyProgress(input: {
  month: string
  today: string
  baseIncomeCents: number
  currentIncomeCents: number
  targets: BucketAmounts
  actual: BucketAmounts
  projected: BucketAmounts
}): StrategyProgress {
  const { elapsed, dayOfMonth, total } = monthElapsed(input.month, input.today)
  const monthEnded = elapsed >= 1 && dayOfMonth === null

  const buckets: StrategyBucketProgress[] = []
  for (const bucket of spendingBuckets) {
    const targetCents = input.targets[bucket]
    const actualCents = input.actual[bucket]
    const projectedCents = actualCents + input.projected[bucket]
    let status: BucketStatus = 'on_track'
    if (actualCents > targetCents) status = 'over'
    else if (projectedCents > targetCents) status = 'attention'
    else if (
      elapsed >= 0.25 &&
      actualCents > targetCents * elapsed * PACE_TOLERANCE
    ) {
      status = 'attention'
    }
    buckets.push({
      bucket,
      label: bucketLabels[bucket],
      kind: 'spending',
      targetCents,
      actualCents,
      projectedCents,
      remainingCents: targetCents - actualCents,
      ratio:
        targetCents > 0 ? actualCents / targetCents : actualCents > 0 ? 1 : 0,
      status,
    })
  }
  for (const bucket of contributionBuckets) {
    const targetCents = input.targets[bucket]
    const actualCents = input.actual[bucket]
    let status: BucketStatus = 'on_track'
    if (targetCents <= 0 || actualCents >= targetCents) status = 'done'
    else if (monthEnded) status = 'behind'
    else if (elapsed >= 0.75 && actualCents < targetCents * 0.5) {
      status = 'attention'
    }
    buckets.push({
      bucket,
      label: bucketLabels[bucket],
      kind: 'contribution',
      targetCents,
      actualCents,
      projectedCents: actualCents,
      remainingCents: targetCents - actualCents,
      ratio: targetCents > 0 ? actualCents / targetCents : 1,
      status,
    })
  }

  const spending = buckets.filter((item) => item.kind === 'spending')
  const overall = buckets.some((item) => item.status === 'over')
    ? 'over'
    : buckets.some(
          (item) => item.status === 'attention' || item.status === 'behind',
        )
      ? 'attention'
      : 'on_track'

  return {
    month: input.month,
    elapsed,
    dayOfMonth,
    daysInMonth: total,
    monthEnded,
    buckets,
    spending: {
      targetCents: spending.reduce((sum, item) => sum + item.targetCents, 0),
      actualCents: spending.reduce((sum, item) => sum + item.actualCents, 0),
      projectedCents: spending.reduce(
        (sum, item) => sum + item.projectedCents,
        0,
      ),
    },
    income: {
      baseCents: input.baseIncomeCents,
      actualCents: input.currentIncomeCents,
    },
    overall,
  }
}
