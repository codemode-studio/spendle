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
  /** Whether the issued statement printed the due date, or only the card's configured day. */
  readonly due: 'statement' | 'forecast'
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
    due: 'forecast',
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
  /**
   * The payment's entry. For credit a cycle left (`via: 'credit'`), the
   * latest credit entry of that cycle, or `statement:<closing>` when only
   * its issued statement shows the credit.
   */
  readonly entryId: string
  /** When the payment was made: the bank debit's date when it is known. */
  readonly paidOn: string
  /**
   * When the money reached the card, when it is known. An issued statement
   * reflects the payment only if this falls within its period.
   */
  readonly creditedOn?: string
  /** Positive: money that reached the card. */
  readonly amountCents: number
  /**
   * Where the payment was seen: the card's own credit, only the bank debit,
   * or credit an earlier cycle left when its refunds exceeded its charges.
   */
  readonly via: 'card' | 'bank' | 'credit'
  /** The closing of the bill it was identified as paying; others pay the oldest bill first. */
  readonly settles?: string
}

/** An issued statement: the period it covers and what it says is owed. */
export interface IssuedStatement {
  readonly startsOn: string
  readonly closingOn: string
  /** Negative: what the statement says is owed at its closing. */
  readonly cents: number
  /** The payment deadline the statement prints, when it is known. */
  readonly dueOn: string | null
  /**
   * Whether payments made within the period already reduced `cents`, as in a
   * balance at the closing. False when the statement counts only the period's
   * charges and the payments printed with them settled earlier bills.
   */
  readonly netOfPayments: boolean
}

export type CycleStatus = 'open' | 'due' | 'paid' | 'partially_paid' | 'overdue'

export interface CardCycle extends CycleBounds {
  /** The last day to pay without being late: the due date, or the business day it moves to. */
  readonly payableUntil: string
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
    /** Payment credit the statement already deducts: paid within the cycle or carried from before. */
    readonly deductedCents: number
    /** The statement minus the entries and the payments it deducts. */
    readonly differenceCents: number
  } | null
}

export interface CardCycles {
  readonly cycles: ReadonlyArray<CardCycle>
  /** Payments and closed cycles' net credit beyond everything billed so far: credit on the card. */
  readonly unappliedCents: number
}

// An issued closing replaces the forecast it is near; beyond this it is a different cycle.
const replacesForecastWithinDays = 15
// The shortest cycle a forecast may open after an issued closing.
const minimumCycleDays = 20

/**
 * Closings from the first movement to `through`. Issued statements set their
 * own closings (and the day before their period, the previous closing), and
 * no forecast falls inside a period a statement covers; configured days fill
 * only the months between issued periods.
 */
