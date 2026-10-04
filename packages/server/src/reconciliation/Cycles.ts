import { addDays, dayOfMonth, monthStart } from '../domain/LocalDate.ts'

export interface CardTermsInput {
  readonly closingDay: number
  readonly dueDay: number
}

export interface CycleBounds {
  /** First day of the cycle: the day after the previous closing. */
  readonly startsOn: string
  /** Last day whose purchases enter this statement. */
  readonly closingOn: string
  readonly dueOn: string
}

/** The closing that ends the cycle containing `date`. */
const closingFor = (date: string, closingDay: number) => {
  const thisMonth = dayOfMonth(date, closingDay)
  return date <= thisMonth
    ? thisMonth
    : dayOfMonth(monthStart(date, 1), closingDay)
}

/** The statement cycle a card movement on `date` belongs to. */
export const cycleContaining = (
  date: string,
  terms: CardTermsInput,
): CycleBounds => {
  const closingOn = closingFor(date, terms.closingDay)
  const previousClosing = dayOfMonth(
    monthStart(closingOn, -1),
    terms.closingDay,
  )
  // A due day after the closing day falls in the closing month; otherwise the next.
  const dueMonth =
    terms.dueDay > terms.closingDay ? closingOn : monthStart(closingOn, 1)
  return {
    startsOn: addDays(previousClosing, 1),
    closingOn,
    dueOn: dayOfMonth(dueMonth, terms.dueDay),
  }
}

export interface CycleEntry {
  readonly id: string
  readonly bookedOn: string
  readonly amountCents: number
}

export interface CyclePayment {
  readonly entryId: string
  readonly paidOn: string
  /** Positive: money that reached the card. */
  readonly amountCents: number
  /** Where the payment was seen: the card's own credit, or only the bank debit. */
  readonly via: 'card' | 'bank'
}

export interface StatementTotal {
  readonly asOf: string
  /** Negative: what the statement says is owed. */
  readonly cents: number
}

export type CycleStatus = 'open' | 'due' | 'paid' | 'partially_paid' | 'overdue'

export interface CardCycle extends CycleBounds {
  readonly status: CycleStatus
  /** Purchases and credits of the cycle; negative when something is owed. */
  readonly totalCents: number
  readonly paidCents: number
  readonly entryIds: ReadonlyArray<string>
  readonly payments: ReadonlyArray<CyclePayment>
  /** The issued statement's total and how far the entries are from it. */
  readonly statement: {
    readonly observedCents: number
    readonly differenceCents: number
  } | null
}

/**
 * Builds the card's statement cycles from the first movement to today.
 *
 * Entries enter the cycle containing their booking date. A payment settles
 * the cycle that most recently closed before it was made. A statement total
 * dated from a cycle's closing up to the day before the next closing is that
 * cycle's statement,
 * and its difference from the entries is the cycle's proof: zero means every
 * purchase on the statement is accounted for.
 */
export const cardCycles = (input: {
  readonly terms: CardTermsInput
  readonly entries: ReadonlyArray<CycleEntry>
  readonly payments: ReadonlyArray<CyclePayment>
  readonly statements: ReadonlyArray<StatementTotal>
  readonly today: string
}): ReadonlyArray<CardCycle> => {
  const dates = [
    ...input.entries.map((entry) => entry.bookedOn),
    ...input.payments.map((payment) => payment.paidOn),
  ]
  if (dates.length === 0) return []
  const first = dates.reduce((a, b) => (a < b ? a : b))

  const cycles: Array<CycleBounds> = []
  for (let bounds = cycleContaining(first, input.terms); ;) {
    cycles.push(bounds)
    if (bounds.closingOn >= input.today) break
    bounds = cycleContaining(addDays(bounds.closingOn, 1), input.terms)
  }

  return cycles.map((bounds, index) => {
    const next = cycles[index + 1]
    const entries = input.entries.filter(
      (entry) =>
        entry.bookedOn >= bounds.startsOn && entry.bookedOn <= bounds.closingOn,
    )
    const settles = (date: string) =>
      date > bounds.closingOn && (next === undefined || date <= next.closingOn)
    const payments = input.payments.filter((payment) => settles(payment.paidOn))
    const totalCents = entries.reduce(
      (sum, entry) => sum + entry.amountCents,
      0,
    )
    const paidCents = payments.reduce(
      (sum, payment) => sum + payment.amountCents,
      0,
    )
    // Issued on its closing day or after it, but before the next closing.
    const observed = input.statements
      .filter(
        (statement) =>
          statement.asOf >= bounds.closingOn &&
          (next === undefined || statement.asOf < next.closingOn),
      )
      .at(-1)

    const owed = -totalCents - paidCents
    const status: CycleStatus =
      input.today <= bounds.closingOn
        ? 'open'
        : owed <= 0
          ? 'paid'
          : paidCents > 0
            ? 'partially_paid'
            : input.today > bounds.dueOn
              ? 'overdue'
              : 'due'

    return {
      ...bounds,
      status,
      totalCents,
      paidCents,
      entryIds: entries.map((entry) => entry.id),
      payments,
      statement: observed
        ? {
            observedCents: observed.cents,
            differenceCents: observed.cents - totalCents,
          }
        : null,
    }
  })
}
