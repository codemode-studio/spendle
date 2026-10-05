/**
 * The family's month as a projection of entries, card cycles, recurrences
 * and the plan: what came in, what was spent per envelope, what is still
 * due, what was saved, how cash moved, and what blocks closing. Pure:
 * amounts are integer centavos in the base currency (BRL; V2 has no
 * exchange rates yet, so other currencies stay out and are counted).
 */
import { addDays, monthStart } from '../domain/LocalDate.ts'
import { cycleContaining } from '../reconciliation/Cycles.ts'
import { knowledgeExactPatterns } from '../categories/Patterns.ts'
import { conservativeBase, effectiveAllocation, targetsFor } from './Budget.ts'
import type { Allocation, AllocationBucket } from './Budget.ts'
import { acceptedEntries } from './RecurrencePolicy.ts'
import type { BookRecurrence, Occurrence } from './RecurrencePolicy.ts'
import { aggregateWindow, scheduleDates } from './Schedule.ts'

export const baseCurrency = 'BRL'

export interface MonthAccount {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly purpose: 'operating' | 'reserve' | 'investment'
  readonly currency: string
  readonly archived: boolean
  /** Owned by a company: outside the family's budget. */
  readonly company: boolean
  readonly card: { readonly closingDay: number; readonly dueDay: number } | null
}

export interface MonthEntry {
  readonly id: string
  readonly accountId: string
  readonly bookedOn: string
  readonly amountCents: number
  readonly description: string
  readonly status: 'pending' | 'posted'
  readonly categoryId: string | null
  /** The category's bucket; null without a category. */
  readonly bucket: string | null
  readonly categoryStatus: 'applied' | 'review' | 'none'
  /** Money moving between the person's own accounts. */
  readonly excludedFromSpending: boolean
}

export interface MonthRelation {
  readonly kind: 'internal_transfer' | 'card_payment' | 'refund'
  readonly status: 'suggested' | 'confirmed' | 'conflict'
  readonly outflowEntryId: string
  readonly inflowEntryId: string
}

export interface MonthCycle {
  readonly accountId: string
  readonly closingOn: string
  readonly dueOn: string
  /** What the cycle bills; positive when owed. */
  readonly billedCents: number
  readonly paidCents: number
  readonly entryIds: ReadonlyArray<string>
}

export interface MonthInstallment {
  readonly accountId: string
  /** One instalment; negative. */
  readonly amountCents: number
  readonly total: number
  readonly seen: ReadonlyArray<number>
  readonly scheduled: ReadonlyArray<number>
  readonly entryIds: ReadonlyArray<string>
  readonly lastBookedOn: string
}

export interface Checkpoint {
  readonly accountId: string
  /** The balance at the end of this day. */
  readonly asOf: string
  readonly balanceCents: number
}

export interface PlanSettings {
  readonly monthlyIncomeTargetCents: number
  readonly reserveMonths: number
  readonly keepReserveContributions: boolean
}

export interface PlanStrategy {
  readonly id: string
  readonly name: string
  readonly allocation: Allocation
  readonly isDefault: boolean
}

/** A closed month, frozen. */
export interface ClosedBudget {
  readonly month: string
  readonly strategyId: string
  readonly strategyName: string
  readonly baseIncomeCents: number
  readonly eligibleIncomeCents: number
  readonly allocation: Allocation
  readonly effectiveAllocation: Allocation
  readonly reserveRedirected: boolean
}

export interface PlanGoal {
  readonly id: string
  readonly type: 'emergency_reserve' | 'medium_term' | 'retirement' | 'other'
  readonly targetCents: number
  readonly currentCents: number
}

export interface MonthFacts {
  readonly today: string
  readonly accounts: ReadonlyArray<MonthAccount>
  readonly entries: ReadonlyArray<MonthEntry>
  readonly relations: ReadonlyArray<MonthRelation>
  readonly cycles: ReadonlyArray<MonthCycle>
  readonly installments: ReadonlyArray<MonthInstallment>
  readonly checkpoints: ReadonlyArray<Checkpoint>
  readonly book: ReadonlyArray<BookRecurrence>
  readonly settings: PlanSettings
  readonly strategies: ReadonlyArray<PlanStrategy>
  readonly budgets: ReadonlyArray<ClosedBudget>
  readonly goals: ReadonlyArray<PlanGoal>
  /**
   * What the investment positions marked as reserve are worth now, in
   * reais; null while no position is marked, and the emergency goal's own
   * amount stands in.
   */
  readonly reserveInvestedCents: number | null
  /** Each category's bucket. */
  readonly categoryBuckets: ReadonlyMap<string, string>
}

export type LineBucket = AllocationBucket | 'other'

