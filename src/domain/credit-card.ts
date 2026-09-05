export interface CardCycle {
  closingDate: string
  dueDate: string
  statementMonth: string
}

export interface CardStatementTransaction {
  amountCents: number
  postedAt: string
  categoryId?: string | null
  description?: string | null
}

export interface CardInstallmentPlan {
  description?: string
  creditCardId?: string
  installmentAmountCents: number
  currentInstallment: number
  totalInstallments: number
  firstChargeDate: string
}

export type InstallmentCommitmentType = 'short_installment' | 'temporary_fixed'

export interface CardStatementSummary {
  certainty?: 'closed' | 'installment_schedule'
  sourceImportId?: string
  dueDate: string
  closingDate: string
  amountCents: number
  transactionCount: number
  projectedInstallmentCount: number
}

function dateParts(value: string) {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)
  return { year, monthIndex: month - 1, day }
}

function formatDate(year: number, monthIndex: number, day: number) {
  const date = new Date(Date.UTC(year, monthIndex, 1))
  const targetYear = date.getUTCFullYear()
  const targetMonth = date.getUTCMonth()
  const lastDay = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate()
  return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(
    Math.min(day, lastDay),
  ).padStart(2, '0')}`
}

export function addMonths(value: string, amount: number) {
  const { year, monthIndex, day } = dateParts(value)
  return formatDate(year, monthIndex + amount, day)
}

export function resolveCardCycle(
  postedAt: string,
  closingDay: number,
  dueDay: number,
): CardCycle {
  const { year, monthIndex, day } = dateParts(postedAt)
  const closingMonthOffset = day > closingDay ? 1 : 0
  const closingDate = formatDate(
    year,
    monthIndex + closingMonthOffset,
    closingDay,
  )
  const dueMonthOffset = dueDay <= closingDay ? 1 : 0
  const closingParts = dateParts(closingDate)
  const dueDate = formatDate(
    closingParts.year,
    closingParts.monthIndex + dueMonthOffset,
    dueDay,
  )
  return { closingDate, dueDate, statementMonth: dueDate.slice(0, 7) }
}

export function parseInstallmentDescription(description: string) {
  const match = description.match(
    /(?:parc(?:ela)?\s*)?(\d{1,2})\s*(?:\/|\s+de\s+)(\d{1,2})(?!\d)/i,
  )
  if (!match) return null
  const currentInstallment = Number(match[1])
  const totalInstallments = Number(match[2])
  if (
    totalInstallments < 2 ||
    currentInstallment < 1 ||
    currentInstallment > totalInstallments
  ) {
    return null
  }
  const cleanDescription = description
    .replace(match[0], '')
    .replace(/[-–—|]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    currentInstallment,
    totalInstallments,
    cleanDescription: cleanDescription || description,
  }
}

export function classifyInstallmentCommitment(
  totalInstallments: number,
  installmentAmountCents = 0,
): InstallmentCommitmentType {
  return totalInstallments > 3 || installmentAmountCents >= 50_000
    ? 'temporary_fixed'
    : 'short_installment'
}

/** Preserve source observations; project only the latest installment observation per purchase cohort. */
export function latestInstallmentPlans<T extends CardInstallmentPlan>(
  plans: T[],
): T[] {
  const groups = new Map<string, T[]>()
  const unnamed: T[] = []
  for (const plan of plans) {
    if (!plan.description) {
      unnamed.push(plan)
      continue
    }
    const origin = addMonths(
      plan.firstChargeDate,
      1 - plan.currentInstallment,
    ).slice(0, 7)
    const key = JSON.stringify([
      plan.creditCardId,
      plan.description.trim().toLowerCase(),
      plan.installmentAmountCents,
      plan.totalInstallments,
      origin,
    ])
    const group = groups.get(key) ?? []
    const current = group[0]?.currentInstallment ?? 0
    if (plan.currentInstallment > current) groups.set(key, [plan])
    else if (plan.currentInstallment === current)
      groups.set(key, [...group, plan])
  }
  return [...unnamed, ...[...groups.values()].flat()]
}

export function projectRemainingInstallments(plan: CardInstallmentPlan) {
  const projected = []
  for (
    let installment = plan.currentInstallment + 1;
    installment <= plan.totalInstallments;
    installment += 1
  ) {
    projected.push({
      installment,
      totalInstallments: plan.totalInstallments,
      amountCents: plan.installmentAmountCents,
      postedAt: addMonths(
        plan.firstChargeDate,
        installment - plan.currentInstallment,
      ),
    })
  }
  return projected
}

export function summarizeCardStatements(input: {
  transactions: CardStatementTransaction[]
  installmentPlans: CardInstallmentPlan[]
  closingDay: number
  dueDay: number
  referenceDate: string
  documentedStatements?: Array<{
    closingDate: string
    dueDate: string
    totalCents: number
    certainty?: 'closed' | 'installment_schedule'
    sourceImportId?: string
  }>
}) {
  const documented = input.documentedStatements ?? []
  const resolveCycle = (postedAt: string) => {
    const inferred = resolveCardCycle(postedAt, input.closingDay, input.dueDay)
    const control = documented.find(
      (c) => c.closingDate.slice(0, 7) === inferred.closingDate.slice(0, 7),
    )
    return control
      ? {
          closingDate: control.closingDate,
          dueDate: control.dueDate,
          statementMonth: control.dueDate.slice(0, 7),
        }
      : inferred
  }
  const summaries = new Map<string, CardStatementSummary>()
  const ensureSummary = (postedAt: string) => {
    const cycle = resolveCycle(postedAt)
    const current = summaries.get(cycle.dueDate)
    if (current) return current
    const created = {
      dueDate: cycle.dueDate,
      closingDate: cycle.closingDate,
      amountCents: 0,
      transactionCount: 0,
      projectedInstallmentCount: 0,
    }
    summaries.set(cycle.dueDate, created)
    return created
  }

  for (const transaction of input.transactions) {
    const isReceivedCardPayment =
      transaction.amountCents > 0 &&
      /pagamento\s+(?:de\s+)?(?:fatura|recebido)|fatura.*(?:paga|pagamento)/i.test(
        transaction.description ?? '',
      )
    if (
      ['card_payment', 'transfer'].includes(transaction.categoryId ?? '') ||
      isReceivedCardPayment
    ) {
      continue
    }
    const summary = ensureSummary(transaction.postedAt)
    summary.amountCents -= transaction.amountCents
    summary.transactionCount += 1
  }

  for (const plan of latestInstallmentPlans(input.installmentPlans)) {
    for (const projected of projectRemainingInstallments(plan)) {
      const summary = ensureSummary(projected.postedAt)
      summary.amountCents += projected.amountCents
      summary.projectedInstallmentCount += 1
    }
  }

  for (const control of documented) {
    const existing = summaries.get(control.dueDate)
    summaries.set(control.dueDate, {
      closingDate: control.closingDate,
      dueDate: control.dueDate,
      amountCents: control.totalCents,
      certainty: control.certainty ?? 'closed',
      sourceImportId: control.sourceImportId,
      transactionCount: existing?.transactionCount ?? 0,
      projectedInstallmentCount: 0,
    })
  }
  const openCycle = resolveCycle(input.referenceDate)
  if (!summaries.has(openCycle.dueDate)) {
    summaries.set(openCycle.dueDate, {
      dueDate: openCycle.dueDate,
      closingDate: openCycle.closingDate,
      amountCents: 0,
      transactionCount: 0,
      projectedInstallmentCount: 0,
    })
  }

  const statements = [...summaries.values()]
    .map((summary) => ({
      ...summary,
      amountCents: Math.max(0, summary.amountCents),
    }))
    .sort((left, right) => left.dueDate.localeCompare(right.dueDate))
  const currentIndex = statements.findIndex(
    (statement) => statement.dueDate >= input.referenceDate,
  )
  const current = statements[Math.max(0, currentIndex)]
  const next = statements
    .slice(Math.max(0, currentIndex) + 1)
    .find((statement) => statement.amountCents > 0)
  const outstandingCents = statements
    .filter((statement) => statement.dueDate >= current.dueDate)
    .reduce((sum, statement) => sum + statement.amountCents, 0)

  return { statements, current, next: next ?? null, outstandingCents }
}
