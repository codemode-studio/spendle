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
 * The balance a day's lines close on, if they prove exactly one. Each line
 * moves the balance from `balanceAfter - amount` to `balanceAfter`; the day is
 * a sequence of those moves in an order the provider does not give. They fit
 * only if one sequence uses every line once, each starting where the last
 * ended. Such a sequence exists when the moves are connected and every
 * balance is left as often as it is reached, except one start and one end;
 * that end is then the only possible close. Moves that return to where they
 * began could end anywhere along the loop, so they prove no close (unless
 * they never leave a single balance).
 */
const closingBalance = (
  day: ReadonlyArray<{ amountCents: number; balanceAfterCents: number }>,
): number | null => {
  const net = new Map<number, number>()
  const links = new Map<number, Array<number>>()
  const link = (a: number, b: number) => {
    links.set(a, [...(links.get(a) ?? []), b])
    links.set(b, [...(links.get(b) ?? []), a])
  }
  for (const { amountCents, balanceAfterCents: after } of day) {
    const before = after - amountCents
    net.set(before, (net.get(before) ?? 0) + 1)
    net.set(after, (net.get(after) ?? 0) - 1)
    link(before, after)
  }
  const [first] = links.keys()
  if (first === undefined) return null
  const seen = new Set([first])
  const queue = [first]
  for (let next = queue.pop(); next !== undefined; next = queue.pop())
    for (const other of links.get(next) ?? [])
      if (!seen.has(other)) {
        seen.add(other)
        queue.push(other)
      }
  if (seen.size < links.size) return null
  if ([...net].some(([, n]) => Math.abs(n) > 1)) return null
  const starts = [...net].filter(([, n]) => n === 1)
  const ends = [...net].filter(([, n]) => n === -1)
  if (starts.length === 1 && ends.length === 1) return ends[0]![0]
  if (starts.length === 0 && ends.length === 0 && links.size === 1) return first
  return null
}

/**
 * Derives end-of-day balances from the running balance banks report after
 * each transaction (Pluggy's documented end-of-day source). Lines of one day
 * arrive without a reliable order, so a day yields a checkpoint only when its
 * lines chain into one sequence with a single possible close; any doubt
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
    const closing = closingBalance(day)
    if (closing !== null) checkpoints.push({ asOf, balanceCents: closing })
  }
  return checkpoints
}