export interface MonthLine {
  readonly id: string
  readonly description: string
  readonly date: string
  readonly cents: number
  readonly paidCents: number
  readonly categoryId: string | null
  readonly bucket: LineBucket
  readonly entryId: string | null
  readonly certainty: 'documented' | 'scheduled' | 'estimated'
  readonly origin: 'account' | 'card' | 'recurrence' | 'envelope'
}

export type IssueCode =
  | 'uncategorized'
  | 'category_review'
  | 'pending_entry'
  | 'suggested_reconciliation'
  | 'overdue_recurrence'
  | 'recurrence_category_conflict'
  | 'missing_balance'
  | 'other_currency'

export interface IntegrityIssue {
  readonly code: IssueCode
  readonly count: number
  readonly blocksClosing: boolean
}

const lineBucket = (bucket: string | null): LineBucket =>
  bucket === 'essential' ||
  bucket === 'lifestyle' ||
  bucket === 'investment' ||
  bucket === 'reserve'
    ? bucket
    : 'other'

export const monthEnd = (month: string) =>
  addDays(monthStart(`${month}-01`, 1), -1)

const inMonth = (date: string, month: string) => date.startsWith(`${month}-`)

/** Shared lookups over the facts, built once per read. */
export const indexFacts = (facts: MonthFacts) => {
  const accountById = new Map(
    facts.accounts.map((account) => [account.id, account]),
  )
  const entryById = new Map(facts.entries.map((entry) => [entry.id, entry]))
  const internal = new Set(
    facts.relations
      .filter(
        (relation) =>
          relation.status === 'confirmed' && relation.kind !== 'refund',
      )
      .flatMap((relation) => [relation.outflowEntryId, relation.inflowEntryId]),
  )
  const brl = (entry: MonthEntry) =>
    accountById.get(entry.accountId)?.currency === baseCurrency
  const family = (entry: MonthEntry) => {
    const account = accountById.get(entry.accountId)
    return account !== undefined && !account.company
  }
  const cashAccounts = facts.accounts.filter(
    (account) =>
      !account.archived &&
      account.purpose === 'operating' &&
      account.card === null &&
      account.currency === baseCurrency,
  )
  const cashAccountIds = new Set(cashAccounts.map((account) => account.id))
  const accepted = acceptedEntries(facts.book)
  return {
    accountById,
    entryById,
    internal,
    brl,
    family,
    cashAccounts,
    cashAccountIds,
    accepted,
  }
}
type Index = ReturnType<typeof indexFacts>

/**
 * The operating cash at the end of `date`: each operating account from its
 * nearest balance checkpoint and the posted movements between. An account
 * with movements but no checkpoint has no known balance and is counted.
 */
export const cashAt = (facts: MonthFacts, index: Index, date: string) => {
  let cents = 0
  let known = 0
  let missing = 0
  for (const account of index.cashAccounts) {
    const anchors = facts.checkpoints
      .filter((checkpoint) => checkpoint.accountId === account.id)
      .sort((a, b) => a.asOf.localeCompare(b.asOf))
    const movements = facts.entries.filter(
      (entry) => entry.accountId === account.id && entry.status === 'posted',
    )
    const anchor =
      anchors.filter((checkpoint) => checkpoint.asOf <= date).at(-1) ??
      anchors[0]
    if (anchor === undefined) {
      if (movements.length > 0) missing++
      continue
    }
    known++
    cents +=
      anchor.asOf <= date
        ? anchor.balanceCents +
          movements
            .filter(
              (entry) => entry.bookedOn > anchor.asOf && entry.bookedOn <= date,
            )
            .reduce((sum, entry) => sum + entry.amountCents, 0)
        : anchor.balanceCents -
          movements
            .filter(
              (entry) => entry.bookedOn > date && entry.bookedOn <= anchor.asOf,
            )
            .reduce((sum, entry) => sum + entry.amountCents, 0)
  }
  return { cents: known > 0 ? cents : null, missing }
}

const cardTerms = (index: Index, accountId: string) =>
  index.accountById.get(accountId)?.card ?? null

/** When a charge on `accountId` on `date` is paid: its bill's due date, or the date itself. */
export const dueDateOf = (
  index: Index,
  accountId: string | null,
  date: string,
) => {
  const terms = accountId === null ? null : cardTerms(index, accountId)
  return terms === null ? date : cycleContaining(date, terms).dueOn
}

/**
 * Instalments of each plan no entry shows yet, dated one month apart after
 * the latest one seen, with the bill each lands on.
 */
