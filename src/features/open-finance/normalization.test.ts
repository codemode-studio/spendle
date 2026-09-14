import { TransactionStatus } from 'pluggy-sdk'
import type { Transaction } from 'pluggy-sdk'
import { describe, expect, it } from 'vitest'

import { normalizePluggyTransaction } from './normalization'

const transaction = {
  id: 'provider-tx',
  accountId: 'provider-account',
  date: new Date('2026-09-11T02:00:00.000Z'),
  description: ' Mercado ',
  descriptionRaw: null,
  type: 'DEBIT',
  amount: 12.34,
  amountInAccountCurrency: null,
  balance: 0,
  currencyCode: 'BRL',
  category: 'Food',
  creditCardMetadata: null,
  categoryId: null,
  operationType: null,
  operationTypeAdditionalInfo: null,
  providerId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  merchant: {
    name: 'Mercado',
    businessName: 'Mercado Ltda',
    cnpj: '00000000000100',
  },
  paymentData: {
    payer: { documentNumber: { type: 'CPF', value: '00000000000' } },
    boletoMetadata: null,
  },
} satisfies Transaction

describe('normalizePluggyTransaction', () => {
  it('uses bank direction, centavo precision and America/Sao_Paulo date', () => {
    const result = normalizePluggyTransaction(
      { type: 'BANK', currencyCode: 'BRL' },
      transaction,
    )
    expect(result).toMatchObject({
      postedAt: '2026-09-10',
      amountCents: -1234,
      description: 'Mercado',
      status: 'confirmed',
    })
  })

  it('inverts the amount reported for a credit-card account', () => {
    expect(
      normalizePluggyTransaction(
        { type: 'CREDIT', currencyCode: 'BRL' },
        { ...transaction, type: 'CREDIT', amount: 19.99 },
      ).amountCents,
    ).toBe(-1999)
  })

  it('keeps Pluggy category only as metadata and removes identity fields', () => {
    const result = normalizePluggyTransaction(
      { type: 'BANK', currencyCode: 'BRL' },
      transaction,
    )
    expect(result.providerCategory).toBe('Food')
    expect(result.sanitizedMetadataJson).not.toContain('00000000000')
    expect(result.sanitizedMetadataJson).not.toContain('00000000000100')
  })

  it('maps PENDING without losing the immutable version hash', () => {
    const first = normalizePluggyTransaction(
      { type: 'BANK', currencyCode: 'BRL' },
      { ...transaction, status: TransactionStatus.PENDING },
    )
    const posted = normalizePluggyTransaction(
      { type: 'BANK', currencyCode: 'BRL' },
      { ...transaction, status: TransactionStatus.POSTED },
    )
    expect(first.status).toBe('pending')
    expect(first.contentHash).not.toBe(posted.contentHash)
  })
})
