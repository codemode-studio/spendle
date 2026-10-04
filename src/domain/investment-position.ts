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
 * A position carries its own value once it has an initial amount or a
 * manual valuation; until then it only adds the movements classified into it.
 */
export function hasOwnValuation(position: PositionValuation) {
  return (
    position.initialAmountMinor !== 0 ||
    position.manualCurrentAmountMinor !== null
  )
}

/**
 * Emergency reserve progress. The progress recorded on the goal before
 * positions existed is the opening amount that movement-only positions add
 * to; once a linked position has its own valuation, the positions are the
 * whole reserve and the recorded amount is no longer counted.
 */
export function reserveProgressCents(input: {
  recordedCents: number
  linkedPositions: ReadonlyArray<{ cents: number; ownValuation: boolean }>
}) {
  const positionsCents = input.linkedPositions.reduce(
    (sum, position) => sum + position.cents,
    0,
  )
  return input.linkedPositions.some((position) => position.ownValuation)
    ? positionsCents
    : input.recordedCents + positionsCents
}

/**
 * Whether a movement counts toward the position's value on `referenceDate`:
 * its transaction is confirmed and posted by then. A future or pending
 * contribution keeps its classification and counts once it posts. A
 * movement whose transaction is unknown keeps its recorded amount.
 */
export function isPositionMovementPosted(
  transaction: { status: string; postedAt: string } | null | undefined,
  referenceDate: string,
) {
  return (
    !transaction ||
    (transaction.status === 'confirmed' &&
      transaction.postedAt <= referenceDate)
  )
}

/**
 * A movement records the person's choice of position; its amount, base value
 * and direction follow the transaction it points to, so an accepted
 * correction of that transaction revalues the position.
 */
export function currentPositionMovement<
  TMovement extends {
    kind: 'contribution' | 'withdrawal'
    amountMinor: number
    baseAmountCents: number | null
  },
>(
  movement: TMovement,
  transaction: { amountCents: number; baseAmountCents: number | null } | null,
): TMovement {
  if (!transaction || transaction.amountCents === 0) return movement
  return {
    ...movement,
    kind: transaction.amountCents > 0 ? 'contribution' : 'withdrawal',
    amountMinor: Math.abs(transaction.amountCents),
    baseAmountCents:
      transaction.baseAmountCents === null
        ? null
        : Math.abs(transaction.baseAmountCents),
  }
}
