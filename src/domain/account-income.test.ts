import { describe, expect, it } from 'vitest'
import { confirmedAccountIncome } from './account-income'

const receipt = {
  id: 'receipt',
  accountId: 'account',
  counterpartyAccountId: null,
  postedAt: '2026-09-08',
  status: 'confirmed',
  amountCents: 10001,
  baseAmountCents: 10001,
  categoryId: null,
  bucket: null,
  description: 'Recebimento',
}
describe('confirmed account income', () => {
  it('counts external receipts and interest without requiring a budget category, preserving FX cents', () => {
    expect(
      confirmedAccountIncome({
        month: '2026-09',
        reconciliations: [],
        transactions: [
          receipt,
          {
            ...receipt,
            id: 'interest',
            categoryId: 'investment_income',
            bucket: 'income',
            amountCents: 399,
            baseAmountCents: 399,
          },
          {
            ...receipt,
            id: 'foreign',
            accountId: 'company-us',
            amountCents: 10000,
            baseAmountCents: 53217,
          },
        ],
      }),
    ).toEqual({ cents: 63617, missingConversionCount: 0 })
  })
  it('excludes own transfers, redemptions, card credits, pending amounts, expenses and other months', () => {
    expect(
      confirmedAccountIncome({
        month: '2026-09',
        reconciliations: [
          {
            type: 'profit_distribution',
            status: 'confirmed',
            transactionIds: ['distribution'],
          },
          { type: 'fx_transfer', status: 'confirmed', transactionIds: ['fx'] },
        ],
        transactions: [
          { ...receipt, categoryId: 'transfer' },
          { ...receipt, counterpartyAccountId: 'own-account' },
          { ...receipt, id: 'distribution' },
          { ...receipt, id: 'fx' },
          { ...receipt, bucket: 'investment' },
          { ...receipt, description: 'Resgate de investimento' },
          { ...receipt, accountId: null },
          { ...receipt, status: 'pending' },
          { ...receipt, status: 'excluded' },
          { ...receipt, amountCents: -10001, baseAmountCents: -10001 },
          { ...receipt, postedAt: '2026-08-31' },
        ],
      }),
    ).toEqual({ cents: 0, missingConversionCount: 0 })
  })
  it('reports missing currency conversion instead of inventing a converted receipt', () => {
    expect(
      confirmedAccountIncome({
        month: '2026-09',
        reconciliations: [],
        transactions: [{ ...receipt, baseAmountCents: null }],
      }),
    ).toEqual({ cents: 0, missingConversionCount: 1 })
  })
})
