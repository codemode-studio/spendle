/**
 * What a position is worth, decided without I/O from the movements the
 * person classified into it and the valuations they entered. Nothing here
 * is stored: change the rules and every position is valued anew.
 */

/** A movement classified into the position, signed as its account saw it. */
export interface PositionMovement {
  readonly entryId: string
  readonly bookedOn: string
  /** Inflows to the brokerage account are contributions; outflows, withdrawals. */
  readonly amountCents: number
  readonly status: 'pending' | 'posted'
}

/** A value the person entered; a later one of the same day corrects it. */
export interface PositionValuation {
  readonly asOf: string
  readonly amountCents: number
  /** Order the valuations were recorded in. */
  readonly sequence: number
}

export interface PositionValue {
  /** Opening plus the counted movements. */
  readonly contributedCents: number
  /** The latest valuation plus counted movements after it, or the contributions without one. */
  readonly currentCents: number
  readonly valueKind: 'valuation' | 'contributions'
  readonly valuedOn: string | null
  /** Posted movements booked on or before the reference date. */
  readonly counted: ReadonlyArray<string>
  /** Pending or future-dated movements, left out until they post. */
  readonly upcoming: ReadonlyArray<string>
}

/**
 * The position's value at the end of `referenceDate`. Only posted
 * movements booked by then count; a valuation carries the position to its
 * day, and movements booked after it add to it.
 */
export const valuePosition = (input: {
  readonly openingCents: number
  readonly movements: ReadonlyArray<PositionMovement>
  readonly valuations: ReadonlyArray<PositionValuation>
  readonly referenceDate: string
}): PositionValue => {
  const { referenceDate } = input
  const counts = (movement: PositionMovement) =>
    movement.status === 'posted' && movement.bookedOn <= referenceDate
  const counted = input.movements.filter(counts)
  const upcoming = input.movements.filter((movement) => !counts(movement))
  const contributedCents =
    input.openingCents +
    counted.reduce((sum, movement) => sum + movement.amountCents, 0)
  const valuation = input.valuations
    .filter((item) => item.asOf <= referenceDate)
    .sort((a, b) =>
      a.asOf === b.asOf ? a.sequence - b.sequence : a.asOf < b.asOf ? -1 : 1,
    )
    .at(-1)
  const currentCents =
    valuation === undefined
      ? contributedCents
      : valuation.amountCents +
        counted
          .filter((movement) => movement.bookedOn > valuation.asOf)
          .reduce((sum, movement) => sum + movement.amountCents, 0)
  return {
    contributedCents,
    currentCents,
    valueKind: valuation === undefined ? 'contributions' : 'valuation',
    valuedOn: valuation?.asOf ?? null,
    counted: counted.map((movement) => movement.entryId),
    upcoming: upcoming.map((movement) => movement.entryId),
  }
}

/** Digits after the decimal point of a currency's minor unit. */
export const fractionDigits = (currency: string) => (currency === 'BTC' ? 8 : 2)

/**
 * Minor units of `currency` in centavos at `rateMicros` reais per unit
 * (rate × 1 000 000), rounded half away from zero, in exact integers.
 */
export const toBrlCents = (
  amount: number,
  currency: string,
  rateMicros: number,
) => {
  if (currency === 'BRL') return amount
  const divisor = 1_000_000n * 10n ** BigInt(fractionDigits(currency) - 2)
  const product = BigInt(amount) * BigInt(rateMicros)
  const magnitude = product < 0n ? -product : product
  const rounded = (magnitude * 2n + divisor) / (divisor * 2n)
  return Number(product < 0n ? -rounded : rounded)
}
