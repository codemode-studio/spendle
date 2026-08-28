import { describe, expect, it } from 'vitest'

import {
  addRecurrencePeriod,
  buildRecurrenceCandidates,
  merchantSignature,
  pendingTransactionCoversRecurrence,
} from './recurrence-matching'

const rule = {
  expectedDate: '2026-08-10',
  expectedAmountCents: 3_990,
  currency: 'BRL',
  direction: 'expense' as const,
  amountMode: 'fixed' as const,
  destinationMode: 'automatic' as const,
  accountId: null,
  creditCardId: null,
  dateToleranceDays: 15,
  amountToleranceBps: 500,
  autoMatchEnabled: true,
  minimumConfirmations: 3,
}

const transaction = {
  id: 'netflix-august',
  postedAt: '2026-08-11',
  amountCents: -3_990,
  currency: 'BRL',
  description: 'PG *NETFLIX.COM 847291',
  status: 'confirmed' as const,
  accountId: null,
  creditCardId: 'card',
}

describe('matching de recorrências', () => {
  it.each([
    ['2026-01-31', 'monthly', '2026-02-28'],
    ['2024-02-29', 'yearly', '2025-02-28'],
    ['2026-03-30', 'monthly', '2026-04-30'],
  ] as const)(
    'mantém o calendário sem derivar %s',
    (date, frequency, expected) => {
      expect(addRecurrencePeriod(date, frequency)).toBe(expected)
    },
  )

  it('preserva o dia âncora depois de um mês curto', () => {
    const february = addRecurrencePeriod('2026-01-31', 'monthly', '2026-01-31')
    expect(february).toBe('2026-02-28')
    expect(addRecurrencePeriod(february, 'monthly', '2026-01-31')).toBe(
      '2026-03-31',
    )
  })

  it('remove identificadores instáveis da assinatura do estabelecimento', () => {
    expect(merchantSignature(transaction.description)).toBe('netflix com')
  })

  it('sugere sem auto-confirmar antes de três confirmações', () => {
    const [candidate] = buildRecurrenceCandidates({
      recurrenceName: 'Netflix',
      rule,
      transactions: [transaction],
      learning: {
        confirmedCount: 0,
        aliases: [],
        accountIds: [],
        creditCardIds: [],
      },
    })
    expect(candidate).toMatchObject({
      transactionId: transaction.id,
      autoConfirm: false,
    })
  })

  it('auto-confirma só com histórico, alias exato e candidato sem ambiguidade', () => {
    const [candidate] = buildRecurrenceCandidates({
      recurrenceName: 'Netflix',
      rule,
      transactions: [transaction],
      learning: {
        confirmedCount: 3,
        aliases: [transaction.description],
        accountIds: [],
        creditCardIds: ['card'],
      },
    })
    expect(candidate).toMatchObject({ score: 100, autoConfirm: true })
  })

  it('não auto-confirma em um destino que nunca foi confirmado', () => {
    const [candidate] = buildRecurrenceCandidates({
      recurrenceName: 'Netflix',
      rule,
      transactions: [transaction],
      learning: {
        confirmedCount: 3,
        aliases: [transaction.description],
        accountIds: [],
        creditCardIds: ['outro-cartao'],
      },
    })
    expect(candidate).toMatchObject({
      autoConfirm: false,
      evidence: { destination: 0 },
    })
  })

  it('aplica rejeições depois de limitar as evidências positivas', () => {
    const [candidate] = buildRecurrenceCandidates({
      recurrenceName: 'Netflix',
      rule,
      transactions: [transaction],
      learning: {
        confirmedCount: 3,
        aliases: [transaction.description],
        accountIds: [],
        creditCardIds: ['card'],
        rejectionCount: 99,
      },
    })
    expect(candidate).toMatchObject({ score: 88, autoConfirm: false })
  })

  it('reconhece uma pendência categorizada que já cobre a projeção', () => {
    expect(
      pendingTransactionCoversRecurrence({
        recurrenceName: 'Netflix',
        categoryId: 'subscriptions',
        rule,
        transaction: {
          ...transaction,
          status: 'pending',
          categoryId: 'subscriptions',
        },
      }),
    ).toBe(true)
  })

  it('não considera pagamentos e transferências reconciliadas', () => {
    expect(
      buildRecurrenceCandidates({
        recurrenceName: 'Netflix',
        rule,
        transactions: [{ ...transaction, reconciliationType: 'card_payment' }],
        learning: {
          confirmedCount: 3,
          aliases: [transaction.description],
          accountIds: [],
          creditCardIds: ['card'],
        },
      }),
    ).toEqual([])
  })
})