export const futureInstalments = (facts: MonthFacts, index: Index) =>
  facts.installments.flatMap((plan) => {
    const terms = cardTerms(index, plan.accountId)
    if (terms === null) return []
    const base =
      plan.seen.length > 0 ? Math.max(...plan.seen) : (plan.scheduled[0] ?? 0)
    if (base === 0) return []
    const scheduled = new Set(plan.scheduled)
    const category = plan.entryIds
      .map((id) => index.entryById.get(id))
      .find(
        (entry) =>
          entry?.categoryId !== null && entry?.categoryId !== undefined,
      )
    const result: Array<{
      readonly accountId: string
      readonly number: number
      readonly total: number
      readonly date: string
      readonly dueOn: string
      readonly cents: number
      readonly categoryId: string | null
      readonly bucket: string | null
      readonly description: string
    }> = []
    for (let number = base + 1; number <= plan.total; number++) {
      if (scheduled.has(number)) continue
      const months = number - base
      const day = Number(plan.lastBookedOn.slice(8, 10))
      const first = monthStart(plan.lastBookedOn, months)
      const last = Number(addDays(monthStart(first, 1), -1).slice(8, 10))
      const date = `${first.slice(0, 8)}${String(Math.min(day, last)).padStart(2, '0')}`
      result.push({
        accountId: plan.accountId,
        number,
        total: plan.total,
        date,
        dueOn: cycleContaining(date, terms).dueOn,
        cents: Math.abs(plan.amountCents),
        categoryId: category?.categoryId ?? null,
        bucket: category?.bucket ?? null,
        description: `${category?.description ?? 'Parcela'} · ${number}/${plan.total}`,
      })
    }
    return result
  })

/** The occurrences of a recurrence through `horizon`, beyond those the book lists. */
export const forecastOccurrences = (
  recurrence: BookRecurrence,
  horizon: string,
) => {
  const listed = new Map(
    recurrence.occurrences.map((occurrence) => [
      occurrence.expectedDate,
      occurrence,
    ]),
  )
  const future: Array<Occurrence> = [...recurrence.occurrences]
  for (const date of scheduleDates(
    { ...recurrence.rule, startsOn: recurrence.nextDate },
    horizon,
  )) {
    if (listed.has(date)) continue
    future.push({
      id: `${recurrence.rule.id}|${date}`,
      recurrenceId: recurrence.rule.id,
      expectedDate: date,
      expectedAmountCents: recurrence.rule.amountCents,
      status: 'expected',
      matches: [],
    })
  }
  return future
}

/** Splits `paid` over lines by their share of `total`, in whole centavos. */
const spread = (
  amounts: ReadonlyArray<number>,
  total: number,
  paid: number,
) => {
  let allocated = 0
  return amounts.map((amount, index) => {
    const share =
      index === amounts.length - 1
        ? paid - allocated
        : total > 0
          ? Math.round((amount * paid) / total)
          : 0
    allocated += share
    return share
  })
}

/**
 * What the month owes, line by line: card bills due in it (their purchases,
 * instalments not yet billed and anything the bill shows beyond them),
 * account spending dated in it, and recurrences still expected in it.
 */