const closings = (
  first: string,
  through: string,
  issued: ReadonlyArray<IssuedStatement>,
  terms: CardTermsInput,
) => {
  const actual = [
    ...new Set(
      issued.flatMap((statement) => [
        addDays(statement.startsOn, -1),
        statement.closingOn,
      ]),
    ),
  ].sort()
  const covered = (date: string) =>
    issued.some(
      (statement) => statement.startsOn <= date && date <= statement.closingOn,
    )
  const result: Array<{ closingOn: string; closing: CycleBounds['closing'] }> =
    []
  let forecast = closingFor(first, terms.closingDay)
  for (;;) {
    const last = result.at(-1)?.closingOn
    const next = actual.find((date) =>
      last === undefined ? date >= first : date > last,
    )
    // A forecast inside an issued period is that period's closing: `next` is
    // at the latest the period's own closing.
    const chosen =
      next !== undefined &&
      (covered(forecast) ||
        next <= addDays(forecast, replacesForecastWithinDays))
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

/** The cycles' bounds and what each one bills, before any payment. */
interface Schedule {
  readonly bounds: ReadonlyArray<CycleBounds>
  readonly statements: ReadonlyArray<IssuedStatement | undefined>
  readonly entries: ReadonlyArray<ReadonlyArray<CycleEntry>>
  readonly totals: ReadonlyArray<number>
  /** Positive when owed. */
  readonly billed: ReadonlyArray<number>
}

const schedule = (input: {
  readonly terms: CardTermsInput
  readonly entries: ReadonlyArray<CycleEntry>
  readonly payments: ReadonlyArray<CyclePayment>
  readonly statements: ReadonlyArray<IssuedStatement>
  readonly today: string
}): Schedule | null => {
  const dates = [
    ...input.entries.map((entry) => entry.bookedOn),
    ...input.payments.map((payment) => payment.paidOn),
    ...input.statements.map((statement) => statement.startsOn),
  ]
  if (dates.length === 0) return null
  const first = dates.reduce((a, b) => (a < b ? a : b))
  const lastStatement = input.statements
    .map((statement) => statement.closingOn)
    .reduce((a, b) => (a > b ? a : b), input.today)

  // The latest report of a statement speaks for it.
  const statementOf = new Map<string, IssuedStatement>()
  for (const statement of input.statements)
    statementOf.set(statement.closingOn, statement)
  const ends = closings(
    first,
    lastStatement,
    [...statementOf.values()],
    input.terms,
  )

  const firstStart = (closingOn: string) => {
    const issued = statementOf.get(closingOn)?.startsOn
    const forecast = addDays(
      dayOfMonth(monthStart(closingOn, -1), input.terms.closingDay),
      1,
    )
    const start = issued ?? forecast
    return start < first ? start : first
  }
  const bounds = ends.map((end, index): CycleBounds => {
    const printed = statementOf.get(end.closingOn)?.dueOn ?? null
    return {
      startsOn:
        index === 0
          ? firstStart(end.closingOn)
          : addDays(ends[index - 1]!.closingOn, 1),
      closingOn: end.closingOn,
      dueOn: printed ?? dueAfter(end.closingOn, input.terms.dueDay),
      closing: end.closing,
      due: printed === null ? 'forecast' : 'statement',
    }
  })
  // The cycle a date falls in; the last one after every closing.
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
  const entries = bounds.map((): Array<CycleEntry> => [])
  for (const entry of input.entries) {
    const date =
      entry.billId === null ? entry.bookedOn : latestOfBill.get(entry.billId)!
    entries[cycleOf(date)]!.push(entry)
  }

  const statements = bounds.map((cycle) => statementOf.get(cycle.closingOn))
  const totals = entries.map((items) =>
    items.reduce((sum, entry) => sum + entry.amountCents, 0),
  )
  const billed = bounds.map(
    (_, index) => 0 - (statements[index]?.cents ?? totals[index]!),
  )
  return { bounds, statements, entries, totals, billed }
}

/**
 * Applies payments in the order they reached the card. A payment identified
 * as paying one bill goes to it first, then to the bills closed before it
 * reached the card, oldest first. What is left is credit, spent oldest first
 * as each later cycle closes. A statement net of payments already deducts
 * the credit it can reflect, so that part is not applied to it again; the
 * credit it shows as a balance in the holder's favour stays credit.
 *
 * A closed cycle whose credits exceed its charges leaves that surplus as
 * credit too, for the cycles after it. When the cycle has a balance
 * statement, only the favour the payments it deducts do not explain is
 * surplus; a later balance statement that shows the credit deducts it.
 */
const allocate = (
  { bounds, statements, entries, totals, billed }: Schedule,
  payments: ReadonlyArray<CyclePayment>,
) => {
  const applied = bounds.map((): Array<CyclePayment> => [])
  const paid = bounds.map(() => 0)
  const deducted = bounds.map(() => 0)
  // Payment money not applied yet, oldest first.
  const credit: Array<{ payment: CyclePayment; cents: number }> = []
  const creditCents = () => credit.reduce((sum, held) => sum + held.cents, 0)
  const pay = (index: number, payment: CyclePayment, cents: number) => {
    const part = Math.min(billed[index]! - paid[index]!, cents)
    if (part <= 0) return 0
    paid[index]! += part
    applied[index]!.push({ ...payment, amountCents: part })
    return part
  }
  const spend = (through: number) => {
    for (const held of credit)
      for (let index = 0; index <= through && held.cents > 0; index++)
        held.cents -= pay(index, held.payment, held.cents)
  }
  // The open cycle's credit is not left for anything yet.
  const leaveSurplus = (index: number, cents: number) => {
    if (cents <= 0 || index === bounds.length - 1) return
    const closingOn = bounds[index]!.closingOn
    const latest = (items: ReadonlyArray<CycleEntry>) =>
      items.reduce<CycleEntry | undefined>(
        (found, item) =>
          found === undefined || item.bookedOn >= found.bookedOn ? item : found,
        undefined,
      )
    const source =
      latest(entries[index]!.filter((item) => item.amountCents > 0)) ??
      latest(entries[index]!)
    credit.push({
      payment: {
        entryId: source?.id ?? `statement:${closingOn}`,
        paidOn: closingOn,
        creditedOn: closingOn,
        amountCents: cents,
        via: 'credit',
      },
      cents,
    })
  }
  const settle = (index: number) => {
    if (statements[index]?.netOfPayments !== true) {
      spend(index)
      return leaveSurplus(index, -billed[index]!)
    }
    spend(index - 1)
    // A balance counts the cycle's charges and the debt carried into it,
    // less the payments it deducts: it can reflect no more than that.
    let carried = 0
    for (let older = 0; older < index; older++)
      carried += Math.max(0, billed[older]! - paid[older]!)
    const reflects = Math.max(0, carried - totals[index]! - billed[index]!)
    deducted[index] = Math.min(creditCents(), reflects)
    let consumed = deducted[index]! - Math.max(0, -billed[index]!)
    for (const held of credit) {
      if (consumed <= 0) break
      const part = Math.min(held.cents, consumed)
      held.cents -= part
      consumed -= part
    }
    leaveSurplus(index, -billed[index]! - deducted[index]!)
  }
  let closed = 0
  const closeBefore = (date: string) => {
    while (closed < bounds.length && bounds[closed]!.closingOn < date)
      settle(closed++)
  }

  const creditedOn = (payment: CyclePayment) =>
    payment.creditedOn ?? payment.paidOn
  const ordered = [...payments].sort(
    (a, b) =>
      creditedOn(a).localeCompare(creditedOn(b)) ||
      a.paidOn.localeCompare(b.paidOn) ||
      a.entryId.localeCompare(b.entryId),
  )
  for (const payment of ordered) {
    closeBefore(creditedOn(payment))
    let remaining = payment.amountCents
    if (payment.settles !== undefined) {
      const index = bounds.findIndex(
        (cycle) => cycle.closingOn === payment.settles,
      )
      if (index !== -1) remaining -= pay(index, payment, remaining)
    }
    for (let index = 0; index < closed && remaining > 0; index++)
      remaining -= pay(index, payment, remaining)
    if (remaining > 0) credit.push({ payment, cents: remaining })
  }
  while (closed < bounds.length) settle(closed++)
  return { applied, paid, deducted, unappliedCents: creditCents() }
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
 * Payments apply in the order they reached the card: to the bill they were
 * identified as paying, else to the oldest cycle that still owes. What a
 * payment leaves is credit that pays the following cycles as they close
 * (and the open one in advance), so a payment can settle several bills.
 * What exceeds everything billed is unapplied credit.
 *
 * A cycle is overdue only after `payableUntil`: a due date on a weekend,
 * printed or forecast, moves to the next business day.
 */
export const cardCycles = (input: {
  readonly terms: CardTermsInput
  readonly entries: ReadonlyArray<CycleEntry>
  readonly payments: ReadonlyArray<CyclePayment>
  readonly statements: ReadonlyArray<IssuedStatement>
  readonly today: string
}): CardCycles => {
  const plan = schedule(input)
  if (plan === null) return { cycles: [], unappliedCents: 0 }
  const { applied, paid, deducted, unappliedCents } = allocate(
    plan,
    input.payments,
  )

  const cycles = plan.bounds.map((cycle, index): CardCycle => {
    const statement = plan.statements[index]
    const billed = plan.billed[index]!
    const owed = billed - paid[index]!
    const payableUntil = nextBusinessDay(cycle.dueOn)
    const status: CycleStatus =
      input.today <= cycle.closingOn
        ? 'open'
        : owed <= 0
          ? 'paid'
          : input.today > payableUntil
            ? 'overdue'
            : paid[index]! > 0
              ? 'partially_paid'
              : 'due'
    return {
      ...cycle,
      payableUntil,
      status,
      totalCents: plan.totals[index]!,
      billedCents: billed,
      paidCents: paid[index]!,
      entryIds: plan.entries[index]!.map((entry) => entry.id),
      payments: applied[index]!,
      statement: statement
        ? {
            observedCents: statement.cents,
            deductedCents: deducted[index]!,
            differenceCents:
              statement.cents - plan.totals[index]! - deducted[index]!,
          }
        : null,
    }
  })
  return { cycles, unappliedCents }
}

/** A bank debit that names this card's bill but has no card-side payment. */
export interface BillDebit {
  readonly entryId: string
  readonly paidOn: string
  /** Positive: what left the bank. */
  readonly amountCents: number
}

/** A bill is paid within this many days of its closing. */
export const billPaymentWindowDays = 45

/**
 * The bank debits that pay a bill, when the card side of the payment is
 * missing. Each debit is judged in date order against what was owed on its
 * own date, counting only the payments made before it: its amount must be
 * exactly what one cycle closed within the payment window still owed. The
 * payment carries that bill, so it pays it rather than the oldest one.
 */
export const billPayments = (input: {
  readonly terms: CardTermsInput
  readonly entries: ReadonlyArray<CycleEntry>
  readonly payments: ReadonlyArray<CyclePayment>
  readonly statements: ReadonlyArray<IssuedStatement>
  readonly today: string
  readonly debits: ReadonlyArray<BillDebit>
}): ReadonlyArray<CyclePayment> => {
  const plan = schedule(input)
  if (plan === null) return []
  const inferred: Array<CyclePayment> = []
  const debits = [...input.debits].sort(
    (a, b) =>
      a.paidOn.localeCompare(b.paidOn) || a.entryId.localeCompare(b.entryId),
  )
  for (const debit of debits) {
    const { paid } = allocate(plan, [
      ...input.payments.filter((payment) => payment.paidOn < debit.paidOn),
      ...inferred,
    ])
    const settles = plan.bounds.filter(
      (cycle, index) =>
        cycle.closingOn < debit.paidOn &&
        debit.paidOn <= addDays(cycle.closingOn, billPaymentWindowDays) &&
        plan.billed[index]! - paid[index]! === debit.amountCents,
    )
    if (settles.length !== 1) continue
    inferred.push({
      entryId: debit.entryId,
      paidOn: debit.paidOn,
      amountCents: debit.amountCents,
      via: 'bank',
      settles: settles[0]!.closingOn,
    })
  }
  return inferred
}
