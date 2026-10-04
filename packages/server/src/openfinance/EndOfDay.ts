/** A posted line with the running balance the bank reported after it. */
export interface RunningLine {
  readonly bookedOn: string
  readonly amountCents: number
  readonly balanceAfterCents: number
}

/**
 * Derives end-of-day balances from the running balance banks report after
 * each transaction (Pluggy's documented end-of-day source). Lines of one day
 * arrive without a reliable order, so a candidate closing balance `E` is
 * accepted only if some line could have opened the day:
 * `balanceAfter - amount = E - (sum of the day's amounts)`. A day yields a
 * checkpoint only when exactly one closing balance is consistent; any doubt
 * yields none, never a guess.
 */
export const endOfDayBalances = (
  lines: ReadonlyArray<RunningLine>,
): ReadonlyArray<{ readonly asOf: string; readonly balanceCents: number }> => {
  const byDay = new Map<string, Array<RunningLine>>()
  for (const line of lines) {
    const day = byDay.get(line.bookedOn) ?? []
    day.push(line)
    byDay.set(line.bookedOn, day)
  }
  const checkpoints: Array<{ asOf: string; balanceCents: number }> = []
  for (const [asOf, day] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
    const total = day.reduce((sum, line) => sum + line.amountCents, 0)
    const openings = new Set(
      day.map((line) => line.balanceAfterCents - line.amountCents),
    )
    const closings = new Set(
      day
        .map((line) => line.balanceAfterCents)
        .filter((closing) => openings.has(closing - total)),
    )
    if (closings.size === 1)
      checkpoints.push({ asOf, balanceCents: [...closings][0]! })
  }
  return checkpoints
}
