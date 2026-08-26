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
  installmentAmountCents: number
  currentInstallment: number
  totalInstallments: number
  firstChargeDate: string
}

export interface CardStatementSummary {
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
}) {
  const summaries = new Map<string, CardStatementSummary>()
  const ensureSummary = (postedAt: string) => {
    const cycle = resolveCardCycle(postedAt, input.closingDay, input.dueDay)
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

  for (const plan of input.installmentPlans) {
    for (const projected of projectRemainingInstallments(plan)) {
      const summary = ensureSummary(projected.postedAt)
      summary.amountCents += projected.amountCents
      summary.projectedInstallmentCount += 1
    }
  }

  const openCycle = resolveCardCycle(
    input.referenceDate,
    input.closingDay,
    input.dueDay,
  )
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
