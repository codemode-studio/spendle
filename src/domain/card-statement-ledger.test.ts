import { describe, expect, it } from 'vitest'

import { buildCardStatementLedger } from './card-statement-ledger'

const statements = [
  { closingDate: '2026-07-05', dueDate: '2026-07-15', amountCents: 100_000 },
  { closingDate: '2026-08-05', dueDate: '2026-08-15', amountCents: 50_000 },
  { closingDate: '2026-09-05', dueDate: '2026-09-15', amountCents: 80_000 },
  {
    closingDate: '2026-10-05',
    dueDate: '2026-10-15',
    amountCents: 20_000,
    certainty: 'installment_schedule' as const,
  },
]

const purchase = (id: string, postedAt: string, amountCents = -10_000) => ({
  id,
  postedAt,
  amountCents,
  description: 'Mercado',
  categoryId: 'groceries',
})

describe('livro-razão de faturas', () => {
  it('atribui compras ao ciclo que fecha depois delas', () => {
    const ledger = buildCardStatementLedger({
      statements,
      transactions: [
        purchase('a', '2026-07-05'),
        purchase('b', '2026-07-06'),
        purchase('c', '2026-08-20'),
      ],
      accountPayments: [],
      reconciliations: [],
      today: '2026-09-10',
    })
    expect(ledger.map((s) => s.transactionIds)).toEqual([
      ['a'],
      ['b'],
      ['c'],
      [],
    ])
  })

  it('usa o pagamento recebido informado pela fatura seguinte', () => {
    const ledger = buildCardStatementLedger({
      statements,
      transactions: [
        purchase('a', '2026-07-01'),
        {
          id: 'received',
          postedAt: '2026-07-15',
          amountCents: 100_000,
          description: 'Pagamento recebido',
          categoryId: 'card_payment',
        },
      ],
      accountPayments: [],
      reconciliations: [],
      today: '2026-09-10',
    })
    expect(ledger[0]).toMatchObject({
      status: 'paid',
      paidCents: 100_000,
      payments: [{ transactionId: 'received', kind: 'received' }],
    })
    expect(ledger[1].transactionIds).toEqual([])
  })

  it('liga o débito bancário quando a conciliação está confirmada ou sugerida', () => {
    const build = (status: 'confirmed' | 'suggested') =>
      buildCardStatementLedger({
        statements,
        transactions: [
          {
            id: 'received',
            postedAt: '2026-07-14',
            amountCents: 100_000,
            description: 'Pagamento recebido',
            categoryId: 'card_payment',
          },
        ],
        accountPayments: [
          {
            id: 'bank',
            postedAt: '2026-07-14',
            amountCents: -100_000,
            description: 'PAGTO FATURA CARTAO',
            categoryId: 'card_payment',
          },
        ],
        reconciliations: [
          {
            id: 'group',
            type: 'card_payment',
            status,
            transactionIds: ['received', 'bank'],
          },
        ],
        today: '2026-09-10',
      })
    expect(build('confirmed')[0]).toMatchObject({
      status: 'paid',
      payments: [
        { transactionId: 'bank', kind: 'confirmed', groupId: 'group' },
      ],
    })
    expect(build('suggested')[0]).toMatchObject({
      status: 'suggested',
      paidCents: 0,
      payments: [
        { transactionId: 'bank', kind: 'suggested', groupId: 'group' },
      ],
    })
  })

  it('infere pelo valor exato perto do vencimento e lista candidatos próximos', () => {
    const ledger = buildCardStatementLedger({
      statements,
      transactions: [],
      accountPayments: [
        {
          id: 'exact',
          postedAt: '2026-08-14',
          amountCents: -50_000,
          description: 'Pagamento de fatura',
          categoryId: 'card_payment',
        },
        {
          id: 'partial',
          postedAt: '2026-07-16',
          amountCents: -40_000,
          description: 'Débito',
          categoryId: 'card_payment',
        },
        {
          id: 'far',
          postedAt: '2026-05-01',
          amountCents: -100_000,
          description: 'Pagamento de fatura',
          categoryId: 'card_payment',
        },
      ],
      reconciliations: [],
      today: '2026-09-10',
    })
    expect(ledger[1]).toMatchObject({
      status: 'paid',
      payments: [{ transactionId: 'exact', kind: 'inferred' }],
    })
    expect(ledger[0]).toMatchObject({
      status: 'likely',
      payments: [{ transactionId: 'partial', kind: 'candidate' }],
    })
    expect(ledger[2].status).toBe('closed')
  })

  it('não infere quando duas faturas têm o mesmo total na janela', () => {
    const ledger = buildCardStatementLedger({
      statements: [
        { closingDate: '2026-07-05', dueDate: '2026-07-15', amountCents: 500 },
        { closingDate: '2026-07-20', dueDate: '2026-07-25', amountCents: 500 },
      ],
      transactions: [],
      accountPayments: [
        {
          id: 'pay',
          postedAt: '2026-07-18',
          amountCents: -500,
          description: 'Pagamento de fatura',
          categoryId: 'card_payment',
        },
      ],
      reconciliations: [],
      today: '2026-09-10',
    })
    expect(ledger.every((s) => s.status === 'likely')).toBe(true)
    expect(ledger[0].payments.map((p) => p.kind)).toEqual(['candidate'])
  })

  it('classifica aberta, prevista, fechada e vazia', () => {
    const ledger = buildCardStatementLedger({
      statements: [
        ...statements,
        { closingDate: '2026-06-05', dueDate: '2026-06-15', amountCents: 0 },
      ],
      transactions: [],
      accountPayments: [],
      reconciliations: [],
      today: '2026-09-10',
    })
    expect(ledger.map((s) => s.status)).toEqual([
      'empty',
      'overdue',
      'overdue',
      'closed',
      'scheduled',
    ])
    const open = buildCardStatementLedger({
      statements: statements.slice(0, 1),
      transactions: [],
      accountPayments: [],
      reconciliations: [],
      today: '2026-07-01',
    })
    expect(open[0].status).toBe('open')
  })

  it('vínculo manual marcado como parcial mantém a fatura em aberto', () => {
    const ledger = buildCardStatementLedger({
      statements,
      transactions: [],
      accountPayments: [
        {
          id: 'bank',
          postedAt: '2026-07-16',
          amountCents: -50_000,
          description: 'Pagamento de fatura',
          categoryId: 'card_payment',
        },
      ],
      reconciliations: [],
      manualLinks: [
        {
          id: 'link',
          dueDate: '2026-07-15',
          transactionId: 'bank',
          partial: true,
        },
      ],
      today: '2026-09-10',
    })
    expect(ledger[0]).toMatchObject({ status: 'partial', paidCents: 50_000 })
  })

  it('vínculo manual quita a fatura e tira o débito dos candidatos', () => {
    const ledger = buildCardStatementLedger({
      statements,
      transactions: [],
      accountPayments: [
        {
          id: 'bank',
          postedAt: '2026-07-16',
          amountCents: -99_000,
          description: 'Pagamento de fatura',
          categoryId: 'card_payment',
        },
      ],
      reconciliations: [],
      manualLinks: [
        { id: 'link', dueDate: '2026-07-15', transactionId: 'bank' },
      ],
      today: '2026-09-10',
    })
    expect(ledger[0]).toMatchObject({
      status: 'paid',
      paidCents: 99_000,
      payments: [{ transactionId: 'bank', kind: 'manual', linkId: 'link' }],
    })
    expect(ledger[1].payments).toEqual([])
  })
})
