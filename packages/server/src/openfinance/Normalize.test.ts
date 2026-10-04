import { assert, describe, it } from '@effect/vitest'
import * as Option from 'effect/Option'

import { bookedOn, toMinorUnits, toReportedTransaction } from './Normalize.ts'
import type { PluggyTransaction } from './PluggyApi.ts'

const transaction = (
  fields: Partial<PluggyTransaction>,
): PluggyTransaction => ({
  id: 'tx',
  accountId: 'acc',
  date: '2026-09-15T15:00:00.000Z',
  description: ' Padaria ',
  type: 'DEBIT',
  amount: 10.1,
  currencyCode: 'BRL',
  ...fields,
})

const amountOf = (
  accountType: 'BANK' | 'CREDIT',
  fields: Partial<PluggyTransaction>,
  currencyCode = 'BRL',
) =>
  Option.getOrThrow(
    toReportedTransaction(
      { type: accountType, currencyCode },
      transaction(fields),
    ),
  ).amountCents

describe('toReportedTransaction', () => {
  it('signs bank movements by direction', () => {
    assert.strictEqual(
      amountOf('BANK', { type: 'DEBIT', amount: -10.1 }),
      -1010,
    )
    assert.strictEqual(amountOf('BANK', { type: 'DEBIT', amount: 10.1 }), -1010)
    assert.strictEqual(
      amountOf('BANK', { type: 'CREDIT', amount: 300.25 }),
      30025,
    )
  })

  it('treats card purchases as outflows and card credits as inflows', () => {
    assert.strictEqual(
      amountOf('CREDIT', { type: 'DEBIT', amount: 89.9 }),
      -8990,
    )
    assert.strictEqual(
      amountOf('CREDIT', { type: 'CREDIT', amount: -1500 }),
      150000,
    )
  })

  it('uses the amount in the account currency for a foreign purchase', () => {
    assert.strictEqual(
      amountOf('CREDIT', {
        amount: 20,
        currencyCode: 'USD',
        amountInAccountCurrency: 112.34,
      }),
      -11234,
    )
    assert.isTrue(
      Option.isNone(
        toReportedTransaction(
          { type: 'CREDIT', currencyCode: 'BRL' },
          transaction({
            amount: 20,
            currencyCode: 'USD',
            amountInAccountCurrency: null,
          }),
        ),
      ),
    )
  })

  it('maps status and trims the description', () => {
    const reported = Option.getOrThrow(
      toReportedTransaction(
        { type: 'BANK', currencyCode: 'BRL' },
        transaction({ status: 'PENDING' }),
      ),
    )
    assert.deepStrictEqual(
      [reported.status, reported.description],
      ['pending', 'Padaria'],
    )
  })

  it('keeps the provider category id beside its name', () => {
    const reported = Option.getOrThrow(
      toReportedTransaction(
        { type: 'BANK', currencyCode: 'BRL' },
        transaction({
          category: 'Groceries',
          categoryId: '10000000',
          merchant: { name: 'Mercado', category: 'Supermercados' },
        }),
      ),
    )
    assert.deepInclude(reported.raw as Record<string, unknown>, {
      category: 'Groceries',
      categoryId: '10000000',
    })
    assert.deepStrictEqual(
      Option.getOrThrow(
        toReportedTransaction(
          { type: 'BANK', currencyCode: 'BRL' },
          transaction({}),
        ),
      ).raw,
      {
        type: 'DEBIT',
        amount: 10.1,
        currencyCode: 'BRL',
        category: null,
        categoryId: null,
        providerCode: null,
        operationType: null,
        merchant: null,
        installment: null,
      },
    )
  })
})

describe('bookedOn', () => {
  it('uses the São Paulo calendar day', () => {
    assert.strictEqual(bookedOn('2026-10-01T01:30:00.000Z'), '2026-09-30')
    assert.strictEqual(bookedOn('2026-10-01T03:00:00.000Z'), '2026-10-01')
  })
})

describe('toMinorUnits', () => {
  it('rounds decimal amounts without float drift', () => {
    assert.strictEqual(toMinorUnits(1.005, 'BRL'), 101)
    assert.strictEqual(toMinorUnits(0.1 + 0.2, 'BRL'), 30)
    assert.strictEqual(toMinorUnits(1500, 'JPY'), 1500)
  })
})
