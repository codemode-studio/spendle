import {
  addDays,
  dayOfMonth,
  monthStart,
  nextBusinessDay,
} from '../domain/LocalDate.ts'

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
  /** Whether an issued statement set the closing, or only the card's configured days. */
  readonly closing: 'statement' | 'forecast'
}

/** The configured closing that ends the cycle containing `date`. */
const closingFor = (date: string, closingDay: number) => {
  const thisMonth = dayOfMonth(date, closingDay)
  return date <= thisMonth
    ? thisMonth
    : dayOfMonth(monthStart(date, 1), closingDay)
}

/**
 * The due date for a closing: the configured due day after the closing,
 * moved to the next weekday. Days are compared after clamping to the month,
 * so a due day that collapses onto the closing moves to the next month.
 */
export const dueAfter = (closingOn: string, dueDay: number) => {
  const sameMonth = dayOfMonth(closingOn, dueDay)
  return nextBusinessDay(
    sameMonth > closingOn
      ? sameMonth
      : dayOfMonth(monthStart(closingOn, 1), dueDay),
  )
}

/** The forecast statement cycle a card movement on `date` belongs to. */
export const cycleContaining = (
  date: string,
  terms: CardTermsInput,
): CycleBounds => {
  const closingOn = closingFor(date, terms.closingDay)
  const previousClosing = dayOfMonth(
    monthStart(closingOn, -1),
    terms.closingDay,
  )
  return {
    startsOn: addDays(previousClosing, 1),
    closingOn,
    dueOn: dueAfter(closingOn, terms.dueDay),
    closing: 'forecast',
  }
}

export interface CycleEntry {
  readonly id: string
  readonly bookedOn: string
  readonly amountCents: number
  /** The provider's bill this movement was charged on, when it says. */
  readonly billId: string | null
}

export interface CyclePayment {
  readonly entryId: string
  readonly paidOn: string
  /** Positive: money that reached the card. */
  readonly amountCents: number
  /** Where the payment was seen: the card's own credit, or only the bank debit. */
  readonly via: 'card' | 'bank'
}

/** An issued statement: the period it covers and what it says is owed. */
export interface IssuedStatement {
  readonly startsOn: string
  readonly closingOn: string
  /** Negative: what the statement says is owed. */
  readonly cents: number
}

export type CycleStatus = 'open' | 'due' | 'paid' | 'partially_paid' | 'overdue'

export interface CardCycle extends CycleBounds {
  readonly status: CycleStatus
  /** Purchases and credits of the cycle; negative when something is owed. */
  readonly totalCents: number
  /** What the cycle bills: the issued statement's total, else the entries' total. Positive when owed. */
  readonly billedCents: number
  readonly paidCents: number
  readonly entryIds: ReadonlyArray<string>
  /** The part of each payment applied to this cycle. */
  readonly payments: ReadonlyArray<CyclePayment>
  /** The issued statement's total and how far the entries are from it. */
  readonly statement: {
    readonly observedCents: number
    readonly differenceCents: number
  } | null
}

export interface CardCycles {
  readonly cycles: ReadonlyArray<CardCycle>
  /** Payments beyond everything billed so far: credit on the card. */
  readonly unappliedCents: number
}

// An issued closing replaces the forecast it is near; beyond this it is a different cycle.
const replacesForecastWithinDays = 15
// The shortest cycle a forecast may open after an issued closing.
const minimumCycleDays = 20

/**
 * Closings from the first movement to today. Issued statements set their
 * own closings (and the day before their period, the previous closing);
 * configured days fill the months no statement covers.
 */
const closings = (
  first: string,
  through: string,
  issued: ReadonlyArray<string>,
  terms: CardTermsInput,
) => {
  const actual = [...new Set(issued)].sort()
  const result: Array<{ closingOn: string; closing: CycleBounds['closing'] }> =
    []
  let forecast = closingFor(first, terms.closingDay)
  for (;;) {
    const last = result.at(-1)?.closingOn
    const next = actual.find((date) =>
      last === undefined ? date >= first : date > last,
    )
    const chosen =
      next !== undefined &&
      next <= addDays(forecast, replacesForecastWithinDays)
        ? { closingOn: next, closing: 'statement' as const }
        : { closingOn: forecast, closing: 'forecast' as const }
    result.push(chosen)
    if (chosen.closingOn >= through) return result
    forecast = closingFor(
      addDays(chosen.closingOn, minimumCycleDays),
      terms.closingDay,
    )
  }
}

/**
 * Builds the card's statement cycles from the first movement or statement
 * to today, and applies payments to them.
 *
 * Cycle bounds come from issued statements when there are any; configured
 * closing and due days are a forecast for the rest. An entry belongs to the
 * cycle containing its date, except that entries the provider assigns to one
 * bill stay together, in the cycle of the latest of them.
 *
 * What a cycle owes is its issued statement's total when there is one, since
 * imported entries may be incomplete; the difference from the entries is
 * reported as the statement proof, apart from payment status.
 *
 * Payments apply in date order to the oldest cycle that still owes,
 * among the cycles that had started when the payment was made, so a payment
 * can settle several bills or pay the open one in advance. What exceeds
 * everything billed is unapplied credit.
 */
