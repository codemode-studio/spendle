import type { CommitmentBudget } from './commitment-budget'
import type { BucketAmounts } from './strategy-progress'
import type { buildMonthlyCashFlow } from './monthly-cash-flow'

type ExpenseBucket = 'essential' | 'lifestyle' | 'other'

/** One monthly view for the headline, breakdown and history. Cards belong to their due month. */
export function buildFamilyMonth(input: {
  month: string
  referenceMonth: string
  closed: boolean
  incomeCents: number
  plannedIncomeCents: number
  targets: BucketAmounts
  saved: Pick<BucketAmounts, 'investment' | 'reserve'>
  budget: CommitmentBudget
}) {
  const forecasting = !input.closed && input.month >= input.referenceMonth
  const expenses = (['essential', 'lifestyle', 'other'] as const).map(
    (bucket) => ({
      bucket,
      cents: 0,
      knownCents: 0,
      estimatedCents: 0,
      targetCents: bucket === 'other' ? null : input.targets[bucket],
    }),
  )
  const lines = []
  let needsCategoryCount = 0
  for (const line of input.budget.lines) {
    const savingCategory =
      line.bucket === 'investment' || line.bucket === 'reserve'
    // Only real contributions count as saved. A purchase on a card is still a bill to pay.
    if (savingCategory && line.origin !== 'card') continue
    const bucket: ExpenseBucket =
      line.bucket === 'essential' || line.bucket === 'lifestyle'
        ? line.bucket
        : 'other'
    const known = line.certainty === 'documented' ? line.cents : line.paidCents
    const estimated = forecasting ? line.cents - known : 0
    const cents = known + estimated
    if (cents === 0) continue
    if (
      !line.categoryId ||
      line.categoryId === 'uncategorized' ||
      savingCategory
    )
      needsCategoryCount += 1
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
  const knownExpenseCents = expenses.reduce((sum, b) => sum + b.knownCents, 0)
  const estimatedExpenseCents = expenses.reduce(
    (sum, b) => sum + b.estimatedCents,
    0,
  )
  const expenseCents = knownExpenseCents + estimatedExpenseCents
  const savedCents = input.saved.investment + input.saved.reserve
  const savingsTargetCents = input.targets.investment + input.targets.reserve
  const savingsRemainingCents =
    Math.max(0, input.targets.investment - input.saved.investment) +
    Math.max(0, input.targets.reserve - input.saved.reserve)
  const plannedIncomeCents = forecasting
    ? input.plannedIncomeCents
    : input.incomeCents
  const plannedBalanceCents = plannedIncomeCents - expenseCents
  return {
    month: input.month,
    closed: input.closed,
    forecasting,
    incomeCents: input.incomeCents,
    plannedIncomeCents,
    incomeMissing: input.incomeCents === 0,
    knownExpenseCents,
    estimatedExpenseCents,
    expenseCents,
    recordedBalanceCents: input.incomeCents - knownExpenseCents,
    plannedBalanceCents,
    savedCents,
    savingsTargetCents,
    savingsRemainingCents,
    balanceAfterGoalsCents:
      plannedBalanceCents - savedCents - savingsRemainingCents,
    expenses,
    lines,
    needsCategoryCount,
    warnings: input.budget.warnings,
    hasData:
      input.incomeCents !== 0 ||
      knownExpenseCents !== 0 ||
      savedCents !== 0 ||
      (forecasting && lines.length > 0),
  }
}
export type FamilyMonth = ReturnType<typeof buildFamilyMonth> & {
  cashFlow?: ReturnType<typeof buildMonthlyCashFlow>
}
