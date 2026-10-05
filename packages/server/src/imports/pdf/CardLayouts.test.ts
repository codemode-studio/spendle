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

  it('refuses a bill missing a purchase that equals what is still due', () => {
    // R$ 150,00 of expenses, R$ 50,00 paid early, R$ 100,00 due; the R$ 50,00
    // purchase was lost in extraction.
    const missing = gross
      .filter((item) => !/Compra B|CRED PARC/.test(item.text))
      .map((item) =>
        /^Fatura atual/.test(item.text)
          ? { ...item, text: 'Fatura atual R$ 100,00' }
          : /^Valor antecipado/.test(item.text)
            ? { ...item, text: 'Valor antecipado R$ 50,00' }
            : item,
      )
    assert.deepStrictEqual(
      read(parseInterCard, missing),
      Result.fail('summary_balance_mismatch'),
    )
    // Without the expenses line, an early payment rules the amount due out as a target.
    assert.deepStrictEqual(
      read(
        parseInterCard,
        missing.filter((item) => !/^Despesas do m/.test(item.text)),
      ),
      Result.fail('summary_balance_mismatch'),
    )
  })

  it('reconciles gross purchases while keeping credits and anticipated payments', () => {
    const statement = summary(read(parseInterCard, gross))
    assert.deepStrictEqual(
      statement.lines.map(([, , amount]) => amount),
      [-10_000, -5_000, 2_000],
    )
    assert.deepStrictEqual(statement.closingBalance?.cents, -12_000)
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

  it('checks the summary even when the purchases add up to the month', () => {
    // R$ 150,00 of purchases, R$ 30,00 paid early, but R$ 20,00 read as due.
    const items = gross
      .filter((item) => !item.text.includes('CRED PARC'))
      .map((item) =>
        /^Fatura atual/.test(item.text)
          ? { ...item, text: 'Fatura atual R$ 20,00' }
          : item,
      )
    assert.deepStrictEqual(
      read(parseInterCard, items),
      Result.fail('summary_balance_mismatch'),
    )
  })

  it('refuses an impossible purchase date before shifting instalments', () => {
    const items = gross.map((item) =>
      item.text.includes('Compra A')
        ? {
            ...item,
            text: item.text.replace(
              '20 de ago. 2026 Compra A',
              '31 de jun. 2026 Compra A (Parcela 03 de 03)',
            ),
          }
        : item,
    )
    assert.deepStrictEqual(
      read(parseInterCard, items),
      Result.fail('invalid_date'),
    )
  })

  const withPayment = (date: string, amount: string) =>
    gross.flatMap((item) =>
      item.text.includes('CRED PARC')
        ? [
            item,
            {
              ...item,
              y: item.y - 20,
              text: item.text
                .replace(
                  '22 de ago. 2026 CRED PARC LOJ PARCELA',
                  `${date} PAGAMENTO ON LINE`,
                )
                .replace('R$ 20,00', `R$ ${amount}`),
            },
          ]
        : [item],
    )

  it('accepts an overpaid bill with statement credits', () => {
    const items = withPayment('25 de ago. 2026', '140,00').map((item) =>
      /^Fatura atual/.test(item.text)
        ? { ...item, text: 'Fatura atual R$ 0,00' }
        : /^Valor antecipado/.test(item.text)
          ? { ...item, text: 'Valor antecipado R$ 160,00' }
          : item,
    )
    const statement = summary(read(parseInterCard, items))
    assert.deepStrictEqual(
      [statement.closingBalance?.cents, statement.lines.length],
      [0, 4],
    )
  })

  it('refuses a payment dated outside the cycle', () => {
    assert.deepStrictEqual(
      read(parseInterCard, withPayment('30 de nov. 2026', '500,00')),
      Result.fail('summary_balance_mismatch'),
    )
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
        { asOf: '2026-08-08', cents: 0 },
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

  it('keeps the payments the bill prints as anticipated, apart from its credits', () => {
    const advance = (items: ReadonlyArray<ReturnType<typeof positionedText>>) =>
      Result.getOrThrow(read(parseInterCard, items)).advanceCents ?? null
    // "Valor antecipado" R$ 30,00 counts the R$ 20,00 credit: R$ 10,00 was paid.
    assert.deepStrictEqual(
      [
        advance(gross),
        advance(
          gross.filter((item) => !/^Valor antecipado/.test(item.text)).map(
            (item) =>
              /^Fatura atual/.test(item.text)
                ? { ...item, text: 'Fatura atual R$ 130,00' }
                : /^Despesas do m/.test(item.text)
                  ? { ...item, text: 'Despesas do mês R$ 130,00' }
                  : item,
          ),
        ),
      ],
      [1_000, null],
    )
  })

  it('keeps the printed due date of a bill net of payments before the cut', () => {
    const statement = Result.getOrThrow(read(parseInterCard, gross))
    assert.deepStrictEqual(
      [statement.dueOn, statement.chargesOnly ?? false],
      ['2026-09-15', false],
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

  it('keeps the printed due date and a total of charges only', () => {
    const statement = Result.getOrThrow(read(parseNubankCard, items))
    assert.deepStrictEqual(
      [statement.dueOn, statement.chargesOnly],
      ['2026-08-10', true],
    )
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

describe('Nubank card bill dates', () => {
  const bill = (due: string, rows: ReadonlyArray<string>) => [
    positionedText(`Data de vencimento: ${due}`, 1, 120, 440),
    positionedText('Período vigente: 02 DEZ a 02 JAN', 1, 120, 415),
    positionedText('Total a pagar R$ 10,00', 1, 140, 400),
    positionedText('TRANSAÇÕES DE 02 DEZ A 02 JAN', 2, 50, 730),
    ...rows.map((row, index) => positionedText(row, 2, 120, 640 - index * 30)),
  ]

  it('refuses an impossible due date', () => {
    assert.deepStrictEqual(
      read(parseNubankCard, bill('32 JAN 2027', ['20 DEZ Livraria R$ 10,00'])),
      Result.fail('invalid_date'),
    )
  })

  it('refuses a payment dated outside the cycle', () => {
    assert.deepStrictEqual(
      read(
        parseNubankCard,
        bill('10 JAN 2027', [
          '20 DEZ Livraria R$ 10,00',
          '30 NOV Pagamento em 30 NOV −R$ 500,00',
        ]),
      ),
      Result.fail('summary_balance_mismatch'),
    )
  })
})
