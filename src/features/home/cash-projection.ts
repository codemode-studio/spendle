import type { CashProjection as ProjectionFromApi } from '@spendle/server/api'

import { shiftDays } from '#/lib/period'

export interface CashPoint {
  date: string
  balanceCents: number
  lowCents?: number
  highCents?: number
}

export type CashEvent = ProjectionFromApi['scheduled'][number]

/** The V2 forecast cut to a horizon, with the daily balance line and what it assumes. */
export interface CashProjection {
  today: string
  /** Empty when today's cash is unknown. */
  points: Array<CashPoint>
  todayIndex: number
  lowPoint: CashPoint | null
  in30Cents: number | null
  dailyVariableCents: number
  scheduled: ReadonlyArray<CashEvent>
  recurringEstimateTransactionIds: ReadonlyArray<string>
  largestHistoricalExpenses: ProjectionFromApi['largestHistoricalExpenses']
  assumptions: {
    days: number
    startingCents: number | null
    estimatedIncomeCents: number
    estimatedRecurrenceCents: number
    closedCardCents: number
    scheduledCardCents: number
    estimatedCardCents: number
    historicalEstimateCents: number
  }
}

/**
 * Cuts the forecast to `daysAhead` days (never beyond what the server
 * projected) and walks the balance forward: scheduled events on their day,
 * the daily variable spending every day, with a widening band of ±25%.
 */
export function trimCashProjection(
  projection: ProjectionFromApi,
  daysAhead: number,
): CashProjection {
  const days = Math.min(daysAhead, projection.days)
  const { today, dailyVariableCents } = projection
  const horizon = shiftDays(today, days)
  const scheduled = projection.scheduled.filter(
    (event) => event.date <= horizon,
  )
  const assumptions: CashProjection['assumptions'] = {
    days,
    startingCents: projection.startingCents,
    estimatedIncomeCents: 0,
    estimatedRecurrenceCents: 0,
    closedCardCents: 0,
    scheduledCardCents: 0,
    estimatedCardCents: 0,
    historicalEstimateCents: dailyVariableCents * days,
  }
  const delta = new Map<string, number>()
  for (const event of scheduled) {
    delta.set(event.date, (delta.get(event.date) ?? 0) + event.amountCents)
    const cents = Math.abs(event.amountCents)
    if (event.kind === 'income') assumptions.estimatedIncomeCents += cents
    else if (event.kind === 'expense')
      assumptions.estimatedRecurrenceCents += cents
    else if (event.certainty === 'closed') assumptions.closedCardCents += cents
    else if (event.certainty === 'installment_schedule')
      assumptions.scheduledCardCents += cents
    else assumptions.estimatedCardCents += cents
  }
  const base = {
    today,
    dailyVariableCents,
    scheduled,
    recurringEstimateTransactionIds: projection.recurringEstimateEntryIds,
    largestHistoricalExpenses: projection.largestHistoricalExpenses,
    assumptions,
  }
  const starting = projection.startingCents
  if (starting === null || projection.todayIndex < 0)
    return {
      ...base,
      points: [],
      todayIndex: -1,
      lowPoint: null,
      in30Cents: null,
    }
  const points: Array<CashPoint> = projection.points.slice(
    0,
    projection.todayIndex + 1,
  )
  let balance = starting
  for (let day = 1; day <= days; day++) {
    const date = shiftDays(today, day)
    balance += (delta.get(date) ?? 0) - dailyVariableCents
    const spread = Math.round(dailyVariableCents * day * 0.25)
    points.push({
      date,
      balanceCents: balance,
      lowCents: balance - spread,
      highCents: balance + spread,
    })
  }
  const todayIndex = projection.todayIndex
  const future = points.slice(todayIndex + 1)
  return {
    ...base,
    points,
    todayIndex,
    lowPoint: future.length
      ? future.reduce((min, point) =>
          point.balanceCents < min.balanceCents ? point : min,
        )
      : null,
    in30Cents:
      points[Math.min(todayIndex + 30, points.length - 1)].balanceCents,
  }
}
