import { createHash } from 'node:crypto'

import type { Account, Transaction } from 'pluggy-sdk'
import { z } from 'zod'

import { toMinorUnits } from '#/domain/currency'
import { normalizeDescription } from '#/domain/finance'

export const pluggyWebhookSchema = z
  .object({
    eventId: z.string().min(1),
    event: z.enum([
      'item/created',
      'item/updated',
      'item/error',
      'item/deleted',
      'item/waiting_user_input',
      'item/waiting_user_action',
      'transactions/created',
      'transactions/updated',
      'transactions/deleted',
    ]),
    itemId: z.string().min(1),
    accountId: z.string().min(1).optional(),
    transactionIds: z.array(z.string().min(1)).max(500).optional(),
    transactionsCreatedAtFrom: z.iso.datetime().optional(),
    triggeredBy: z
      .enum(['USER', 'CLIENT', 'SYNC', 'INTERNAL'])
      .nullable()
      .optional(),
    error: z
      .object({
        code: z.string().max(100),
        message: z.string().max(500),
      })
      .optional(),
  })
  .passthrough()

export type PluggyWebhookPayload = z.infer<typeof pluggyWebhookSchema>

export interface NormalizedPluggyTransaction {
  providerTransactionId: string
  postedAt: string
  description: string
  normalizedDescription: string
  amountCents: number
  currency: string
  status: 'pending' | 'confirmed'
  providerStatus: 'PENDING' | 'POSTED'
  providerCategory: string | null
  sanitizedMetadataJson: string
  fingerprint: string
  contentHash: string
}

export function dateInSaoPaulo(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('Data da Pluggy inválida.')
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const byType = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  )
  return `${byType.year}-${byType.month}-${byType.day}`
}

export function normalizePluggyTransaction(
  account: Pick<Account, 'type' | 'currencyCode'>,
  transaction: Transaction,
): NormalizedPluggyTransaction {
  const currency = transaction.currencyCode
  const unsignedCents = Math.abs(toMinorUnits(transaction.amount, currency))
  const amountCents =
    account.type === 'CREDIT'
      ? -toMinorUnits(transaction.amount, currency)
      : transaction.type === 'DEBIT'
        ? -unsignedCents
        : unsignedCents
  const postedAt = dateInSaoPaulo(transaction.date)
  const description = transaction.description.trim()
  const normalizedDescription = normalizeDescription(description)
  const providerStatus = transaction.status ?? 'POSTED'
  const sanitizedMetadata = {
    providerCode: transaction.providerCode ?? null,
    operationType: transaction.operationType,
    operationTypeAdditionalInfo: transaction.operationTypeAdditionalInfo,
    categoryId: transaction.categoryId,
    merchant: transaction.merchant
      ? {
          name: transaction.merchant.name,
          businessName: transaction.merchant.businessName,
          category: transaction.merchant.category ?? null,
        }
      : null,
    creditCard: transaction.creditCardMetadata
      ? {
          installmentNumber:
            transaction.creditCardMetadata.installmentNumber ?? null,
          totalInstallments:
            transaction.creditCardMetadata.totalInstallments ?? null,
          totalAmount: transaction.creditCardMetadata.totalAmount ?? null,
          purchaseDate: transaction.creditCardMetadata.purchaseDate
            ? dateInSaoPaulo(transaction.creditCardMetadata.purchaseDate)
            : null,
          billId: transaction.creditCardMetadata.billId ?? null,
          billForecastDate:
            transaction.creditCardMetadata.billForecastDate ?? null,
        }
      : null,
  }
  const sanitizedMetadataJson = JSON.stringify(sanitizedMetadata)
  const fingerprint = createHash('sha256')
    .update([postedAt, amountCents, normalizedDescription, currency].join('|'))
    .digest('hex')
  const contentHash = createHash('sha256')
    .update(
      JSON.stringify({
        postedAt,
        description,
        amountCents,
        currency,
        providerStatus,
        providerCategory: transaction.category,
        sanitizedMetadata,
      }),
    )
    .digest('hex')

  return {
    providerTransactionId: transaction.id,
    postedAt,
    description,
    normalizedDescription,
    amountCents,
    currency,
    status: providerStatus === 'PENDING' ? 'pending' : 'confirmed',
    providerStatus,
    providerCategory: transaction.category,
    sanitizedMetadataJson,
    fingerprint,
    contentHash,
  }
}

export function pluggyAccountObservation(account: Account) {
  const lastFour = account.number.match(/\d/g)?.slice(-4).join('') || null
  return {
    providerAccountId: account.id,
    type: account.type,
    subtype: account.subtype,
    name: account.marketingName?.trim() || account.name.trim(),
    currency: account.currencyCode,
    lastFour,
    observedBalanceCents: toMinorUnits(account.balance, account.currencyCode),
    observedAvailableBalanceCents:
      account.type === 'BANK' && account.bankData?.closingBalance !== null
        ? toMinorUnits(
            account.bankData?.closingBalance ?? account.balance,
            account.currencyCode,
          )
        : null,
    observedCreditLimitCents:
      account.type === 'CREDIT' && account.creditData?.creditLimit !== null
        ? toMinorUnits(
            account.creditData?.creditLimit ?? 0,
            account.currencyCode,
          )
        : null,
    observedAvailableCreditCents:
      account.type === 'CREDIT' &&
      account.creditData?.availableCreditLimit !== null
        ? toMinorUnits(
            account.creditData?.availableCreditLimit ?? 0,
            account.currencyCode,
          )
        : null,
    observedClosingDate:
      account.type === 'CREDIT' && account.creditData?.balanceCloseDate
        ? dateInSaoPaulo(account.creditData.balanceCloseDate)
        : null,
    observedDueDate:
      account.type === 'CREDIT' && account.creditData?.balanceDueDate
        ? dateInSaoPaulo(account.creditData.balanceDueDate)
        : null,
  }
}
