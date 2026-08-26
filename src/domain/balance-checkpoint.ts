export interface CheckpointMovement {
  amountCents: number
  currency: string
  postedAt: string
  status: 'pending' | 'confirmed' | 'excluded'
}

interface CoverageInterval {
  start: string
  end: string
}

export function classifyCheckpointAtDate(
  checkpoints: Array<{
    id: string
    balanceType: 'posted' | 'available' | 'card_statement'
    balanceCents: number
    asOf: string
    reviewState: 'verified' | 'observed' | 'invalidated'
  }>,
  input: {
    balanceType: 'posted' | 'available' | 'card_statement'
    balanceCents: number
    asOf: string
  },
) {
  const active = checkpoints.filter(
    (checkpoint) =>
      checkpoint.reviewState !== 'invalidated' &&
      checkpoint.balanceType === input.balanceType &&
      checkpoint.asOf === input.asOf,
  )
  if (!active.length) return { status: 'none' as const, checkpointId: null }
  if (
    active.every((checkpoint) => checkpoint.balanceCents === input.balanceCents)
  ) {
    return { status: 'identical' as const, checkpointId: active[0].id }
  }
  return { status: 'conflict' as const, checkpointId: null }
}

function nextDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

function coversPeriod(
  intervals: CoverageInterval[],
  startExclusive: string,
  endInclusive: string,
) {
  const requiredStart = nextDate(startExclusive)
  let coveredThrough: string | null = null
  for (const interval of [...intervals].sort((a, b) =>
    a.start.localeCompare(b.start),
  )) {
    if (interval.end < requiredStart || interval.start > endInclusive) continue
    if (!coveredThrough) {
      if (interval.start > requiredStart) return false
      coveredThrough = interval.end
      continue
    }
    if (interval.start > nextDate(coveredThrough)) return false
    if (interval.end > coveredThrough) coveredThrough = interval.end
  }
  return Boolean(coveredThrough && coveredThrough >= endInclusive)
}

export function evaluateCheckpoint(input: {
  targetType: 'account' | 'card'
  currency: string
  balanceType: 'posted' | 'available' | 'card_statement'
  balanceCents: number
  asOf: string
  previous: { balanceCents: number; asOf: string } | null
  movements: CheckpointMovement[]
  coverageIntervals: CoverageInterval[]
}) {
  const eligible = input.movements.filter(
    (movement) =>
      movement.currency === input.currency &&
      movement.status !== 'excluded' &&
      (!input.previous || movement.postedAt > input.previous.asOf) &&
      movement.postedAt <= input.asOf &&
      movement.status === 'confirmed',
  )
  const unsupportedCurrencyCount = input.movements.filter(
    (movement) =>
      movement.currency !== input.currency &&
      movement.status === 'confirmed' &&
      (!input.previous || movement.postedAt > input.previous.asOf) &&
      movement.postedAt <= input.asOf,
  ).length
  const movementCents = eligible.reduce(
    (sum, movement) => sum + movement.amountCents,
    0,
  )
  const expectedBalanceCents = input.previous
    ? input.targetType === 'account'
      ? input.previous.balanceCents + movementCents
      : Math.max(0, -movementCents)
    : null
  const differenceCents =
    expectedBalanceCents === null
      ? null
      : input.balanceCents - expectedBalanceCents
  const reviewState =
    input.balanceType !== 'available' &&
    differenceCents === 0 &&
    unsupportedCurrencyCount === 0 &&
    input.previous !== null &&
    coversPeriod(input.coverageIntervals, input.previous.asOf, input.asOf)
      ? ('verified' as const)
      : ('observed' as const)
  return {
    expectedBalanceCents,
    differenceCents,
    movementCents,
    unsupportedCurrencyCount,
    coverageComplete:
      input.previous !== null &&
      coversPeriod(input.coverageIntervals, input.previous.asOf, input.asOf),
    reviewState,
  }
}
