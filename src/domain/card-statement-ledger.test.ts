import { describe, expect, it } from 'vitest'

import {
  buildCardStatementLedger,
  statementCashSettlement,
} from './card-statement-ledger'

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

  it('não soma de novo o recebimento do débito vinculado à mão sem conciliação', () => {
    const receipt = (id: string, postedAt: string, amountCents: number) => ({
      id,
      postedAt,
      amountCents,
      description: 'Pagamento recebido',
      categoryId: 'card_payment',
    })
    const ledger = buildCardStatementLedger({
      statements,
      transactions: [
        receipt('same-payment', '2026-07-16', 50_000),
        receipt('another-payment', '2026-07-25', 20_000),
      ],
      accountPayments: [
        {
          id: 'bank',
          postedAt: '2026-07-16',
          amountCents: -50_000,
          description: 'Débito genérico',
          categoryId: 'groceries',
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
    expect(ledger[0]).toMatchObject({ status: 'partial', paidCents: 70_000 })
    expect(ledger[0].payments.map((p) => p.transactionId).sort()).toEqual([
      'another-payment',
      'bank',
    ])
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

describe('pagamento confirmado sem descrição de recebimento', () => {
  it('quita a fatura uma vez com o crédito do grupo confirmado', () => {
    const ledger = buildCardStatementLedger({
      statements,
      transactions: [
        purchase('a', '2026-07-01', -100_000),
        {
          id: 'card-credit',
          postedAt: '2026-07-15',
          amountCents: 100_000,
          description: 'Pagamento efetuado',
          categoryId: 'card_payment',
        },
      ],
      accountPayments: [
        {
          id: 'bank-debit',
          postedAt: '2026-07-15',
          amountCents: -100_000,
          description: 'Pagamento fatura cartão',
          categoryId: 'card_payment',
        },
      ],
      reconciliations: [
        {
          id: 'group',
          type: 'card_payment',
          status: 'confirmed',
          transactionIds: ['bank-debit', 'card-credit'],
        },
      ],
      today: '2026-09-10',
    })
    const july = ledger.find((entry) => entry.dueDate === '2026-07-15')!
    expect(july).toMatchObject({ paidCents: 100_000, status: 'paid' })
    expect(july.payments).toEqual([
      expect.objectContaining({
        transactionId: 'bank-debit',
        kind: 'confirmed',
        evidenceIds: ['card-credit'],
      }),
    ])
    expect(ledger.flatMap((entry) => entry.transactionIds)).toEqual(['a'])
  })
})

describe('recebimento identificado pela categoria do provedor', () => {
  const credit = (description: string) => ({
    id: 'card-credit',
    postedAt: '2026-07-10',
    amountCents: 100_000,
    description,
    categoryId: null,
    providerCategory: 'Credit card payment',
  })

  it('quita a fatura sem débito bancário vinculado', () => {
    const ledger = buildCardStatementLedger({
      statements,
      transactions: [credit('Pagamento efetuado')],
      accountPayments: [],
      reconciliations: [],
      today: '2026-09-10',
    })
    const july = ledger.find((entry) => entry.dueDate === '2026-07-15')!
    expect(july).toMatchObject({ paidCents: 100_000, status: 'paid' })
    // The receipt is not a credit of the cycle it posted in.
    const august = ledger.find((entry) => entry.dueDate === '2026-08-15')!
    expect(august.transactionIds).toEqual([])
  })

  it('não trata um estorno como recebimento', () => {
    const ledger = buildCardStatementLedger({
      statements,
      transactions: [credit('Estorno loja')],
      accountPayments: [],
      reconciliations: [],
      today: '2026-09-10',
    })
    const july = ledger.find((entry) => entry.dueDate === '2026-07-15')!
    expect(july.paidCents).toBe(0)
    const august = ledger.find((entry) => entry.dueDate === '2026-08-15')!
    expect(august.transactionIds).toEqual(['card-credit'])
  })
})

describe('pagamento antecipado de fatura', () => {
  const receipt = (id: string, postedAt: string, amountCents: number) => ({
    id,
    postedAt,
    amountCents,
    description: 'Pagamento recebido',
    categoryId: 'card_payment',
  })
  const byDue = (ledger: ReturnType<typeof buildCardStatementLedger>) =>
    Object.fromEntries(ledger.map((entry) => [entry.dueDate, entry.paidCents]))

  it('quita a fatura do ciclo em que caiu quando não há fatura anterior', () => {
    const ledger = buildCardStatementLedger({
      statements: [
        {
          closingDate: '2026-08-20',
          dueDate: '2026-08-27',
          amountCents: 100_000,
        },
        {
          closingDate: '2026-09-20',
          dueDate: '2026-09-27',
          amountCents: 40_000,
        },
      ],
      transactions: [
        purchase('august', '2026-08-05', -100_000),
        receipt('advance', '2026-08-19', 20_000),
      ],
      accountPayments: [],
      reconciliations: [],
      today: '2026-08-26',
    })
    expect(ledger[0]).toMatchObject({
      paidCents: 20_000,
      status: 'partial',
      payments: [{ transactionId: 'advance', kind: 'received' }],
    })
  })

  it('não leva à fatura anterior já quitada', () => {
    const ledger = buildCardStatementLedger({
      statements,
      transactions: [
        receipt('july', '2026-07-14', 100_000),
        receipt('august-advance', '2026-08-01', 20_000),
      ],
      accountPayments: [],
      reconciliations: [],
      today: '2026-09-10',
    })
    expect(byDue(ledger)).toMatchObject({
      '2026-07-15': 100_000,
      '2026-08-15': 20_000,
    })
    expect(ledger[1].payments).toEqual([
      expect.objectContaining({ transactionId: 'august-advance' }),
    ])
  })

  it('quita primeiro a fatura anterior em aberto e leva o excedente adiante', () => {
    const late = buildCardStatementLedger({
      statements,
      transactions: [receipt('late', '2026-07-30', 50_000)],
      accountPayments: [],
      reconciliations: [],
      today: '2026-09-10',
    })
    expect(byDue(late)).toMatchObject({ '2026-07-15': 50_000, '2026-08-15': 0 })

    const over = buildCardStatementLedger({
      statements,
      transactions: [receipt('over', '2026-07-14', 120_000)],
      accountPayments: [],
      reconciliations: [],
      today: '2026-09-10',
    })
    expect(byDue(over)).toMatchObject({
      '2026-07-15': 100_000,
      '2026-08-15': 20_000,
    })
  })

  it('conta o débito vinculado à mão antes de antecipar', () => {
    const ledger = buildCardStatementLedger({
      statements,
      transactions: [receipt('advance', '2026-07-25', 20_000)],
      accountPayments: [
        {
          id: 'bank',
          postedAt: '2026-07-14',
          amountCents: -100_000,
          description: 'Débito genérico',
          categoryId: 'groceries',
        },
      ],
      reconciliations: [],
      manualLinks: [
        { id: 'link', dueDate: '2026-07-15', transactionId: 'bank' },
      ],
      today: '2026-09-10',
    })
    expect(byDue(ledger)).toMatchObject({
      '2026-07-15': 100_000,
      '2026-08-15': 20_000,
    })
  })

  it('não credita ao primeiro ciclo o pagamento da fatura anterior ao histórico', () => {
    // History starts at a cycle; the bill that closed before it is paid
    // inside that cycle, before its own due date.
    const ledger = buildCardStatementLedger({
      statements: statements.slice(0, 2),
      transactions: [receipt('previous-bill', '2026-06-14', 90_000)],
      accountPayments: [],
      reconciliations: [],
      today: '2026-09-10',
    })
    expect(byDue(ledger)).toEqual({ '2026-07-15': 0, '2026-08-15': 0 })
  })

  const julyAugust = [
    { closingDate: '2026-07-20', dueDate: '2026-07-27', amountCents: 100_000 },
    { closingDate: '2026-08-20', dueDate: '2026-08-27', amountCents: 100_000 },
  ]

  it('identifica o débito da fatura anterior antes de antecipar a seguinte', () => {
    const ledger = buildCardStatementLedger({
      statements: julyAugust,
      transactions: [receipt('advance', '2026-08-19', 20_000)],
      accountPayments: [
        {
          id: 'bank',
          postedAt: '2026-07-27',
          amountCents: -100_000,
          description: 'Pagamento fatura cartão',
          categoryId: 'card_payment',
        },
      ],
      reconciliations: [],
      today: '2026-08-26',
    })
    expect(ledger[0]).toMatchObject({
      paidCents: 100_000,
      status: 'paid',
      payments: [{ transactionId: 'bank', kind: 'inferred' }],
    })
    expect(ledger[1]).toMatchObject({
      paidCents: 20_000,
      payments: [{ transactionId: 'advance', kind: 'received' }],
    })
  })

  it('conta uma vez o recebimento que é o lado do cartão do débito identificado', () => {
    const ledger = buildCardStatementLedger({
      statements: julyAugust,
      transactions: [
        receipt('july-receipt', '2026-07-27', 100_000),
        receipt('advance', '2026-08-19', 20_000),
      ],
      accountPayments: [
        {
          id: 'bank',
          postedAt: '2026-07-27',
          amountCents: -100_000,
          description: 'Pagamento fatura cartão',
          categoryId: 'card_payment',
        },
      ],
      reconciliations: [],
      today: '2026-08-26',
    })
    expect(ledger[0]).toMatchObject({
      paidCents: 100_000,
      payments: [
        {
          transactionId: 'bank',
          kind: 'inferred',
          evidenceIds: ['july-receipt'],
        },
      ],
    })
    expect(ledger[1].paidCents).toBe(20_000)
  })

  it('não deixa um recebimento pendente desviar um pagamento lançado para a fatura seguinte', () => {
    const isPosted = (id: string) => id !== 'pending'
    const ledger = buildCardStatementLedger({
      statements: julyAugust,
      transactions: [
        receipt('pending', '2026-07-23', 100_000),
        receipt('posted', '2026-07-25', 20_000),
      ],
      accountPayments: [],
      reconciliations: [],
      isPosted,
      today: '2026-08-26',
    })
    expect(ledger[0].payments.map((p) => p.transactionId)).toEqual([
      'pending',
      'posted',
    ])
    expect(ledger[1].payments).toEqual([])
    expect(
      ledger.map((entry) => statementCashSettlement(entry, isPosted).paidCents),
    ).toEqual([20_000, 0])
  })
})

describe('ordem de alocação dos recebimentos', () => {
  const receipt = (id: string, postedAt: string, amountCents: number) => ({
    id,
    postedAt,
    amountCents,
    description: 'Pagamento recebido',
    categoryId: 'card_payment',
  })
  const julyAugust = [
    { closingDate: '2026-07-20', dueDate: '2026-07-27', amountCents: 100_000 },
    { closingDate: '2026-08-20', dueDate: '2026-08-27', amountCents: 150_000 },
  ]

  it('aloca recebimentos com e sem conciliação do mais antigo ao mais novo', () => {
    // July's bill is paid by its own receipt on Jul 27; the advance matched
    // to a bank debit on Aug 19 belongs to August, not to the paid July bill.
    const ledger = buildCardStatementLedger({
      statements: julyAugust,
      transactions: [
        receipt('july-receipt', '2026-07-27', 100_000),
        receipt('advance', '2026-08-19', 120_000),
      ],
      accountPayments: [
        {
          id: 'bank-advance',
          postedAt: '2026-08-19',
          amountCents: -120_000,
          description: 'Pagamento fatura cartão',
          categoryId: 'card_payment',
        },
      ],
      reconciliations: [
        {
          id: 'group',
          type: 'card_payment',
          status: 'confirmed',
          transactionIds: ['bank-advance', 'advance'],
        },
      ],
      today: '2026-08-26',
    })
    expect(ledger.map((entry) => entry.paidCents)).toEqual([100_000, 120_000])
    expect(ledger[0].payments.map((p) => p.transactionId)).toEqual([
      'july-receipt',
    ])
    expect(ledger[1].payments).toEqual([
      expect.objectContaining({
        transactionId: 'bank-advance',
        kind: 'confirmed',
        evidenceIds: ['advance'],
      }),
    ])
    expect(
      ledger.map((entry) => statementCashSettlement(entry, () => true)),
    ).toEqual([
      { paidCents: 100_000, paid: true },
      { paidCents: 120_000, paid: false },
    ])
  })

  it('não infere outro débito para a fatura que um grupo conciliado já identifica', () => {
    const debit = (id: string, postedAt: string) => ({
      id,
      postedAt,
      amountCents: -100_000,
      description: 'Pagamento fatura cartão',
      categoryId: 'card_payment',
    })
    const ledger = buildCardStatementLedger({
      statements: julyAugust,
      transactions: [receipt('july-receipt', '2026-07-27', 100_000)],
      accountPayments: [
        debit('grouped', '2026-07-27'),
        debit('other', '2026-07-28'),
      ],
      reconciliations: [
        {
          id: 'group',
          type: 'card_payment',
          status: 'confirmed',
          transactionIds: ['grouped', 'july-receipt'],
        },
      ],
      today: '2026-08-26',
    })
    expect(ledger[0]).toMatchObject({
      paidCents: 100_000,
      payments: [{ transactionId: 'grouped', kind: 'confirmed' }],
    })
  })

  it('não deixa um débito vinculado à mão ainda não lançado desviar um recebimento lançado', () => {
    // On Jul 26 the hand-linked debit is dated Jul 27: it has not left the
    // account, so the posted R$ 200 receipt still pays July.
    const isPosted = (id: string) => id !== 'future-debit'
    const ledger = buildCardStatementLedger({
      statements: [julyAugust[0], { ...julyAugust[1], amountCents: 100_000 }],
      transactions: [receipt('posted', '2026-07-25', 20_000)],
      accountPayments: [
        {
          id: 'future-debit',
          postedAt: '2026-07-27',
          amountCents: -100_000,
          description: 'Débito genérico',
          categoryId: 'card_payment',
        },
      ],
      reconciliations: [],
      manualLinks: [
        { id: 'link', dueDate: '2026-07-27', transactionId: 'future-debit' },
      ],
      isPosted,
      today: '2026-07-26',
    })
    expect(ledger[0].payments.map((p) => p.transactionId)).toEqual([
      'posted',
      'future-debit',
    ])
    expect(ledger[1].payments).toEqual([])
    expect(
      ledger.map((entry) => statementCashSettlement(entry, isPosted).paidCents),
    ).toEqual([20_000, 0])
  })

  it('conta o débito vinculado à mão quando o recebimento dele já foi lançado', () => {
    const isPosted = (id: string) => id !== 'future-debit'
    const ledger = buildCardStatementLedger({
      statements: [julyAugust[0], { ...julyAugust[1], amountCents: 100_000 }],
      transactions: [
        receipt('pair', '2026-07-24', 100_000),
        receipt('advance', '2026-07-25', 20_000),
      ],
      accountPayments: [
        {
          id: 'future-debit',
          postedAt: '2026-07-27',
          amountCents: -100_000,
          description: 'Débito genérico',
          categoryId: 'card_payment',
        },
      ],
      reconciliations: [],
      manualLinks: [
        { id: 'link', dueDate: '2026-07-27', transactionId: 'future-debit' },
      ],
      isPosted,
      today: '2026-07-26',
    })
    expect(
      ledger.map((entry) => statementCashSettlement(entry, isPosted).paidCents),
    ).toEqual([100_000, 20_000])
  })
})

describe('evidência de vínculos parciais futuros', () => {
  const receipt = (id: string, postedAt: string, amountCents: number) => ({
    id,
    postedAt,
    amountCents,
    description: 'Pagamento recebido',
    categoryId: 'card_payment',
  })
  const debit = (id: string, postedAt: string) => ({
    id,
    postedAt,
    amountCents: -50_000,
    description: 'Débito genérico',
    categoryId: 'card_payment',
  })

  it('um recebimento sustenta só um vínculo parcial', () => {
    // On Jul 26, two R$ 500 partial links to debits dated Jul 27 and 28. Only
    // the R$ 500 receipt of Jul 24 backs one of them; the R$ 200 of Jul 25
    // still pays July, which owes R$ 300 more.
    const isPosted = (id: string) => !id.startsWith('future-')
    const ledger = buildCardStatementLedger({
      statements: [
        {
          closingDate: '2026-07-20',
          dueDate: '2026-07-27',
          amountCents: 100_000,
        },
        {
          closingDate: '2026-08-20',
          dueDate: '2026-08-27',
          amountCents: 100_000,
        },
      ],
      transactions: [
        receipt('pair', '2026-07-24', 50_000),
        receipt('advance', '2026-07-25', 20_000),
      ],
      accountPayments: [
        debit('future-first', '2026-07-27'),
        debit('future-second', '2026-07-28'),
      ],
      reconciliations: [],
      manualLinks: [
        {
          id: 'first',
          dueDate: '2026-07-27',
          transactionId: 'future-first',
          partial: true,
        },
        {
          id: 'second',
          dueDate: '2026-07-27',
          transactionId: 'future-second',
          partial: true,
        },
      ],
      isPosted,
      today: '2026-07-26',
    })
    expect(ledger[1].payments).toEqual([])
    expect(
      ledger.map((entry) => statementCashSettlement(entry, isPosted).paidCents),
    ).toEqual([70_000, 0])
    const evidence = ledger[0].payments
      .filter((p) => p.kind === 'manual')
      .map((p) => p.evidenceIds)
    expect(evidence.flat()).toEqual(['pair'])
  })
})
