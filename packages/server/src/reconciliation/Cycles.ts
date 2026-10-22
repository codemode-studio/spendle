import { nextBusinessDay } from '../domain/BankingCalendar.ts'
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
 * moved to the next business day. Days are compared after clamping to the month,
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
  /**
   * The closing of the imported statement that prints this movement, when
   * one does. The statement decides its cycle over the purchase date, which
   * may fall before the cut when the purchase was captured after it.
   */
  readonly statementClosing?: string | null
  /**
   * Still pending at the provider: not billed yet. Pluggy reports a card
   * charge as pending until its bill comes due, then posts it with the
   * bill's id.
   */
  readonly pending?: boolean
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
  /**
   * The closing of the imported statement that prints this payment, when
   * one does. A statement prints the payments of earlier bills made in its
   * period, so the payment pays those first: all of it when the statement
   * counts only its period's charges, and what its balance does not show as
   * paid in advance when it is a balance.
   */
  readonly statementClosing?: string | null
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
  /**
   * Whether `cents` is an amount due printed as zero when credit exceeds
   * what is owed, as Inter's "Fatura atual": a zero then does not say how
   * much credit is left. Otherwise `cents` is a signed balance.
   */
  readonly floorsAtZero: boolean
  /**
   * What a balance statement prints as paid in advance of its own charges,
   * when it prints it. Its printed payments beyond this paid earlier bills.
   */
  readonly advanceCents: number | null
}

export type CycleStatus = 'open' | 'due' | 'paid' | 'partially_paid' | 'overdue'

export interface CardCycle extends CycleBounds {
  /** The last day to pay without being late: the due date, or the business day it moves to. */
  readonly payableUntil: string
  readonly status: CycleStatus
  /** Posted purchases and credits of the cycle; negative when something is owed. */
  readonly totalCents: number
  /**
   * What the cycle bills: the issued statement's total, else the posted
   * entries' total. Positive when owed. When the statement prints nothing
   * due but the entries prove credit beyond it, that credit, negative.
   */
  readonly billedCents: number
  /**
   * Pending purchases less pending credits placed in the cycle, positive
   * when owed: charges the bill will carry once the provider posts them.
   * Zero when an issued statement sets the bill.
   */
  readonly pendingCents: number
  /**
   * What the cycle is expected to bill: `billedCents` plus `pendingCents`.
   * Payments and the status count against it, so a bill whose charges are
   * still pending is not taken for paid.
   */
  readonly projectedCents: number
  /**
   * Debt of earlier cycles a balance statement carries in `billedCents`.
   * Those cycles still owe it, so this cycle owes `billedCents` less this.
   */
  readonly carriedCents: number
  readonly paidCents: number
  readonly entryIds: ReadonlyArray<string>
  /** The part of each payment applied to this cycle. */
  readonly payments: ReadonlyArray<CyclePayment>
  /** The issued statement's total and how far the entries are from it. */
  readonly statement: {
    readonly observedCents: number
    /** Payment credit the statement already deducts: paid within the cycle or carried from before. */
    readonly deductedCents: number
    /** The statement minus the entries, the debt it carries and the payments it deducts. */
    readonly differenceCents: number
  } | null
}

export interface CardCycles {
  readonly cycles: ReadonlyArray<CardCycle>
  /** Payments and closed cycles' net credit beyond everything billed so far: credit on the card. */
  readonly unappliedCents: number
  /**
   * Payments a statement prints for earlier bills when no earlier bill is
   * imported: they paid debt from before the history, so they are neither
   * applied to a cycle nor credit on the card.
   */
  readonly beforeHistoryCents: number
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
  /** Posted entries only. */
  readonly totals: ReadonlyArray<number>
  /** Pending entries, positive when owed; zero under an issued statement. */
  readonly pending: ReadonlyArray<number>
  /** What each cycle is expected to bill, pending charges included; positive when owed. */
  readonly projected: ReadonlyArray<number>
}

