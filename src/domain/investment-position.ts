export interface PositionValuation {
  initialAmountMinor: number
  manualCurrentAmountMinor: number | null
  /** Date of the manual valuation; it already includes movements up to it. */
  manualCurrentAt: string | null
}

export interface DatedPositionMovement {
  kind: 'contribution' | 'withdrawal'
  amountMinor: number
  /** Posting date of the linked transaction; null when it is unknown. */
  postedAt: string | null
}

function signed(movement: DatedPositionMovement) {
  return movement.kind === 'contribution'
    ? movement.amountMinor
    : -movement.amountMinor
}

/**
 * Current amount of a position in its own currency. A dated manual valuation
 * is an anchor: movements posted after its date still change the position.
 * Without a valuation, the position is the initial amount plus every movement.
 */
export function positionCurrentAmountMinor(
  position: PositionValuation,
  movements: ReadonlyArray<DatedPositionMovement>,
) {
  if (position.manualCurrentAmountMinor === null) {
    return movements.reduce(
      (sum, movement) => sum + signed(movement),
      position.initialAmountMinor,
    )
  }
  const anchor = position.manualCurrentAt
  if (anchor === null) return position.manualCurrentAmountMinor
  return movements
    .filter(
      (movement) => movement.postedAt !== null && movement.postedAt > anchor,
    )
    .reduce(
      (sum, movement) => sum + signed(movement),
      position.manualCurrentAmountMinor,
    )
}

/**
 * Emergency reserve progress: the linked positions when there are any,
 * otherwise the progress recorded on the goal before positions existed.
 */
export function reserveProgressCents(input: {
  recordedCents: number
  linkedPositionCents: ReadonlyArray<number>
}) {
  if (!input.linkedPositionCents.length) return input.recordedCents
  return input.linkedPositionCents.reduce((sum, cents) => sum + cents, 0)
}