export const cardCycles = (input: {
  readonly terms: CardTermsInput
  readonly entries: ReadonlyArray<CycleEntry>
  readonly payments: ReadonlyArray<CyclePayment>
  readonly statements: ReadonlyArray<IssuedStatement>
  readonly today: string
}): CardCycles => {
  const dates = [
    ...input.entries.map((entry) => entry.bookedOn),
    ...input.payments.map((payment) => payment.paidOn),
    ...input.statements.map((statement) => statement.startsOn),
  ]
  if (dates.length === 0) return { cycles: [], unappliedCents: 0 }
  const first = dates.reduce((a, b) => (a < b ? a : b))
  const lastStatement = input.statements
    .map((statement) => statement.closingOn)
    .reduce((a, b) => (a > b ? a : b), input.today)

  const ends = closings(
    first,
    lastStatement,
    input.statements.flatMap((statement) => [
      addDays(statement.startsOn, -1),
      statement.closingOn,
    ]),
    input.terms,
  )
  // The latest report of a statement speaks for it.
  const statementOf = new Map<string, IssuedStatement>()
  for (const statement of input.statements)
    statementOf.set(statement.closingOn, statement)

  const firstStart = (closingOn: string) => {
    const issued = statementOf.get(closingOn)?.startsOn
    const forecast = addDays(
      dayOfMonth(monthStart(closingOn, -1), input.terms.closingDay),
      1,
    )
    const start = issued ?? forecast
    return start < first ? start : first
  }
  const bounds: ReadonlyArray<CycleBounds> = ends.map((end, index) => ({
    startsOn:
      index === 0
        ? firstStart(end.closingOn)
        : addDays(ends[index - 1]!.closingOn, 1),
    closingOn: end.closingOn,
    dueOn: dueAfter(end.closingOn, input.terms.dueDay),
    closing: end.closing,
  }))
  const cycleOf = (date: string) => {
    const index = bounds.findIndex((cycle) => date <= cycle.closingOn)
    return index === -1 ? bounds.length - 1 : index
  }

  // Entries of one provider bill go where the latest of them falls.
  const latestOfBill = new Map<string, string>()
  for (const entry of input.entries) {
    if (entry.billId === null) continue
    const latest = latestOfBill.get(entry.billId)
    if (latest === undefined || entry.bookedOn > latest)
      latestOfBill.set(entry.billId, entry.bookedOn)
  }
  const entriesOf = bounds.map((): Array<CycleEntry> => [])
  for (const entry of input.entries) {
    const date =
      entry.billId === null ? entry.bookedOn : latestOfBill.get(entry.billId)!
    entriesOf[cycleOf(date)]!.push(entry)
  }

  const totals = entriesOf.map((entries) =>
    entries.reduce((sum, entry) => sum + entry.amountCents, 0),
  )
  const billed = bounds.map((cycle, index) => {
    const statement = statementOf.get(cycle.closingOn)
    return 0 - (statement ? statement.cents : totals[index]!)
  })

  const applied = bounds.map((): Array<CyclePayment> => [])
  const paid = bounds.map(() => 0)
  let unappliedCents = 0
  const ordered = [...input.payments].sort(
    (a, b) =>
      a.paidOn.localeCompare(b.paidOn) || a.entryId.localeCompare(b.entryId),
  )
  for (const payment of ordered) {
    let remaining = payment.amountCents
    const started = cycleOf(payment.paidOn)
    for (let index = 0; index <= started && remaining > 0; index++) {
      const owed = billed[index]! - paid[index]!
      if (owed <= 0) continue
      const part = Math.min(owed, remaining)
      paid[index]! += part
      applied[index]!.push({ ...payment, amountCents: part })
      remaining -= part
    }
    unappliedCents += remaining
  }

  const cycles = bounds.map((cycle, index): CardCycle => {
    const statement = statementOf.get(cycle.closingOn)
    const owed = billed[index]! - paid[index]!
    const status: CycleStatus =
      input.today <= cycle.closingOn
        ? 'open'
        : owed <= 0
          ? 'paid'
          : input.today > cycle.dueOn
            ? 'overdue'
            : paid[index]! > 0
              ? 'partially_paid'
              : 'due'
    return {
      ...cycle,
      status,
      totalCents: totals[index]!,
      billedCents: billed[index]!,
      paidCents: paid[index]!,
      entryIds: entriesOf[index]!.map((entry) => entry.id),
      payments: applied[index]!,
      statement: statement
        ? {
            observedCents: statement.cents,
            differenceCents: statement.cents - totals[index]!,
          }
        : null,
    }
  })
  return { cycles, unappliedCents }
}