export const monthLines = (facts: MonthFacts, index: Index, month: string) => {
  const lines: Array<MonthLine> = []
  const warnings = new Set<string>()
  const counted = new Set<string>()

  for (const cycle of facts.cycles) {
    const account = index.accountById.get(cycle.accountId)
    if (!account || account.company || account.currency !== baseCurrency)
      continue
    if (!inMonth(cycle.dueOn, month)) continue
    const purchases = cycle.entryIds
      .map((id) => index.entryById.get(id))
      .filter(
        (entry): entry is MonthEntry =>
          entry !== undefined && !entry.excludedFromSpending,
      )
    const billLines: Array<Omit<MonthLine, 'paidCents'>> = purchases.map(
      (entry) => ({
        id: entry.id,
        description: entry.description,
        date: cycle.dueOn,
        cents: -entry.amountCents,
        categoryId: entry.categoryId,
        bucket: lineBucket(entry.bucket),
        entryId: entry.id,
        certainty: 'documented',
        origin: 'card',
      }),
    )
    const billed = Math.max(0, cycle.billedCents)
    const gap = billed - billLines.reduce((sum, line) => sum + line.cents, 0)
    if (gap !== 0 && billed > 0) {
      billLines.push({
        id: `${cycle.accountId}|${cycle.closingOn}|difference`,
        description: `${account.name} · composição não identificada`,
        date: cycle.dueOn,
        cents: gap,
        categoryId: null,
        bucket: 'other',
        entryId: null,
        certainty: cycle.closingOn < facts.today ? 'documented' : 'scheduled',
        origin: 'card',
      })
      warnings.add('Há saldo de fatura cuja composição não foi identificada.')
    }
    const paid = spread(
      billLines.map((line) => line.cents),
      billLines.reduce((sum, line) => sum + line.cents, 0),
      Math.min(billed, Math.max(0, cycle.paidCents)),
    )
    billLines.forEach((line, position) => {
      lines.push({ ...line, paidCents: paid[position]! })
      if (line.entryId) counted.add(line.entryId)
    })
  }

  for (const instalment of futureInstalments(facts, index)) {
    const account = index.accountById.get(instalment.accountId)
    if (!account || account.company || account.currency !== baseCurrency)
      continue
    if (!inMonth(instalment.dueOn, month)) continue
    lines.push({
      id: `${instalment.accountId}|${instalment.description}|${instalment.number}`,
      description: instalment.description,
      date: instalment.dueOn,
      cents: instalment.cents,
      paidCents: 0,
      categoryId: instalment.categoryId,
      bucket: lineBucket(instalment.bucket),
      entryId: null,
      certainty: 'scheduled',
      origin: 'card',
    })
  }

  for (const entry of facts.entries) {
    const account = index.accountById.get(entry.accountId)
    if (!account || account.company || account.card !== null) continue
    if (!inMonth(entry.bookedOn, month)) continue
    if (account.currency !== baseCurrency) continue
    if (index.internal.has(entry.id) || entry.excludedFromSpending) continue
    if (entry.bucket === 'investment' || entry.bucket === 'reserve') continue
    if (entry.bucket === 'income' || entry.bucket === 'excluded') continue
    if (entry.amountCents >= 0 && entry.bucket === null) continue
    lines.push({
      id: entry.id,
      description: entry.description,
      date: entry.bookedOn,
      cents: -entry.amountCents,
      paidCents: entry.status === 'posted' ? -entry.amountCents : 0,
      categoryId: entry.categoryId,
      bucket: lineBucket(entry.bucket),
      entryId: entry.id,
      certainty: 'documented',
      origin: 'account',
    })
    counted.add(entry.id)
  }

  const end = monthEnd(month)
  for (const recurrence of facts.book) {
    const { rule } = recurrence
    if (
      !rule.active ||
      rule.direction !== 'expense' ||
      rule.currency !== baseCurrency
    )
      continue
    // A card recurrence is paid with the bill its charge lands on.
    const horizon = addDays(end, 45)
    for (const occurrence of forecastOccurrences(recurrence, horizon)) {
      if (occurrence.status !== 'expected') continue
      const due = dueDateOf(index, rule.accountId, occurrence.expectedDate)
      if (!inMonth(due, month)) continue
      const window =
        rule.matchMode === 'aggregate'
          ? aggregateWindow(occurrence.expectedDate, rule)
          : null
      const covered = occurrence.matches
        .filter((match) => match.status !== 'suggested' || window === null)
        .map((match) => index.entryById.get(match.entryId))
        .filter(
          (entry): entry is MonthEntry =>
            entry !== undefined && counted.has(entry.id),
        )
      const coveredCents =
        window === null
          ? Math.abs(covered[0]?.amountCents ?? 0)
          : covered.reduce((sum, entry) => sum + Math.abs(entry.amountCents), 0)
      const remaining = Math.max(0, rule.amountCents - coveredCents)
      if (remaining === 0) continue
      lines.push({
        id: occurrence.id,
        description:
          window === null ? rule.name : `${rule.name} · restante da estimativa`,
        date: due,
        cents: remaining,
        paidCents: 0,
        categoryId: rule.categoryId,
        bucket: lineBucket(facts.categoryBuckets.get(rule.categoryId) ?? null),
        entryId: null,
        certainty: 'estimated',
        origin: window === null ? 'recurrence' : 'envelope',
      })
    }
  }
  return { lines, warnings: [...warnings] }
}

/** Saved into each savings envelope in the month: categorised contributions and transfers to reserve or investment accounts. */
export const savedIn = (facts: MonthFacts, index: Index, month: string) => {
  const saved = { investment: 0, reserve: 0 }
  for (const entry of facts.entries) {
    if (entry.status !== 'posted' || !inMonth(entry.bookedOn, month)) continue
    if (
      !index.family(entry) ||
      !index.brl(entry) ||
      index.internal.has(entry.id)
    )
      continue
    if (entry.bucket === 'investment' || entry.bucket === 'reserve')
      saved[entry.bucket] += -entry.amountCents
  }
  for (const relation of facts.relations) {
    if (
      relation.kind !== 'internal_transfer' ||
      relation.status !== 'confirmed'
    )
      continue
    const outflow = index.entryById.get(relation.outflowEntryId)
    const inflow = index.entryById.get(relation.inflowEntryId)
    if (!outflow || !inflow || outflow.status !== 'posted') continue
    if (!inMonth(outflow.bookedOn, month) || !index.brl(outflow)) continue
    const from = index.accountById.get(outflow.accountId)
    const to = index.accountById.get(inflow.accountId)
    if (!from || !to || from.company || to.company) continue
    if (from.purpose === 'operating' && to.purpose !== 'operating')
      saved[to.purpose] += -outflow.amountCents
    else if (from.purpose !== 'operating' && to.purpose === 'operating')
      saved[from.purpose] -= inflow.amountCents
  }
  return saved
}

