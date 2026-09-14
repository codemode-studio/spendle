import { isCardPaymentRow } from './card-payment'
import { addMonths, classifyInstallmentCommitment } from './credit-card'
import { commitmentBucket } from './commitment-budget'
import type { CommitmentLine } from './commitment-budget'

interface Purchase {
  id: string
  description: string
  amountCents: number
  categoryId: string | null
  bucket: string | null
  importId: string | null
}
interface Plan {
  description: string
  sourceTransactionId: string | null
  currentInstallment: number
  totalInstallments: number
  installmentAmountCents: number
}
/** Spending buckets collapse into essentials; savings and unknown stay as they are. */
export function temporaryFixedBucket<T extends string | null>(bucket: T) {
  return bucket === 'lifestyle' || bucket === 'essential'
    ? ('essential' as const)
    : bucket
}

export function cardBudgetLines(input: {
  id: string
  dueDate: string
  totalCents: number
  importId: string | null
  futureOffset: number
  includedTransactionIds?: string[]
  purchases: Purchase[]
  plans: Plan[]
  explicitInstallments?: Array<{
    description: string
    amountCents: number
    current: number | null
    total: number | null
  }>
}): CommitmentLine[] {
  const normalize = (s: string) =>
    s
      .replace(/\s*\(\s*\)$/, '')
      .trim()
      .toLowerCase()
  const purchases = new Map(input.purchases.map((p) => [p.id, p]))
  const lines: CommitmentLine[] = []
  const make = (
    description: string,
    cents: number,
    purchase: Purchase | undefined,
    current?: number,
    total?: number,
  ): CommitmentLine => {
    const temporaryUntil =
      current && total
        ? classifyInstallmentCommitment(total, cents) === 'temporary_fixed'
          ? addMonths(input.dueDate, total - current)
          : undefined
        : undefined
    const bucket = commitmentBucket(purchase?.bucket ?? null)
    return {
      id: input.id + ':' + lines.length,
      description,
      date: input.dueDate,
      cents,
      categoryId: purchase?.categoryId ?? null,
      // A temporary fixed installment is a commitment already taken: while it
      // lasts it belongs to the essentials envelope, whatever its category.
      bucket: temporaryUntil ? temporaryFixedBucket(bucket) : bucket,
      transactionId: input.futureOffset === 0 ? purchase?.id : undefined,
      importId: input.importId,
      certainty: input.futureOffset === 0 ? 'documented' : 'scheduled',
      paidCents: 0,
      origin: 'card',
      ...(current && total
        ? { installment: `${current}/${total}`, temporaryUntil }
        : {}),
    }
  }
  if (input.futureOffset === 0) {
    for (const purchase of input.purchases) {
      if (
        (input.includedTransactionIds
          ? !input.includedTransactionIds.includes(purchase.id)
          : purchase.importId !== input.importId) ||
        isCardPaymentRow(purchase)
      )
        continue
      const plan = input.plans.find(
        (p) => p.sourceTransactionId === purchase.id,
      )
      lines.push(
        make(
          purchase.description,
          -purchase.amountCents,
          purchase,
          plan?.currentInstallment,
          plan?.totalInstallments,
        ),
      )
    }
  } else if (input.explicitInstallments) {
    for (const installment of input.explicitInstallments) {
      const current =
        installment.current === null
          ? null
          : installment.current + input.futureOffset - 1
      if (
        current === null ||
        installment.total === null ||
        current > installment.total
      )
        continue
      const candidates = input.plans.filter(
        (p) =>
          normalize(p.description) === normalize(installment.description) ||
          (installment.description.startsWith('de ') &&
            p.installmentAmountCents === installment.amountCents),
      )
      const plan = candidates.length === 1 ? candidates[0] : undefined
      const purchase = plan?.sourceTransactionId
        ? purchases.get(plan.sourceTransactionId)
        : undefined
      lines.push(
        make(
          installment.description,
          installment.amountCents,
          purchase,
          current,
          installment.total,
        ),
      )
    }
  } else {
    for (const plan of input.plans) {
      const current = plan.currentInstallment + input.futureOffset
      if (current > plan.totalInstallments) continue
      lines.push(
        make(
          plan.description,
          plan.installmentAmountCents,
          plan.sourceTransactionId
            ? purchases.get(plan.sourceTransactionId)
            : undefined,
          current,
          plan.totalInstallments,
        ),
      )
    }
  }
  // A disagreement is visible in the budget's unallocated remainder, never spread across categories.
  return lines
}
