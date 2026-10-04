import { describe, expect, it } from 'vitest'

import {
  buildReconciliationSuggestions,
  detectOwnedTransferCategory,
  matchLearnedTransferRule,
} from './reconciliation'
import type { ReconciliationTransaction } from './reconciliation'

const base: ReconciliationTransaction = {
  id: 'one',
  amountCents: -100_000,
  currency: 'BRL',
  postedAt: '2026-08-01',
  description: 'Transferência enviada',
  accountId: 'checking',
  creditCardId: null,
}

describe('reconciliação', () => {
  it('reaplica a conta contraparte aprendida em uma confirmação manual', () => {
    expect(
      matchLearnedTransferRule({
        description: 'Donald Lourenco Silveira',
        amountCents: -2_500_000,
        sourceAccountId: 'inter-pj',
        rules: [
          {
            pattern: 'donald lourenco silveira',
            accountId: 'inter-pj',
            counterpartyAccountId: 'inter-pf',
            direction: 'outgoing',
            categoryId: 'transfer',
          },
        ],
      }),
    ).toEqual({
      categoryId: 'transfer',
      counterpartyAccountId: 'inter-pf',
    })
  })

  it('confirma automaticamente as duas pontas vinculadas manualmente', () => {
    const suggestions = buildReconciliationSuggestions([
      {
        ...base,
        accountId: 'inter-pj',
        counterpartyAccountId: 'inter-pf',
      },
      {
        ...base,
        id: 'two',
        amountCents: 100_000,
        accountId: 'inter-pf',
      },
    ])

    expect(suggestions[0]).toMatchObject({
      type: 'transfer',
      confidence: 100,
      autoConfirm: true,
    })
  })

  it('não auto-confirma como transferência uma relação aprendida entre PJ e PF', () => {
    const suggestions = buildReconciliationSuggestions([
      {
        ...base,
        accountId: 'inter-pj',
        counterpartyAccountId: 'inter-pf',
        scopeType: 'company_br',
      },
      {
        ...base,
        id: 'two',
        amountCents: 100_000,
        accountId: 'inter-pf',
        scopeType: 'person',
      },
    ])

    expect(suggestions[0]).toMatchObject({
      type: 'profit_distribution',
      confidence: 97,
      autoConfirm: false,
    })
  })

  it('reconhece Pix da PJ para o próprio titular antes da entrada PF existir', () => {
    expect(
      detectOwnedTransferCategory({
        amountCents: -2_500_000,
        description: 'Donald Lourenco Silveira',
        raw: {
          historico: 'Pix enviado',
          descricao: 'Donald Lourenco Silveira',
        },
        sourceScopeName:
          'Donald Lourenço Silveira Consultoria de Informática LTDA',
        sourceScopeType: 'company_br',
      }),
    ).toBe('profit_distribution_income')
  })

  it('não trata Pix para terceiro como movimentação entre contas próprias', () => {
    expect(
      detectOwnedTransferCategory({
        amountCents: -70_000,
        description: 'Mariana Almeida',
        raw: { historico: 'Pix enviado', descricao: 'Mariana Almeida' },
        sourceScopeName:
          'Donald Lourenço Silveira Consultoria de Informática LTDA',
        sourceScopeType: 'company_br',
      }),
    ).toBeNull()
  })

  it('sugere transferência de mesmo valor em contas diferentes', () => {
    const suggestions = buildReconciliationSuggestions([
      base,
      { ...base, id: 'two', amountCents: 100_000, accountId: 'reserve' },
    ])
    expect(suggestions[0]).toMatchObject({ type: 'transfer', confidence: 98 })
  })

  it('trata aporte em conta de investimento como transferência interna', () => {
    const suggestions = buildReconciliationSuggestions([
      { ...base, accountId: 'conta-corrente' },
      {
        ...base,
        id: 'aporte-investimento',
        amountCents: 100_000,
        accountId: 'conta-investimento',
        description: 'Aporte para investimentos',
      },
    ])

    expect(suggestions[0]).toMatchObject({
      type: 'transfer',
      transactionIds: ['one', 'aporte-investimento'],
    })
  })

  it('concilia aportes em BTC pelo valor em satoshis', () => {
    const suggestions = buildReconciliationSuggestions([
      {
        ...base,
        amountCents: -12_345_678,
        currency: 'BTC',
        accountId: 'carteira-btc',
      },
      {
        ...base,
        id: 'exchange-btc',
        amountCents: 12_345_678,
        currency: 'BTC',
        accountId: 'exchange-btc',
      },
    ])

    expect(suggestions[0]?.type).toBe('transfer')
  })

  it('não confunde satoshis e centavos em uma falsa transferência cambial', () => {
    const suggestions = buildReconciliationSuggestions([
      {
        ...base,
        amountCents: -1_000,
        currency: 'BTC',
        accountId: 'carteira-btc',
      },
      {
        ...base,
        id: 'brl',
        amountCents: 5_000,
        currency: 'BRL',
        accountId: 'conta-brl',
      },
    ])

    expect(suggestions).toEqual([])
  })

  it('prioriza pagamento de fatura quando existe um cartão', () => {
    const suggestions = buildReconciliationSuggestions([
      { ...base, description: 'Pagamento de fatura' },
      {
        ...base,
        id: 'two',
        amountCents: 100_000,
        accountId: null,
        creditCardId: 'card',
        description: 'Pagamento recebido',
      },
    ])
    expect(suggestions[0]?.type).toBe('card_payment')
    expect(suggestions[0]?.autoConfirm).toBe(true)
  })

  it('auto-confirma pagamento quando a Pluggy classifica o crédito do cartão como pagamento', () => {
    const suggestions = buildReconciliationSuggestions([
      { ...base, description: 'Pagamento de fatura' },
      {
        ...base,
        id: 'two',
        amountCents: 100_000,
        accountId: null,
        creditCardId: 'card',
        description: 'Pagamento efetuado',
        providerCategory: 'Credit card payment',
      },
    ])
    expect(suggestions[0]?.type).toBe('card_payment')
    expect(suggestions[0]?.autoConfirm).toBe(true)
  })

  it.each([
    ['estorno', 'Estorno loja', null],
    ['chargeback', 'Chargeback Loja Exemplo', null],
    ['cashback', 'Cashback mensal', null],
    ['crédito sem identificação', 'Crédito', null],
    [
      'estorno classificado como pagamento',
      'Estorno pagamento',
      'Credit card payment',
    ],
  ])(
    'mantém sugerido quando o crédito do cartão é %s',
    (_label, description, providerCategory) => {
      const suggestions = buildReconciliationSuggestions([
        { ...base, description: 'Pagamento fatura cartão principal' },
        {
          ...base,
          id: 'refund',
          amountCents: 100_000,
          accountId: null,
          creditCardId: 'other-card',
          description,
          providerCategory,
        },
      ])
      expect(suggestions).toHaveLength(1)
      expect(suggestions[0]?.type).toBe('card_payment')
      expect(suggestions[0]?.autoConfirm).toBeUndefined()
      expect(suggestions[0]?.confidence).toBeLessThan(100)
    },
  )

  it('reconhece variações bancárias de pagamento de fatura', () => {
    const suggestions = buildReconciliationSuggestions([
      { ...base, description: 'PAGTO CARTAO 1234' },
      {
        ...base,
        id: 'two',
        amountCents: 100_000,
        accountId: null,
        creditCardId: 'card',
        description: 'Pagamento recebido',
      },
    ])
    expect(suggestions[0]?.type).toBe('card_payment')
  })

  it('não auto-confirma pagamento quando dois cartões têm o mesmo total', () => {
    const suggestions = buildReconciliationSuggestions([
      { ...base, description: 'Pagamento de fatura' },
      {
        ...base,
        id: 'card-a',
        amountCents: 100_000,
        accountId: null,
        creditCardId: 'card-a',
      },
      {
        ...base,
        id: 'card-b',
        amountCents: 100_000,
        accountId: null,
        creditCardId: 'card-b',
      },
    ])
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]?.type).toBe('card_payment')
    expect(suggestions[0]?.autoConfirm).toBeUndefined()
  })

  it('liga câmbio com taxa plausível e estorno do mesmo estabelecimento', () => {
    const fx = buildReconciliationSuggestions([
      {
        ...base,
        amountCents: -1_000,
        currency: 'USD',
        description: 'Resgate enviado',
      },
      {
        ...base,
        id: 'two',
        amountCents: 5_500,
        accountId: 'brl',
        description: 'Resgate Global Account',
      },
    ])
    expect(fx[0]).toMatchObject({
      type: 'fx_transfer',
      exchangeRateMicros: 5_500_000,
    })

    const refund = buildReconciliationSuggestions([
      { ...base, description: 'Loja Exemplo', accountId: 'checking' },
      {
        ...base,
        id: 'two',
        description: 'Estorno Loja Exemplo',
        amountCents: 100_000,
        accountId: 'checking',
        postedAt: '2026-08-20',
      },
    ])
    expect(refund[0]?.type).toBe('refund')
  })

  it('não sugere correspondências com sinais iguais', () => {
    expect(
      buildReconciliationSuggestions([
        base,
        { ...base, id: 'two', accountId: 'other' },
      ]),
    ).toEqual([])
  })

  it('distingue distribuição de lucros de transferência interna', () => {
    const suggestions = buildReconciliationSuggestions([
      { ...base, scopeType: 'company_br' },
      {
        ...base,
        id: 'two',
        amountCents: 100_000,
        accountId: 'personal',
        scopeType: 'person',
      },
    ])
    expect(suggestions[0]?.type).toBe('profit_distribution')
  })

  it('não reutiliza a mesma transação em múltiplos matches', () => {
    const suggestions = buildReconciliationSuggestions([
      { ...base, description: 'Pagamento de fatura' },
      {
        ...base,
        id: 'card',
        amountCents: 100_000,
        accountId: null,
        creditCardId: 'card',
      },
      {
        ...base,
        id: 'other-account',
        amountCents: 100_000,
        accountId: 'other',
      },
    ])
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]?.type).toBe('card_payment')
  })
})

