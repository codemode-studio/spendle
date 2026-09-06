import type { CommitmentBudget } from './commitment-budget'

/** Describes the budget scenario, never a guaranteed bank balance. */
export function financialHealth(budget: CommitmentBudget) {
  const spendingOver = budget.buckets.filter(
    (b) =>
      (b.bucket === 'essential' || b.bucket === 'lifestyle') &&
      b.remainingCents < 0,
  )
  const hasIncome = budget.incomeCents > 0
  const deficit = hasIncome && budget.remainingAfterGoalsCents < 0
  const incomplete = budget.warnings.length > 0 || !hasIncome
  return {
    deficit,
    incomplete,
    spendingOver,
    tone: deficit
      ? 'danger'
      : incomplete || spendingOver.length > 0
        ? 'warning'
        : 'success',
    label: !hasIncome
      ? 'Defina a renda de referência'
      : deficit
        ? 'Mês e metas não cabem na renda'
        : spendingOver.length > 0
          ? 'Há grupos acima do limite'
          : incomplete
            ? 'Estimativa a conferir'
            : 'Mês e metas cabem na renda',
  } as const
}