const schedule = (input: {
  readonly terms: CardTermsInput
  readonly entries: ReadonlyArray<CycleEntry>
  readonly payments: ReadonlyArray<CyclePayment>
  readonly statements: ReadonlyArray<IssuedStatement>
  readonly today: string
}): Schedule | null => {
  // The latest report of a statement speaks for it.
  const statementOf = new Map<string, IssuedStatement>()
  for (const statement of input.statements)
    statementOf.set(statement.closingOn, statement)

  // Where each entry belongs, most authoritative first: the issued statement
  // that prints it, or that prints another movement of its provider bill;
  // else the latest date of its provider bill; else its own date.
  const printedOn = (entry: CycleEntry) =>
    entry.statementClosing != null && statementOf.has(entry.statementClosing)
      ? entry.statementClosing
      : undefined
  const billStatement = new Map<string, string>()
  const latestOfBill = new Map<string, string>()
  for (const entry of input.entries) {
    if (entry.billId === null) continue
    const printed = printedOn(entry)
    const statement = billStatement.get(entry.billId)
    if (
      printed !== undefined &&
      (statement === undefined || printed > statement)
    )
      billStatement.set(entry.billId, printed)
    const latest = latestOfBill.get(entry.billId)
    if (latest === undefined || entry.bookedOn > latest)
      latestOfBill.set(entry.billId, entry.bookedOn)
  }
  // The date that places each entry: a statement's closing, which ends its
  // cycle, or the date its cycle contains. A purchase date before the
  // statement that bills it opens no cycle of its own.
  const placements = input.entries.map((entry) =>
    entry.billId === null
      ? (printedOn(entry) ?? entry.bookedOn)
      : (printedOn(entry) ??
        billStatement.get(entry.billId) ??
        latestOfBill.get(entry.billId)!),
  )

  const dates = [
    // A pending charge dated after today is a later bill's instalment.
    ...placements.filter(
      (date, index) => !input.entries[index]!.pending || date <= input.today,
    ),
    ...input.payments.map((payment) => payment.paidOn),
    ...input.statements.map((statement) => statement.startsOn),
  ]
  if (dates.length === 0) return null
  const first = dates.reduce((a, b) => (a < b ? a : b))
  const lastStatement = input.statements
    .map((statement) => statement.closingOn)
    .reduce((a, b) => (a > b ? a : b), input.today)

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

  const lastClosing = bounds.at(-1)!.closingOn
  const entries = bounds.map((): Array<CycleEntry> => [])
  input.entries.forEach((entry, index) => {
    const placed = cycleOf(placements[index]!)
    if (!entry.pending) return entries[placed]!.push(entry)
    // Past the open bill's closing: a later bill's instalment, not a cycle's yet.
    if (placements[index]! > lastClosing) return
    // The provider posts a bill's charges once it comes due, so one still
    // pending in a cycle already due was captured after that cut: it is on
    // the next bill not yet due.
    const notDue = bounds.findIndex(
      (cycle, at) => at >= placed && cycle.dueOn >= input.today,
    )
    entries[notDue === -1 ? placed : notDue]!.push(entry)
  })

  const statements = bounds.map((cycle) => statementOf.get(cycle.closingOn))
  const sum = (items: ReadonlyArray<CycleEntry>) =>
    items.reduce((total, entry) => total + entry.amountCents, 0)
  const totals = entries.map((items) =>
    sum(items.filter((entry) => !entry.pending)),
  )
  // An issued statement already counts what it bills.
  const pending = entries.map((items, index) =>
    statements[index] === undefined
      ? 0 - sum(items.filter((entry) => entry.pending))
      : 0,
  )
  const projected = bounds.map(
    (_, index) =>
      pending[index]! - (statements[index]?.cents ?? totals[index]!),
  )
  return { bounds, statements, entries, totals, pending, projected }
}

/**
 * Applies payments in the order they reached the card. A payment identified
 * as paying one bill goes to it first, then to the bills closed before it
 * reached the card, oldest first. What is left is credit, spent oldest first
 * as each later cycle closes. A statement net of payments already deducts
 * the credit it can reflect, so that part is not applied to it again; the
 * credit it shows as a balance in the holder's favour stays credit.
 *
 * A balance statement also counts the debt carried into it from earlier
 * unpaid cycles, as far as its total exceeds its own entries. That debt
 * stays with the cycles that incurred it, so the balance cycle owes only the
 * rest, and paying the whole balance settles both without charging the
 * carried debt twice.
 *
 * A closed cycle whose credits exceed its charges leaves that surplus as
 * credit too: first for the debt it carried, then for the cycles after it.
 * When the cycle has a balance statement, only the favour the payments it
 * deducts do not explain is surplus; a later balance statement that shows
 * the credit deducts it. An amount due printed as zero hides how much favour
 * is left, so the entries, net of the carried debt, tell it.
 *
 * A payment printed on a statement that counts only its period's charges
 * paid an earlier bill: it pays the cycles before that statement, and only
 * what exceeds what they billed is credit. When no earlier cycle bills
 * anything, the bill it paid is from before the history, so it is kept
 * apart rather than paying the statement that prints it in advance.
 *
 * A balance statement's printed payments paid the debt from before it
 * first; only what its balance shows beyond that, as less owed than its own
 * entries, is an advance. That advance is what the statement prints as
 * paid in advance, or else what the entries exceed the balance by, whatever
 * debt the balance carries, so the rest of the printed payments is treated
 * like a charges-only statement's. An amount due printed as zero does not
 * tell how far below zero the balance went, so without a printed advance
 * its printed payments are all taken as advance.
 *
 * With `asOf`, allocation stops at that date: only cycles closed before it
 * are settled, so credit that reached the card later is not spent.
 */