/** Income received in the month: inflows the person categorised as income. */
export const incomeIn = (facts: MonthFacts, index: Index, month: string) =>
  facts.entries.reduce(
    (sum, entry) =>
      entry.status === 'posted' &&
      inMonth(entry.bookedOn, month) &&
      entry.amountCents > 0 &&
      entry.bucket === 'income' &&
      index.family(entry) &&
      index.brl(entry) &&
      !index.internal.has(entry.id) &&
      !entry.excludedFromSpending
        ? sum + entry.amountCents
        : sum,
    0,
  )

/** The month's plan: the frozen one when closed, otherwise today's strategy, base income and reserve rule. */
export const planFor = (facts: MonthFacts, month: string) => {
  const closed = facts.budgets.find((budget) => budget.month === month)
  const strategy =
    facts.strategies.find((item) => item.isDefault) ?? facts.strategies[0]!
  const closedIncomes = facts.budgets
    .filter((budget) => budget.month < month)
    .sort((a, b) => b.month.localeCompare(a.month))
    .map((budget) => budget.eligibleIncomeCents)
  const baseIncomeCents =
    closed?.baseIncomeCents ??
    conservativeBase(facts.settings.monthlyIncomeTargetCents, closedIncomes)
  const allocation = closed?.allocation ?? strategy.allocation
  const emergency = facts.goals.find(
    (goal) => goal.type === 'emergency_reserve',
  )
  const reserveTargetCents =
    emergency && emergency.targetCents > 0
      ? emergency.targetCents
      : targetsFor(baseIncomeCents, allocation).essential *
        facts.settings.reserveMonths
  const reserveCurrentCents =
    facts.reserveInvestedCents ?? emergency?.currentCents ?? 0
  const reserveComplete =
    reserveTargetCents > 0 && reserveCurrentCents >= reserveTargetCents
  const effective =
    closed?.effectiveAllocation ??
    effectiveAllocation(
      allocation,
      reserveComplete,
      facts.settings.keepReserveContributions,
    )
  return {
    closed: closed !== undefined,
    strategy: closed
      ? { id: closed.strategyId, name: closed.strategyName }
      : { id: strategy.id, name: strategy.name },
    baseIncomeCents,
    allocation,
    effectiveAllocation: effective,
    targets: targetsFor(baseIncomeCents, effective),
    reserve: {
      currentCents: reserveCurrentCents,
      targetCents: reserveTargetCents,
      months: facts.settings.reserveMonths,
      complete: reserveComplete,
      redirected:
        closed?.reserveRedirected ??
        (reserveComplete &&
          allocation.reserve > 0 &&
          !facts.settings.keepReserveContributions),
    },
  }
}

/** What stands between the month and its closing, and data gaps that do not block it. */
export const integrityOf = (
  facts: MonthFacts,
  index: Index,
  month: string,
): ReadonlyArray<IntegrityIssue> => {
  const monthEntries = facts.entries.filter(
    (entry) => inMonth(entry.bookedOn, month) && index.family(entry),
  )
  const counted = monthEntries.filter(
    (entry) => !index.internal.has(entry.id) && !entry.excludedFromSpending,
  )
  const inMonthIds = new Set(monthEntries.map((entry) => entry.id))
  const end = monthEnd(month)
  const overdue = facts.book.reduce(
    (sum, recurrence) =>
      sum +
      recurrence.overdue.filter((occurrence) => occurrence.expectedDate <= end)
        .length,
    0,
  )
  const conflicts = facts.book.reduce(
    (sum, recurrence) =>
      sum +
      recurrence.occurrences.reduce(
        (count, occurrence) =>
          count +
          occurrence.matches.filter(
            (match) =>
              match.status !== 'suggested' &&
              match.categoryConflict &&
              inMonthIds.has(match.entryId),
          ).length,
        0,
      ),
    0,
  )
  const cash = cashAt(facts, index, facts.today)
  const issues: Array<IntegrityIssue> = [
    {
      code: 'uncategorized',
      count: counted.filter(
        (entry) => entry.categoryStatus === 'none' && entry.categoryId === null,
      ).length,
      blocksClosing: true,
    },
    {
      code: 'category_review',
      count: counted.filter((entry) => entry.categoryStatus === 'review')
        .length,
      blocksClosing: true,
    },
    {
      code: 'pending_entry',
      count: monthEntries.filter((entry) => entry.status === 'pending').length,
      blocksClosing: true,
    },
    {
      code: 'suggested_reconciliation',
      count: facts.relations.filter(
        (relation) =>
          relation.status !== 'confirmed' &&
          (inMonthIds.has(relation.outflowEntryId) ||
            inMonthIds.has(relation.inflowEntryId)),
      ).length,
      blocksClosing: true,
    },
    { code: 'overdue_recurrence', count: overdue, blocksClosing: true },
    {
      code: 'recurrence_category_conflict',
      count: conflicts,
      blocksClosing: true,
    },
    { code: 'missing_balance', count: cash.missing, blocksClosing: false },
    {
      code: 'other_currency',
      count: monthEntries.filter((entry) => !index.brl(entry)).length,
      blocksClosing: false,
    },
  ]
  return issues.filter((issue) => issue.count > 0)
}

