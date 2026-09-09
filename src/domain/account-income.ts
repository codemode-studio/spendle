import { isInternalTransferType } from './ledger'
import type { SummaryReconciliation } from './financial-summary'

type AccountReceipt = {
  id: string
  accountId: string | null
  counterpartyAccountId: string | null
  postedAt: string
  status: string
  amountCents: number
  baseAmountCents: number | null
  categoryId: string | null
  bucket: string | null
  description: string
}

/** External receipts across all owned accounts, independent of budget-base eligibility. */
export function confirmedAccountIncome(input: {
  month: string
  transactions: AccountReceipt[]
  reconciliations: SummaryReconciliation[]
}) {
  const internalIds = new Set(
    input.reconciliations
      .filter(
        (group) =>
          group.status === 'confirmed' && isInternalTransferType(group.type),
      )
      .flatMap((group) => group.transactionIds),
  )
  let cents = 0
  let missingConversionCount = 0
  for (const transaction of input.transactions) {
    if (
      !transaction.accountId ||
      transaction.status !== 'confirmed' ||
      !transaction.postedAt.startsWith(input.month + '-') ||
      transaction.amountCents <= 0 ||
      transaction.counterpartyAccountId ||
      internalIds.has(transaction.id) ||
      ['transfer', 'card_payment'].includes(transaction.categoryId ?? '') ||
      ['investment', 'reserve'].includes(transaction.bucket ?? '') ||
      /^resgate\b/i.test(transaction.description.trim())
    )
      continue
    if (transaction.baseAmountCents === null) {
      missingConversionCount += 1
      continue
    }
    cents += transaction.baseAmountCents
  }
  return { cents, missingConversionCount }
}
