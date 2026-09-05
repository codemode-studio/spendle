import { describe, expect, it } from 'vitest'

import { buildRecurrenceCandidates } from './recurrence-matching'
import {
  merchantSignature,
  pendingTransactionCoversRecurrence,
  transactionEligibleForRecurrence,
} from './recurrence-book'

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
        transactions: [
          {
            ...transaction,
            reconciliationTypes: new Set(['card_payment'] as const),
          },
        ],
        learning: {
          confirmedCount: 3,
          aliases: [transaction.description],
          accountIds: [],
          creditCardIds: ['card'],
        },
      }),
    ).toEqual([])
  })

  it('não usa transferência PJ para PF como nova receita do caixa unificado', () => {
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
          {
            ...salary,
            reconciliationTypes: new Set(['profit_distribution'] as const),
          },
        ],
        learning,
      }).map((candidate) => candidate.transactionId),
    ).toEqual([])
    // Uma transferência comum entre contas próprias continua fora.
    expect(
      buildRecurrenceCandidates({
        recurrenceName: 'Salário',
        rule: incomeRule,
        transactions: [
          {
            ...salary,
            reconciliationTypes: new Set(['transfer'] as const),
          },
        ],
        learning,
      }),
    ).toEqual([])
    expect(
      buildRecurrenceCandidates({
        recurrenceName: 'Salário',
        rule: incomeRule,
        transactions: [{ ...salary, reconciliationTypes: null }],
        learning,
      }),
    ).toEqual([])
  })

  it('exclui também a distribuição entre contas próprias das recorrências', () => {
    expect(
      transactionEligibleForRecurrence({ counterpartyAccountId: 'pj' }),
    ).toBe(false)
    expect(
      transactionEligibleForRecurrence({
        counterpartyAccountId: 'pj',
        reconciliationTypes: new Set(['profit_distribution']),
      }),
    ).toBe(false)
    expect(
      transactionEligibleForRecurrence({
        reconciliationTypes: new Set(['refund']),
      }),
    ).toBe(true)
    expect(
      transactionEligibleForRecurrence({
        reconciliationTypes: new Set(['card_payment']),
      }),
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

  it('mantém a tolerância configurada como limite do aprendizado', () => {
    const candidates = buildRecurrenceCandidates({
      recurrenceName: 'Netflix',
      rule: { ...fixedRule, dateToleranceDays: 3 },
      transactions: [
        {
          ...transaction,
          postedAt: '2026-08-15',
          accountId: 'account-a',
          creditCardId: null,
        },
      ],
      learning: {
        ...learning,
        medianDateOffsetDays: 0,
        dateSpreadDays: 20,
      },
    })
    expect(candidates).toHaveLength(0)
  })
})

it('reconhece o favorecido Pix aprovado sem o código do banco', () => {
  const candidates = buildRecurrenceCandidates({
    recurrenceName: 'Aluguel',
    rule,
    transactions: [
      {
        ...transaction,
        description: 'Pix enviado: "Cp :12345678-LOCADORA EXEMPLO"',
      },
    ],
    learning: {
      confirmedCount: 0,
      aliases: ['LOCADORA EXEMPLO'],
      accountIds: [],
      creditCardIds: [],
    },
  })
  expect(candidates).toHaveLength(1)
  expect(candidates[0]).toMatchObject({
    autoConfirm: false,
    evidence: { exactLearnedAlias: true },
  })
})