/** The month as the family reads it. Cards belong to the month their bill is due. */
export const buildMonth = (
  facts: MonthFacts,
  month: string,
  index = indexFacts(facts),
) => {
  const today = facts.today
  const referenceMonth = today.slice(0, 7)
  const plan = planFor(facts, month)
  const forecasting = !plan.closed && month >= referenceMonth
  const { lines: rawLines, warnings } = monthLines(facts, index, month)
  const incomeCents = incomeIn(facts, index, month)
  const saved = savedIn(facts, index, month)

  const expenses = (['essential', 'lifestyle', 'other'] as const).map(
    (bucket) => ({
      bucket,
      cents: 0,
      knownCents: 0,
      estimatedCents: 0,
      targetCents: bucket === 'other' ? null : plan.targets[bucket],
    }),
  )
  const lines: Array<
    Omit<MonthLine, 'bucket'> & {
      readonly bucket: 'essential' | 'lifestyle' | 'other'
      readonly knownCents: number
      readonly estimatedCents: number
    }
  > = []
  let needsCategoryCount = 0
  for (const line of rawLines) {
    const saving = line.bucket === 'investment' || line.bucket === 'reserve'
    // A savings purchase on a card is still a bill; other savings are not spending.
    if (saving && line.origin !== 'card') continue
    const bucket =
      line.bucket === 'essential' || line.bucket === 'lifestyle'
        ? line.bucket
        : 'other'
    const known = line.certainty === 'documented' ? line.cents : line.paidCents
    const estimated = forecasting ? line.cents - known : 0
    const cents = known + estimated
    if (cents === 0) continue
    if (
      line.categoryId === null ||
      line.categoryId === 'uncategorized' ||
      saving
    )
      needsCategoryCount++
    const group = expenses.find((item) => item.bucket === bucket)!
    group.knownCents += known
    group.estimatedCents += estimated
    group.cents += cents
    lines.push({
      ...line,
      bucket,
      cents,
      knownCents: known,
      estimatedCents: estimated,
    })
  }
  const knownExpenseCents = expenses.reduce(
    (sum, item) => sum + item.knownCents,
    0,
  )
  const estimatedExpenseCents = expenses.reduce(
    (sum, item) => sum + item.estimatedCents,
    0,
  )
  const expenseCents = knownExpenseCents + estimatedExpenseCents
  const savedCents = saved.investment + saved.reserve
  const savingsTargetCents = plan.targets.investment + plan.targets.reserve
  const savingsRemainingCents =
    Math.max(0, plan.targets.investment - saved.investment) +
    Math.max(0, plan.targets.reserve - saved.reserve)
  const plannedIncomeCents = forecasting ? plan.baseIncomeCents : incomeCents

  // Cash: operating accounts only; own transfers between them move nothing.
  const start = `${month}-01`
  const end = monthEnd(month)
  const cashDate = end < today ? end : today
  const ownTransfers = new Set(
    facts.relations
      .filter((relation) => {
        if (
          relation.kind !== 'internal_transfer' ||
          relation.status !== 'confirmed'
        )
          return false
        const sides = [relation.outflowEntryId, relation.inflowEntryId].map(
          (id) => index.entryById.get(id),
        )
        return sides.every(
          (entry) =>
            entry !== undefined && index.cashAccountIds.has(entry.accountId),
        )
      })
      .flatMap((relation) => [relation.outflowEntryId, relation.inflowEntryId]),
  )
  let receivedCents = 0
  let paidCents = 0
  for (const entry of facts.entries) {
    if (entry.status !== 'posted' || !index.cashAccountIds.has(entry.accountId))
      continue
    if (
      entry.bookedOn < start ||
      entry.bookedOn > cashDate ||
      ownTransfers.has(entry.id)
    )
      continue
    if (entry.amountCents > 0) receivedCents += entry.amountCents
    else paidCents -= entry.amountCents
  }
  let expectedIncomeCents = 0
  if (forecasting)
    for (const recurrence of facts.book) {
      const { rule } = recurrence
      if (
        !rule.active ||
        rule.direction !== 'income' ||
        rule.currency !== baseCurrency
      )
        continue
      if (rule.categoryId === 'transfer') continue
      if (rule.accountId !== null && !index.cashAccountIds.has(rule.accountId))
        continue
      for (const occurrence of forecastOccurrences(recurrence, end))
        if (
          occurrence.status === 'expected' &&
          occurrence.expectedDate >= today &&
          occurrence.expectedDate >= start &&
          occurrence.expectedDate <= end
        )
          expectedIncomeCents += occurrence.expectedAmountCents
    }
  const remainingExpenseCents = forecasting
    ? Math.max(
        0,
        lines.reduce((sum, line) => sum + line.cents - line.paidCents, 0),
      )
    : 0
  const opening = cashAt(facts, index, addDays(start, -1)).cents
  const cash =
    month > referenceMonth ? null : cashAt(facts, index, cashDate).cents
  const closingCashCents =
    cash === null ? null : cash + expectedIncomeCents - remainingExpenseCents
  const integrity = integrityOf(facts, index, month)

  return {
    month,
    referenceMonth,
    closed: plan.closed,
    forecasting,
    strategy: plan.strategy,
    baseIncomeCents: plan.baseIncomeCents,
    allocation: plan.allocation,
    effectiveAllocation: plan.effectiveAllocation,
    targets: plan.targets,
    reserve: plan.reserve,
    incomeCents,
    actual: {
      essential: expenses[0]!.cents,
      lifestyle: expenses[1]!.cents,
      investment: saved.investment,
      reserve: saved.reserve,
    },
    family: {
      plannedIncomeCents,
      knownExpenseCents,
      estimatedExpenseCents,
      expenseCents,
      savedCents,
      savingsTargetCents,
      savingsRemainingCents,
      plannedBalanceCents: plannedIncomeCents - expenseCents,
      expenses,
      lines,
      needsCategoryCount,
      warnings,
      hasData:
        incomeCents !== 0 ||
        knownExpenseCents !== 0 ||
        savedCents !== 0 ||
        (forecasting && lines.length > 0),
    },
    cashFlow: {
      forecasting,
      openingCashCents: opening,
      cashCents: cash,
      receivedCents,
      paidCents,
      expectedIncomeCents,
      remainingExpenseCents,
      closingCashCents,
      afterGoalsCents:
        closingCashCents === null
          ? null
          : closingCashCents - (forecasting ? savingsRemainingCents : 0),
    },
    integrity: {
      partial: integrity.length > 0,
      issues: integrity,
      closingBlockerCount: integrity
        .filter((issue) => issue.blocksClosing)
        .reduce((sum, issue) => sum + issue.count, 0),
    },
  }
}
export type MonthView = ReturnType<typeof buildMonth>