const allocate = (
  { bounds, statements, entries, totals, projected: scheduled }: Schedule,
  payments: ReadonlyArray<CyclePayment>,
  asOf?: string,
) => {
  const applied = bounds.map((): Array<CyclePayment> => [])
  const paid = bounds.map(() => 0)
  const deducted = bounds.map(() => 0)
  const billed = [...scheduled]
  const carried = bounds.map(() => 0)
  // What a cycle owes itself: its bill less the debt it carries.
  const owes = (index: number) => billed[index]! - carried[index]!
  const outstanding = (index: number) => Math.max(0, owes(index) - paid[index]!)
  // Payment money not applied yet, oldest first.
  const credit: Array<{ payment: CyclePayment; cents: number }> = []
  const creditCents = () => credit.reduce((sum, held) => sum + held.cents, 0)
  const pay = (index: number, payment: CyclePayment, cents: number) => {
    const part = Math.min(owes(index) - paid[index]!, cents)
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
    const statement = statements[index]
    if (statement?.netOfPayments !== true) {
      spend(index)
      return leaveSurplus(index, -billed[index]!)
    }
    spend(index - 1)
    // A balance counts the cycle's charges and the debt carried into it,
    // less the payments it deducts: it can reflect no more than that.
    let unpaid = 0
    for (let older = 0; older < index; older++) unpaid += outstanding(older)
    const own = totals[index]!
    if (statement.floorsAtZero && billed[index] === 0)
      billed[index] = Math.min(0, unpaid - own)
    carried[index] = Math.min(unpaid, Math.max(0, billed[index]! + own))
    const reflects = Math.max(0, carried[index]! - own - billed[index]!)
    deducted[index] = Math.min(creditCents(), reflects)
    let consumed = deducted[index]! - Math.max(0, -owes(index))
    for (const held of credit) {
      if (consumed <= 0) break
      const part = Math.min(held.cents, consumed)
      held.cents -= part
      consumed -= part
    }
    leaveSurplus(index, -owes(index) - deducted[index]!)
  }
  let closed = 0
  const closeBefore = (date: string) => {
    const until = asOf !== undefined && asOf < date ? asOf : date
    while (closed < bounds.length && bounds[closed]!.closingOn < until)
      settle(closed++)
  }
  // The cycle of the issued statement that prints a payment.
  const printedBy = (payment: CyclePayment) => {
    if (payment.statementClosing == null) return undefined
    const index = bounds.findIndex(
      (cycle) => cycle.closingOn === payment.statementClosing,
    )
    return index !== -1 && statements[index] !== undefined ? index : undefined
  }
  // Whether any cycle before `index` bills something: a debt the history shows.
  const billsBefore = (index: number) =>
    bounds
      .slice(0, index)
      .some(
        (_, older) =>
          statements[older] !== undefined || entries[older]!.length > 0,
      )
  let beforeHistory = 0

  const creditedOn = (payment: CyclePayment) =>
    payment.creditedOn ?? payment.paidOn
  const ordered = [...payments].sort(
    (a, b) =>
      creditedOn(a).localeCompare(creditedOn(b)) ||
      a.paidOn.localeCompare(b.paidOn) ||
      a.entryId.localeCompare(b.entryId),
  )
  // The part of each printed payment that paid debt from before its
  // statement. A balance statement shows as paid in advance what it prints
  // as such, else what its entries exceed it by; its other printed payments
  // paid the earlier debt.
  const advance = statements.map((statement, index) =>
    statement === undefined || !statement.netOfPayments
      ? 0
      : statement.advanceCents !== null
        ? statement.advanceCents
        : statement.floorsAtZero && statement.cents === 0
          ? Infinity
          : Math.max(0, -(scheduled[index]! + totals[index]!)),
  )
  const prior = new Map<CyclePayment, number>()
  for (const payment of ordered) {
    const index = printedBy(payment)
    if (index === undefined) continue
    const ahead = Math.min(payment.amountCents, advance[index]!)
    advance[index]! -= ahead
    prior.set(payment, payment.amountCents - ahead)
  }
  for (const payment of ordered) {
    closeBefore(creditedOn(payment))
    let remaining = payment.amountCents
    if (payment.settles !== undefined) {
      const index = bounds.findIndex(
        (cycle) => cycle.closingOn === payment.settles,
      )
      if (index !== -1) remaining -= pay(index, payment, remaining)
    }
    const printed = printedBy(payment)
    const earlier = Math.min(closed, printed ?? closed)
    let before = prior.get(payment) ?? 0
    for (let index = 0; index < earlier && remaining > 0; index++) {
      const part = pay(index, payment, remaining)
      remaining -= part
      before -= part
    }
    if (printed !== undefined && !billsBefore(printed)) {
      const kept = Math.min(remaining, Math.max(0, before))
      beforeHistory += kept
      remaining -= kept
    }
    if (remaining > 0) credit.push({ payment, cents: remaining })
  }
  if (asOf === undefined) while (closed < bounds.length) settle(closed++)
  else closeBefore(asOf)
  return {
    applied,
    paid,
    deducted,
    billed,
    carried,
    owes: bounds.map((_, index) => owes(index)),
    unappliedCents: creditCents(),
    beforeHistoryCents: beforeHistory,
  }
}

