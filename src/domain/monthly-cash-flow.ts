/** Reconstruct a recorded balance around a dated statement, without creating ledger entries. */
export function recordedBalanceAt(input: {
  date: string
  initialCents: number
  anchors: Array<{ date: string; cents: number }>
  movements: Array<{ date: string; cents: number }>
}): number | null {
  const anchors = [...input.anchors].sort((a, b) =>
    a.date.localeCompare(b.date),
  )
  const anchor =
    anchors.filter((a) => a.date <= input.date).at(-1) ?? anchors.at(0)
  if (!anchor) {
    if (
      !input.movements.some((m) => m.date <= input.date) &&
      input.initialCents !== 0
    )
      return null
    return (
      input.initialCents +
      input.movements
        .filter((m) => m.date <= input.date)
        .reduce((sum, m) => sum + m.cents, 0)
    )
  }
  if (
    anchor.date > input.date &&
    !input.movements.some((m) => m.date <= input.date)
  )
    return anchor.cents === 0 && input.movements.length === 0 ? 0 : null
  return (
    anchor.cents +
    input.movements.reduce((sum, m) => {
      if (anchor.date <= input.date)
        return (
          sum + (m.date > anchor.date && m.date <= input.date ? m.cents : 0)
        )
      return sum - (m.date > input.date && m.date <= anchor.date ? m.cents : 0)
    }, 0)
  )
}

export function buildMonthlyCashFlow(input: {
  forecasting: boolean
  openingCashCents: number | null
  cashCents: number | null
  receivedCents: number
  paidCents: number
  expectedIncomeCents: number
  remainingExpenseCents: number
  goalRemainingCents: number
}) {
  const expectedIncomeCents = input.forecasting ? input.expectedIncomeCents : 0
  const remainingExpenseCents = input.forecasting
    ? input.remainingExpenseCents
    : 0
  const closingCashCents =
    input.cashCents === null
      ? null
      : input.cashCents + expectedIncomeCents - remainingExpenseCents
  return {
    ...input,
    expectedIncomeCents,
    remainingExpenseCents,
    closingCashCents,
    afterGoalsCents:
      closingCashCents === null
        ? null
        : closingCashCents - (input.forecasting ? input.goalRemainingCents : 0),
    unexplainedChangeCents:
      input.cashCents === null || input.openingCashCents === null
        ? null
        : input.cashCents -
          input.openingCashCents -
          input.receivedCents +
          input.paidCents,
  }
}