// ─── Forecast ─────────────────────────────────────────────────────────────

const variableWindowDays = 60

export interface CashPoint {
  readonly date: string
  readonly balanceCents: number
}

export interface CashEvent {
  readonly id: string
  readonly date: string
  readonly name: string
  /** Signed: receipts positive, payments negative. */
  readonly amountCents: number
  readonly kind: 'income' | 'expense' | 'statement'
  readonly certainty: 'closed' | 'installment_schedule' | 'open' | null
}

/**
 * Operating cash day by day: the recorded history, then scheduled
 * receipts and payments (account recurrences, card bills and instalments
 * not billed yet) and the daily average of the last 60 days' variable
 * spending. A projection only: nothing is linked or written.
 */
export const projectCash = (
  facts: MonthFacts,
  options: { readonly daysBack: number; readonly daysAhead: number },
  index = indexFacts(facts),
) => {
  const { today } = facts
  const horizon = addDays(today, options.daysAhead)
  const instalmentIds = new Set(
    facts.installments.flatMap((plan) => plan.entryIds),
  )
  const accountRecurrences = facts.book.filter(
    (recurrence) =>
      recurrence.rule.active &&
      recurrence.rule.currency === baseCurrency &&
      (recurrence.rule.accountId === null ||
        cardTerms(index, recurrence.rule.accountId) === null),
  )
  const accountMatched = new Set(
    [...index.accepted]
      .filter(([, { recurrence }]) => accountRecurrences.includes(recurrence))
      .map(([entryId]) => entryId),
  )
  const aliases = new Map(
    accountRecurrences.map((recurrence) => [
      recurrence,
      new Set([
        ...recurrence.learnedDescriptions.flatMap((description) =>
          knowledgeExactPatterns(description),
        ),
        ...recurrence.rule.importedAliases,
      ]),
    ]),
  )

  const windowStart = addDays(today, -variableWindowDays)
  const recurringEstimateEntryIds: Array<string> = []
  const historical: Array<{
    id: string
    date: string
    description: string
    cents: number
  }> = []
  let variableTotal = 0
  for (const entry of facts.entries) {
    if (entry.status !== 'posted' || entry.amountCents >= 0) continue
    if (entry.bookedOn > today || entry.bookedOn <= windowStart) continue
    const account = index.accountById.get(entry.accountId)
    if (!account || account.currency !== baseCurrency) continue
    const inCash = index.cashAccountIds.has(entry.accountId)
    const inCard = account.card !== null && !account.company
    if (!inCash && !inCard) continue
    if (index.internal.has(entry.id) || entry.excludedFromSpending) continue
    if (accountMatched.has(entry.id) || instalmentIds.has(entry.id)) continue
    if (
      entry.bucket === 'investment' ||
      entry.bucket === 'reserve' ||
      entry.bucket === 'excluded'
    )
      continue
    const patterns = knowledgeExactPatterns(entry.description)
    const covering = accountRecurrences.filter((recurrence) => {
      const rule = recurrence.rule
      if (rule.direction !== 'expense') return false
      if (
        !patterns.some(
          (pattern) =>
            pattern.length > 2 && aliases.get(recurrence)!.has(pattern),
        )
      )
        return false
      return (
        rule.amountMode === 'variable' ||
        Math.abs(Math.abs(entry.amountCents) - rule.amountCents) <=
          Math.round((rule.amountCents * rule.amountToleranceBps) / 10_000)
      )
    })
    // One matching recurrence already stands for it; it is not consumption too.
    if (covering.length === 1) {
      recurringEstimateEntryIds.push(entry.id)
      continue
    }
    variableTotal += -entry.amountCents
    historical.push({
      id: entry.id,
      date: entry.bookedOn,
      description: entry.description,
      cents: -entry.amountCents,
    })
  }
  const dailyVariableCents = Math.round(variableTotal / variableWindowDays)

  const scheduled: Array<CashEvent> = []
  for (const recurrence of accountRecurrences) {
    const { rule } = recurrence
    if (
      rule.direction === 'income' &&
      (rule.categoryId === 'transfer' ||
        (rule.accountId !== null && !index.cashAccountIds.has(rule.accountId)))
    )
      continue
    for (const occurrence of forecastOccurrences(recurrence, horizon)) {
      if (occurrence.status !== 'expected') continue
      if (occurrence.expectedDate <= today || occurrence.expectedDate > horizon)
        continue
      // Paid early: a confirmed or automatic match already left the account.
      scheduled.push({
        id: occurrence.id,
        date: occurrence.expectedDate,
        name: rule.name,
        amountCents:
          rule.direction === 'income'
            ? occurrence.expectedAmountCents
            : -occurrence.expectedAmountCents,
        kind: rule.direction,
        certainty: null,
      })
    }
  }
  for (const cycle of facts.cycles) {
    const account = index.accountById.get(cycle.accountId)
    if (!account || account.company || account.currency !== baseCurrency)
      continue
    if (cycle.dueOn <= today || cycle.dueOn > horizon) continue
    const owed = cycle.billedCents - cycle.paidCents
    if (owed <= 0) continue
    const certainty = cycle.closingOn < today ? 'closed' : 'open'
    scheduled.push({
      id: `${cycle.accountId}|${cycle.dueOn}`,
      date: cycle.dueOn,
      name: `Fatura ${account.name}`,
      amountCents: -owed,
      kind: 'statement',
      certainty,
    })
  }
  const instalmentsByBill = new Map<string, number>()
  for (const instalment of futureInstalments(facts, index)) {
    const account = index.accountById.get(instalment.accountId)
    if (!account || account.company || account.currency !== baseCurrency)
      continue
    if (instalment.dueOn <= today || instalment.dueOn > horizon) continue
    const key = `${instalment.accountId}|${instalment.dueOn}`
    instalmentsByBill.set(
      key,
      (instalmentsByBill.get(key) ?? 0) + instalment.cents,
    )
  }
  for (const [key, cents] of instalmentsByBill) {
    const [accountId, dueOn] = key.split('|') as [string, string]
    scheduled.push({
      id: `${key}|instalments`,
      date: dueOn,
      name: `Parcelas conhecidas ${index.accountById.get(accountId)!.name}`,
      amountCents: -cents,
      kind: 'statement',
      certainty: 'installment_schedule',
    })
  }
  scheduled.sort(
    (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
  )

  const startingCents = cashAt(facts, index, today).cents
  const points: Array<CashPoint> = []
  if (startingCents !== null) {
    for (let back = 1; back <= options.daysBack; back++) {
      const date = addDays(today, -back)
      const balance = cashAt(facts, index, date).cents
      if (balance === null) break
      points.unshift({ date, balanceCents: balance })
    }
    points.push({ date: today, balanceCents: startingCents })
  }
  return {
    today,
    days: options.daysAhead,
    startingCents,
    points,
    todayIndex: points.length - 1,
    dailyVariableCents,
    scheduled,
    recurringEstimateEntryIds,
    largestHistoricalExpenses: historical
      .sort((a, b) => b.cents - a.cents || a.id.localeCompare(b.id))
      .slice(0, 5),
  }
}
export type CashProjection = ReturnType<typeof projectCash>
