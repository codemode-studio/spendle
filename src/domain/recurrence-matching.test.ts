import { describe, expect, it } from 'vitest'

import {
  addRecurrencePeriod,
  buildRecurrenceCandidates,
  merchantSignature,
  pendingTransactionCoversRecurrence,
  transactionEligibleForRecurrence,
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

  it('aceita a perna recebida de uma distribuição de lucro como receita', () => {
    const salary = {
      ...transaction,
      id: 'pro-labore',
      amountCents: 2_500_000,
      description: 'Donald Lourenco Silveira',
      accountId: 'account-pf',
      creditCardId: null,
      counterpartyAccountId: 'account-pj',
    }
    const incomeRule = {
      ...rule,
      direction: 'income' as const,
      expectedAmountCents: 2_500_000,
    }
    const learning = {
      confirmedCount: 0,
      aliases: [salary.description],
      accountIds: [],
      creditCardIds: [],
    }
    expect(
      buildRecurrenceCandidates({
        recurrenceName: 'Salário',
        rule: incomeRule,
        transactions: [
          { ...salary, reconciliationType: 'profit_distribution' },
        ],
        learning,
      }).map((candidate) => candidate.transactionId),
    ).toEqual([salary.id])
    // Uma transferência comum entre contas próprias continua fora.
    expect(
      buildRecurrenceCandidates({
        recurrenceName: 'Salário',
        rule: incomeRule,
        transactions: [{ ...salary, reconciliationType: 'transfer' }],
        learning,
      }),
    ).toEqual([])
    expect(
      buildRecurrenceCandidates({
        recurrenceName: 'Salário',
        rule: incomeRule,
        transactions: [{ ...salary, reconciliationType: null }],
        learning,
      }),
    ).toEqual([])
  })

  it('só libera transferências entre contas próprias quando são distribuição de lucro', () => {
    expect(
      transactionEligibleForRecurrence({ counterpartyAccountId: 'pj' }),
    ).toBe(false)
    expect(
      transactionEligibleForRecurrence({
        counterpartyAccountId: 'pj',
        reconciliationType: 'profit_distribution',
      }),
    ).toBe(true)
    expect(
      transactionEligibleForRecurrence({ reconciliationType: 'refund' }),
    ).toBe(true)
    expect(
      transactionEligibleForRecurrence({ reconciliationType: 'card_payment' }),
    ).toBe(false)
  })
})

describe('destino fixo com histórico', () => {
  const learning = {
    confirmedCount: 1,
    aliases: ['PG *NETFLIX.COM'],
    accountIds: ['account-a', 'account-b'],
    creditCardIds: [],
    medianDateOffsetDays: 1,
    dateSpreadDays: 0,
    amountRangeCents: { min: 3_990, max: 3_990 },
  }
  const fixedRule = {
    ...rule,
    destinationMode: 'fixed' as const,
    accountId: 'account-a',
  }

  it('aceita um destino diferente do cadastrado quando já foi confirmado antes', () => {
    const candidates = buildRecurrenceCandidates({
      recurrenceName: 'Netflix',
      rule: fixedRule,
      transactions: [
        { ...transaction, accountId: 'account-b', creditCardId: null },
      ],
      learning,
    })
    expect(candidates).toHaveLength(1)
  })

  it('continua recusando destinos nunca observados', () => {
    const candidates = buildRecurrenceCandidates({
      recurrenceName: 'Netflix',
      rule: fixedRule,
      transactions: [
        { ...transaction, accountId: 'account-c', creditCardId: null },
      ],
      learning,
    })
    expect(candidates).toHaveLength(0)
  })
})
