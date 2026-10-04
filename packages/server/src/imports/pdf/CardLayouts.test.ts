import { assert, describe, it } from '@effect/vitest'
import * as Result from 'effect/Result'

import { positionedText } from '../../testing/SyntheticPdf.ts'
import { parseInterCard } from './InterCard.ts'
import { groupLines } from './Layout.ts'
import { parseNubankCard } from './NubankCard.ts'

const read = (
  parse: typeof parseInterCard,
  items: ReadonlyArray<ReturnType<typeof positionedText>>,
) => parse({ text: '', lines: groupLines(items) })

const summary = (result: ReturnType<typeof parseInterCard>) => {
  const statement = Result.getOrThrow(result)
  return {
    period: statement.period,
    closingBalance: statement.closingBalance,
    accountHint: statement.accountHint,
    lines: statement.lines.map((line) => [
      line.bookedOn,
      line.description,
      line.amountCents,
    ]),
  }
}

describe('Inter card bill', () => {
  for (const separator of ['-', '']) {
    it(`reads purchases with separator ${JSON.stringify(separator)}, records the payment and books late installments in the cycle`, () => {
      const items = [
        positionedText(
          'Este é o valor que você precisa pagar nesse mês 15/05/2026',
          1,
          20,
          500,
        ),
        positionedText('Fatura atual R$ 400,00', 2, 20, 100),
        positionedText('Despesas da fatura', 3, 20, 550),
        positionedText('CARTÃO 5364****3879', 3, 20, 520),
        positionedText(
          '08 de abr. 2026 Compra capturada tarde (Parcela 01 de 02) - R$ 50,00',
          3,
          20,
          500,
        ),
        positionedText(
          '20 de mar. 2026 Compra antiga (Parcela 02 de 03) - R$ 100,00',
          3,
          20,
          480,
        ),
        positionedText(
          '09 de abr. 2026 PAGAMENTO ON LINE - + R$ 500,00',
          3,
          20,
          460,
        ),
        positionedText(
          '10 de abr. 2026 PAGAMENTO*Estetica T (Parcela 01 de 03) - R$ 250,00',
          3,
          20,
          440,
        ),
        positionedText('Data de corte: 08/06/2026', 7, 230, 530),
      ].map((item) => ({
        ...item,
        text: item.text.replace(' - ', ` ${separator} `),
      }))

      assert.deepStrictEqual(summary(read(parseInterCard, items)), {
        period: { start: '2026-04-09', end: '2026-05-08' },
        closingBalance: { asOf: '2026-05-08', cents: -40_000 },
        accountHint: '3879',
        lines: [
          ['2026-04-09', 'Compra capturada tarde (Parcela 01 de 02)', -5_000],
          ['2026-04-20', 'Compra antiga (Parcela 02 de 03)', -10_000],
          ['2026-04-09', 'PAGAMENTO ON LINE', 50_000],
          ['2026-04-10', 'PAGAMENTO*Estetica T (Parcela 01 de 03)', -25_000],
        ],
      })
    })
  }

  const gross = [
    positionedText(
      'Este é o valor que você precisa pagar nesse mês 15/09/2026',
      1,
      20,
      500,
    ),
    positionedText('Fatura atual R$ 120,00', 2, 20, 120),
    positionedText('Valor antecipado R$ 30,00', 2, 20, 100),
    positionedText('Despesas do mês R$ 150,00', 2, 20, 80),
    positionedText('Despesas da fatura', 3, 20, 550),
    positionedText('20 de ago. 2026 Compra A  R$ 100,00', 3, 20, 480),
    positionedText('21 de ago. 2026 Compra B  R$ 50,00', 3, 20, 460),
    positionedText(
      '22 de ago. 2026 CRED PARC LOJ PARCELA  + R$ 20,00',
      3,
      20,
      440,
    ),
    positionedText('Data de corte: 08/10/2026', 7, 230, 530),
  ]

  it('reconciles gross purchases while keeping credits and anticipated payments', () => {
    const statement = summary(read(parseInterCard, gross))
    assert.deepStrictEqual(
      statement.lines.map(([, , amount]) => amount),
      [-10_000, -5_000, 2_000],
    )
    assert.deepStrictEqual(statement.closingBalance?.cents, -13_000)
  })

  it('refuses a bill whose lines or summary do not close', () => {
    const variants = [
      ['Compra B  R$ 50,00', 'Compra B  R$ 49,99'],
      ['Valor antecipado R$ 30,00', 'Valor antecipado R$ 29,99'],
      ['Despesas do mês R$ 150,00', 'Despesas do mês R$ 150,01'],
    ].map(([before, after]) =>
      gross.map((item) => ({
        ...item,
        text: item.text.replace(before!, after!),
      })),
    )
    for (const items of [
      ...variants,
      gross.filter((item) => !item.text.includes('Compra B')),
    ]) {
      assert.deepStrictEqual(
        read(parseInterCard, items),
        Result.fail('summary_balance_mismatch'),
      )
    }
  })

  it('accepts a bill paid before the cut by its month expenses', () => {
    const items = [
      positionedText(
        'Este é o valor que você precisa pagar nesse mês 15/09/2026',
        1,
        20,
        500,
      ),
      positionedText('Fatura atual R$ 0,00', 2, 20, 120),
      positionedText('Valor antecipado R$ 160,00', 2, 20, 100),
      positionedText('Despesas do mês R$ 150,00', 2, 20, 80),
      positionedText('Despesas da fatura', 3, 20, 550),
      positionedText('CARTÃO 5364****3879', 3, 20, 520),
      positionedText(
        '06 de ago. 2026 PAGAMENTO ON LINE - + R$ 160,00',
        3,
        20,
        480,
      ),
      positionedText('20 de jul. 2026 Mercado - R$ 100,00', 3, 20, 460),
      positionedText('15 de jul. 2026 Padaria - R$ 50,00', 3, 20, 440),
      positionedText('Data de corte: 08/09/2026', 7, 230, 530),
    ]
    const statement = summary(read(parseInterCard, items))
    assert.deepStrictEqual(
      [statement.period, statement.closingBalance, statement.lines.length],
      [
        { start: '2026-07-09', end: '2026-08-08' },
        { asOf: '2026-08-08', cents: -15_000 },
        3,
      ],
    )
    assert.deepStrictEqual(
      read(
        parseInterCard,
        items.filter((item) => !item.text.includes('Padaria')),
      ),
      Result.fail('summary_balance_mismatch'),
    )
  })

  it('refuses a bill without its due date or cut date', () => {
    assert.deepStrictEqual(
      read(parseInterCard, [positionedText('Fatura atual R$ 0,00', 2, 20, 1)]),
      Result.fail('no_statement'),
    )
  })
})