it('não associa receita ACH a despesas comuns só por data e taxa aparente', () => {
  const suggestions = buildReconciliationSuggestions([
    {
      ...base,
      id: 'health',
      amountCents: -156_782,
      description: 'Pagamento plano de saúde',
    },
    {
      ...base,
      id: 'salary',
      amountCents: 1_200_000,
      currency: 'USD',
      accountId: 'global',
      description: 'Transferência ACH recebida Cliente',
    },
  ])
  expect(suggestions).toEqual([])
})

it('preserva a remessa correta quando outro crédito aparece antes no extrato', () => {
  const suggestions = buildReconciliationSuggestions([
    {
      ...base,
      id: 'external-income',
      amountCents: 1_735_162,
      postedAt: '2026-06-05',
      description: 'Transferência recebida Cliente',
    },
    {
      ...base,
      id: 'usd-out',
      amountCents: -500_000,
      currency: 'USD',
      accountId: 'global',
      postedAt: '2026-06-08',
      description: 'Resgate enviado',
    },
    {
      ...base,
      id: 'brl-in',
      amountCents: 2_547_849,
      postedAt: '2026-06-08',
      description: 'Resgate Global Account',
    },
  ])
  expect(suggestions.map((item) => item.transactionIds)).toEqual([
    ['usd-out', 'brl-in'],
  ])
})
