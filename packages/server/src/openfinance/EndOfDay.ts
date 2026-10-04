/**
 * A posted line with the running balance the bank reported after it. `null`
 * marks what the provider left out: an amount it could not convert, or a line
 * without a running balance.
 */
export interface RunningLine {
  readonly bookedOn: string
  readonly amountCents: number | null
  readonly balanceAfterCents: number | null
}

/**
 * Derives end-of-day balances from the running balance banks report after
 * each transaction (Pluggy's documented end-of-day source). Lines of one day
 * arrive without a reliable order, so a candidate closing balance `E` is
 * accepted only if some line could have opened the day:
 * `balanceAfter - amount = E - (sum of the day's amounts)`. A day yields a
 * checkpoint only when exactly one closing balance is consistent; any doubt
 * yields none, never a guess. A day with any incomplete line yields none
 * either: its latest line may be the one without a balance.
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
  for (const [asOf, lines] of [...byDay].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const day = lines.flatMap(({ amountCents, balanceAfterCents }) =>
      amountCents === null || balanceAfterCents === null
        ? []
        : [{ amountCents, balanceAfterCents }],
    )
    if (day.length < lines.length) continue
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
