import { dateInSaoPaulo } from '../domain/LocalDate.ts'
import * as Option from 'effect/Option'

import type { ReportedTransaction } from '../ledger/Observations.ts'
import type { PluggyAccount, PluggyTransaction } from './PluggyApi.ts'

/** Pluggy timestamps are instants; Brazilian banks book on the São Paulo calendar day. */
export const bookedOn = (instant: string) => dateInSaoPaulo(instant)

const fractionDigits = (currency: string) =>
  new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits ?? 2

/** Converts a decimal amount to integer minor units without float drift (1.005 → 101). */
export const toMinorUnits = (amount: number, currency: string) =>
  Math.round(Number((amount * 10 ** fractionDigits(currency)).toFixed(6)))

/**
 * Maps a Pluggy transaction to the ledger's signed convention, in the
 * account's currency: outflows negative, inflows positive.
 *
 * - Bank accounts carry the direction in `type` (DEBIT/CREDIT).
 * - Card statements report purchases as positive amounts and payments or
 *   refunds as negative, so the sign flips.
 * - A foreign-currency purchase uses `amountInAccountCurrency`; without it
 *   the amount is unknown and the transaction is skipped (`None`).
 */
export const toReportedTransaction = (
  account: Pick<PluggyAccount, 'type' | 'currencyCode'>,
  transaction: PluggyTransaction,
): Option.Option<ReportedTransaction> => {
  const currency = account.currencyCode
  const amount =
    transaction.currencyCode === currency
      ? transaction.amount
      : transaction.amountInAccountCurrency
  if (amount === null || amount === undefined) return Option.none()
  const cents = toMinorUnits(amount, currency)
  const amountCents =
    account.type === 'CREDIT'
      ? -cents
      : transaction.type === 'DEBIT'
        ? -Math.abs(cents)
        : Math.abs(cents)
  const merchant = transaction.merchant
  const card = transaction.creditCardMetadata
  return Option.some({
    externalId: transaction.id,
    bookedOn: bookedOn(transaction.date),
    amountCents,
    currency,
    description: (
      transaction.description ||
      transaction.descriptionRaw ||
      ''
    ).trim(),
    status: transaction.status === 'PENDING' ? 'pending' : 'posted',
    raw: {
      type: transaction.type,
      amount: transaction.amount,
      currencyCode: transaction.currencyCode,
      category: transaction.category ?? null,
      providerCode: transaction.providerCode ?? null,
      operationType: transaction.operationType ?? null,
      merchant: merchant
        ? {
            name: merchant.name ?? null,
            businessName: merchant.businessName ?? null,
            category: merchant.category ?? null,
          }
        : null,
      installment: card
        ? {
            number: card.installmentNumber ?? null,
            total: card.totalInstallments ?? null,
            totalAmount: card.totalAmount ?? null,
            purchaseDate: card.purchaseDate ?? null,
            billId: card.billId ?? null,
          }
        : null,
    },
  })
}

/**
 * The running balance after a bank transaction, in minor units, when the
 * provider reports one in the account's currency. Card statements have none.
 */
export const runningBalanceCents = (
  account: Pick<PluggyAccount, 'type' | 'currencyCode'>,
  transaction: PluggyTransaction,
) =>
  account.type === 'BANK' &&
  transaction.currencyCode === account.currencyCode &&
  typeof transaction.balance === 'number'
    ? toMinorUnits(transaction.balance, account.currencyCode)
    : null

/** The name a person recognizes: the product name when the bank provides one. */
export const providerAccountName = (account: PluggyAccount) =>
  account.marketingName?.trim() || account.name.trim()

export const lastFour = (account: PluggyAccount) =>
  account.number?.match(/\d/g)?.slice(-4).join('') || null