describe('Nubank card bill', () => {
  const items = [
    positionedText('Data de vencimento: 10 AGO 2026', 1, 120, 440),
    positionedText('Período vigente: 02 JUL a 02 AGO', 1, 120, 415),
    positionedText('Total a pagar R$ 350,00', 4, 140, 615),
    positionedText('TRANSAÇÕES DE 02 JUL A 02 AGO', 5, 50, 730),
    positionedText(
      '02 JUL •••• 2923 Compra parcelada - Parcela 3/5 R$ 100,00',
      5,
      120,
      640,
    ),
    positionedText('11 JUL Plano NuCel R$ 250,00', 5, 120, 610),
    positionedText('08 JUL Pagamento em 08 JUL −R$ 500,00', 5, 120, 580),
  ]

  it('reads purchases and other charges, and the payment as money in', () => {
    assert.deepStrictEqual(summary(read(parseNubankCard, items)), {
      period: { start: '2026-07-02', end: '2026-08-02' },
      closingBalance: { asOf: '2026-08-02', cents: -35_000 },
      accountHint: '2923',
      lines: [
        ['2026-07-02', 'Compra parcelada - Parcela 3/5', -10_000],
        ['2026-07-11', 'Plano NuCel', -25_000],
        ['2026-07-08', 'Pagamento em 08 JUL', 50_000],
      ],
    })
  })

  it('places a cycle spanning the new year in both years', () => {
    const statement = summary(
      read(parseNubankCard, [
        positionedText('Data de vencimento: 10 JAN 2027', 1, 120, 440),
        positionedText('Período vigente: 02 DEZ a 02 JAN', 1, 120, 415),
        positionedText('Total a pagar R$ 30,00', 1, 140, 400),
        positionedText('TRANSAÇÕES DE 02 DEZ A 02 JAN', 2, 50, 730),
        positionedText('20 DEZ Livraria R$ 10,00', 2, 120, 640),
        positionedText('01 JAN Cinema R$ 25,00', 2, 120, 610),
        positionedText('01 JAN Estorno Cinema −R$ 5,00', 2, 120, 580),
      ]),
    )
    assert.deepStrictEqual(statement.lines, [
      ['2026-12-20', 'Livraria', -1_000],
      ['2027-01-01', 'Cinema', -2_500],
      ['2027-01-01', 'Estorno Cinema', 500],
    ])
  })

  it('refuses a bill whose purchases do not add up to its total', () => {
    assert.deepStrictEqual(
      read(
        parseNubankCard,
        items.filter((item) => !item.text.includes('NuCel')),
      ),
      Result.fail('summary_balance_mismatch'),
    )
  })
})
