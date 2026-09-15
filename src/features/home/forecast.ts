import type { CashProjection } from '#/domain/monthly-cash-flow'

/** Uniform daily changes are a simulation, never scheduled receipts or ledger writes. */
export function simulateRecovery(
  cash: CashProjection,
  reductionPercent: number,
  extraMonthlyCents: number,
  savingsMonthlyCents: number,
) {
  const percent = Number.isFinite(reductionPercent)
    ? Math.max(0, Math.min(100, reductionPercent))
    : 0
  const extra = Number.isSafeInteger(extraMonthlyCents)
    ? Math.max(0, extraMonthlyCents)
    : 0
  const savings = Math.max(0, Math.round(savingsMonthlyCents))
  const reductionMonthlyCents = Math.round(
    (cash.dailyVariableCents * 30 * percent) / 100,
  )
  const improvementMonthlyCents = reductionMonthlyCents + extra
  const future = cash.points.slice(cash.todayIndex + 1)
  const startingCents = cash.points[cash.todayIndex].balanceCents
  const ending = future.at(-1) ?? cash.points[cash.todayIndex]
  const requiredToStayPositive = future.reduce(
    (required, point, i) =>
      Math.max(required, Math.ceil((-point.balanceCents * 30) / (i + 1))),
    0,
  )
  const requiredToSave = future.length
    ? Math.max(
        0,
        Math.ceil(
          ((startingCents - ending.balanceCents) * 30) / future.length,
        ) + savings,
      )
    : 0
  const requiredMonthlyCents = Math.max(requiredToStayPositive, requiredToSave)
  const points = cash.points.map((point, i) => ({
    date: point.date,
    balanceCents:
      point.balanceCents +
      Math.round(
        (improvementMonthlyCents * Math.max(0, i - cash.todayIndex)) / 30,
      ),
  }))
  const projected = points.slice(cash.todayIndex + 1)
  const minimum = (list: typeof points) =>
    list.reduce(
      (min, point) => (point.balanceCents < min.balanceCents ? point : min),
      list[0],
    )
  return {
    points,
    firstNegative: future.find((point) => point.balanceCents < 0) ?? null,
    simulatedFirstNegative:
      projected.find((point) => point.balanceCents < 0) ?? null,
    minimum: minimum(future.length ? future : [ending]),
    simulatedMinimum: minimum(projected.length ? projected : [ending]),
    endingCents: ending.balanceCents,
    simulatedEndingCents: points.at(-1)!.balanceCents,
    reductionMonthlyCents,
    improvementMonthlyCents,
    requiredMonthlyCents,
    remainingMonthlyCents: Math.max(
      0,
      requiredMonthlyCents - improvementMonthlyCents,
    ),
    monthlyBalanceCents: future.length
      ? Math.round(((ending.balanceCents - startingCents) * 30) / future.length)
      : 0,
  }
}