/**
 * Builds the card's statement cycles from the first movement or statement
 * to today, and applies payments to them.
 *
 * Cycle bounds come from issued statements when there are any; configured
 * closing and due days are a forecast for the rest. An entry belongs to the
 * cycle of the imported statement that prints it; else, when the provider
 * assigns it to a bill, to the statement that prints any movement of that
 * bill, or the cycle of the latest of them; else to the cycle containing its
 * date. Its date is kept as reported: a purchase captured after the cut is
 * dated before the statement that bills it.
 *
 * A pending charge is not billed yet but counts towards what its cycle is
 * expected to bill. It belongs to the cycle containing its date while that
 * bill is not due; one dated in a bill already due is on the next bill not
 * yet due, and one dated after the open bill's closing is left to the
 * instalment plans.
 *
 * What a cycle owes is its issued statement's total when there is one, since
 * imported entries may be incomplete; the difference from the entries is
 * reported as the statement proof, apart from payment status.
 *
 * Payments apply in the order they reached the card: to the bill they were
 * identified as paying, else to the oldest cycle that still owes. What a
 * payment leaves is credit that pays the following cycles as they close
 * (and the open one in advance), so a payment can settle several bills.
 * What exceeds everything billed is unapplied credit. A payment a
 * statement prints pays the bills before it, except what a balance
 * statement shows as paid in advance; with none imported, that debt is
 * from before the history and the payment is kept apart.
 *
 * A cycle is overdue only after `payableUntil`: a due date on a weekend or
 * national bank holiday, printed or forecast, moves to the next business day.
 */
export const cardCycles = (input: {
  readonly terms: CardTermsInput
  readonly entries: ReadonlyArray<CycleEntry>
  readonly payments: ReadonlyArray<CyclePayment>
  readonly statements: ReadonlyArray<IssuedStatement>
  readonly today: string
}): CardCycles => {
  const plan = schedule(input)
  if (plan === null)
    return { cycles: [], unappliedCents: 0, beforeHistoryCents: 0 }
  const {
    applied,
    paid,
    deducted,
    billed: projected,
    carried,
    owes,
    unappliedCents,
    beforeHistoryCents,
  } = allocate(plan, input.payments)

  const cycles = plan.bounds.map((cycle, index): CardCycle => {
    const statement = plan.statements[index]
    const owed = owes[index]! - paid[index]!
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
      billedCents: projected[index]! - plan.pending[index]!,
      pendingCents: plan.pending[index]!,
      projectedCents: projected[index]!,
      carriedCents: carried[index]!,
      paidCents: paid[index]!,
      entryIds: plan.entries[index]!.map((entry) => entry.id),
      payments: applied[index]!,
      statement: statement
        ? {
            observedCents: statement.cents,
            deductedCents: deducted[index]!,
            differenceCents:
              -projected[index]! -
              plan.totals[index]! +
              carried[index]! -
              deducted[index]!,
          }
        : null,
    }
  })
  return { cycles, unappliedCents, beforeHistoryCents }
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
 * own date, counting only the payments made before it and the credit of
 * cycles closed before it, not a later refund: its amount must be
 * exactly what one cycle closed within the payment window still owed, or
 * what its balance statement still asks, the debt it carries included. The
 * payment carries that bill, so it pays it (and then the debt it carries,
 * oldest first) rather than the oldest one.
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
    const { paid, owes, carried } = allocate(
      plan,
      [
        ...input.payments.filter((payment) => payment.paidOn < debit.paidOn),
        ...inferred,
      ],
      debit.paidOn,
    )
    const outstanding = owes.map((owed, index) =>
      Math.max(0, owed - paid[index]!),
    )
    const settles = plan.bounds.filter((cycle, index) => {
      if (
        cycle.closingOn >= debit.paidOn ||
        debit.paidOn > addDays(cycle.closingOn, billPaymentWindowDays)
      )
        return false
      const own = owes[index]! - paid[index]!
      const stillCarried = Math.min(
        carried[index]!,
        outstanding.slice(0, index).reduce((sum, cents) => sum + cents, 0),
      )
      return (
        own === debit.amountCents ||
        (stillCarried > 0 && own + stillCarried === debit.amountCents)
      )
    })
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
