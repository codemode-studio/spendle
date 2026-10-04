import { assert, describe, it } from '@effect/vitest'
import * as Result from 'effect/Result'

import { parseCsv, splitCsv } from './Csv.ts'

const amounts = (text: string, kind: 'account' | 'card') =>
  Result.getOrThrow(parseCsv(text, kind)).lines.map((line) => [
    line.description,
    line.amountCents,
  ])

describe('parseCsv', () => {
  it('treats unsigned card amounts as purchases and signed ones as credits', () => {
    const nubankCard =
      'date,title,amount\n2026-09-12,Mercado,89.90\n2026-09-15,Estorno Mercado,-89.90\n'
    assert.deepStrictEqual(amounts(nubankCard, 'card'), [
      ['Mercado', -8990],
      ['Estorno Mercado', 8990],
    ])
  })

  it('reads separate debit and credit columns and a direction column', () => {
    const split =
      'Data;Histórico;Débito;Crédito\n05/09/2026;Salário;;1.000,00\n10/09/2026;Aluguel;1.500,00;\n'
    assert.deepStrictEqual(amounts(split, 'account'), [
      ['Salário', 100000],
      ['Aluguel', -150000],
    ])
    const direction =
      'Data,Descrição,Valor,Tipo\n10/09/2026,Pix enviado,"50,00",Débito\n'
    assert.deepStrictEqual(amounts(direction, 'account'), [
      ['Pix enviado', -5000],
    ])
  })

  it('reads the summary above the table and takes the closing balance from it', () => {
    const inter = [
      'Extrato Conta Corrente',
      'Conta ;12345-0532',
      'Período ;01/09/2026 a 30/09/2026',
      'Saldo ;900,00',
      '',
      'Data Lançamento;Histórico;Descrição;Valor;Saldo',
      '30/09/2026;Pix;Padaria;-100,00;900,00',
      '05/09/2026;Pix;Salário;1.000,00;1.000,00',
    ].join('\n')
    const statement = Result.getOrThrow(parseCsv(inter, 'account'))
    assert.deepStrictEqual(
      [statement.accountHint, statement.period, statement.closingBalance],
      [
        '0532',
        { start: '2026-09-01', end: '2026-09-30' },
        { asOf: '2026-09-30', cents: 90000 },
      ],
    )
  })

  it('refuses a running balance that does not chain with the amounts', () => {
    const broken =
      'Data;Descrição;Valor;Saldo\n05/09/2026;A;100,00;100,00\n06/09/2026;B;-10,00;95,00\n'
    assert.deepStrictEqual(
      parseCsv(broken, 'account'),
      Result.fail('running_balance_mismatch'),
    )
  })

  it('counts rows it cannot read', () => {
    const text =
      'Data,Descrição,Valor\n2026-09-05,Ok,1\n31/02/2026,Bad date,1\n2026-09-06,,1\n'
    assert.strictEqual(
      Result.getOrThrow(parseCsv(text, 'account')).rejectedRows,
      2,
    )
  })

  it('keeps the newest balance at its own date when a rejected row follows it', () => {
    const rows = [
      '05/09/2026;Salário;100,00;100,00',
      '10/09/2026;;-10,00;',
      '30/09/2026;Padaria;-5,00;',
    ]
    const text = (summary: string, order: ReadonlyArray<string>) =>
      [
        ...(summary
          ? ['Período ;01/09/2026 a 30/09/2026', `Saldo ;${summary}`]
          : []),
        'Data;Descrição;Valor;Saldo',
        ...order,
      ].join('\n')
    for (const order of [rows, [...rows].reverse()]) {
      const statement = Result.getOrThrow(parseCsv(text('', order), 'account'))
      assert.deepStrictEqual(
        [statement.closingBalance, statement.rejectedRows],
        [{ asOf: '2026-09-05', cents: 10000 }, 1],
      )
      assert.deepStrictEqual(
        Result.getOrThrow(parseCsv(text('85,00', order), 'account'))
          .closingBalance,
        { asOf: '2026-09-30', cents: 8500 },
      )
    }
  })

  it('reads balances only in an order the dates allow', () => {
    assert.deepStrictEqual(
      parseCsv(
        'Data;Descrição;Valor;Saldo\n05/09/2026;A;-10,00;100,00\n06/09/2026;B;-10,00;110,00\n',
        'account',
      ),
      Result.fail('running_balance_mismatch'),
    )
    assert.deepStrictEqual(
      Result.getOrThrow(
        parseCsv(
          'Data;Descrição;Valor;Saldo\n05/09/2026;A;100,00;100,00\n05/09/2026;B;-10,00;90,00\n',
          'account',
        ),
      ).closingBalance,
      { asOf: '2026-09-05', cents: 9000 },
    )
  })
})

describe('splitCsv', () => {
  it('honours quotes, doubled quotes and embedded delimiters', () => {
    assert.deepStrictEqual(splitCsv('a,"b, c","say ""hi"""\r\n1,2,3', ','), [
      ['a', 'b, c', 'say "hi"'],
      ['1', '2', '3'],
    ])
  })

  it('reads a credit next to a zero debit and refuses two non-zero columns', () => {
    const statement = Result.getOrThrow(
      parseCsv(
        'Data;Descrição;Débito;Crédito\n05/09/2026;Salário;0,00;1.000,00\n06/09/2026;Ambíguo;10,00;20,00\n',
        'account',
      ),
    )
    assert.deepStrictEqual(
      [
        statement.lines.map((line) => [line.description, line.amountCents]),
        statement.rejectedRows,
      ],
      [[['Salário', 100000]], 1],
    )
  })

  it('reports the currency column and refuses mixed currencies', () => {
    const usd = Result.getOrThrow(
      parseCsv(
        'Data;Descrição;Valor;Moeda\n05/09/2026;Hotel;10,00;USD\n',
        'account',
      ),
    )
    assert.strictEqual(usd.currency, 'USD')
    assert.deepStrictEqual(
      parseCsv(
        'Data;Descrição;Valor;Moeda\n05/09/2026;A;1,00;USD\n06/09/2026;B;1,00;BRL\n',
        'account',
      ),
      Result.fail('mixed_currencies'),
    )
  })

  it('checks known balances across rows that have none', () => {
    const text =
      'Data;Descrição;Valor;Saldo\n05/09/2026;A;100,00;100,00\n06/09/2026;B;-10,00;95,00\n07/09/2026;C;-5,00;\n'
    assert.deepStrictEqual(
      parseCsv(text, 'account'),
      Result.fail('running_balance_mismatch'),
    )
  })

  it('uses the dates when a balance chain reads both ways', () => {
    const text =
      'Data;Descrição;Valor;Saldo\n30/09/2026;A;100,00;1.000,00\n01/09/2026;B;-100,00;900,00\n'
    assert.deepStrictEqual(
      Result.getOrThrow(parseCsv(text, 'account')).closingBalance,
      {
        asOf: '2026-09-30',
        cents: 100000,
      },
    )
  })

  it('reads card direction words and balances in the card statement convention', () => {
    const statement = Result.getOrThrow(
      parseCsv(
        'Data;Descrição;Valor;Tipo;Saldo\n10/09/2026;Mercado;100,00;Compra;100,00\n11/09/2026;Posto;10,00;Compra;110,00\n20/09/2026;Pagamento recebido;-500,00;Pagamento;-390,00\n',
        'card',
      ),
    )
    assert.deepStrictEqual(
      statement.lines.map((line) => line.amountCents),
      [-10000, -1000, 50000],
    )
  })

  it('refuses a file with an unclosed quote', () => {
    assert.deepStrictEqual(
      parseCsv(
        'Data;Descrição;Valor\n05/09/2026;"Sem fim;10,00\n06/09/2026;B;5,00\n',
        'account',
      ),
      Result.fail('malformed_csv'),
    )
  })

  it('dates the closing balance at the closing position, past rows without a balance', () => {
    const text = (summary: string) =>
      [
        'Período ;01/09/2026 a 30/09/2026',
        ...(summary ? [`Saldo ;${summary}`] : []),
        'Data;Descrição;Valor;Saldo',
        '05/09/2026;Salário;100,00;100,00',
        '30/09/2026;Padaria;-10,00;',
      ].join('\n')
    assert.deepStrictEqual(
      Result.getOrThrow(parseCsv(text(''), 'account')).closingBalance,
      { asOf: '2026-09-30', cents: 9000 },
    )
    assert.deepStrictEqual(
      Result.getOrThrow(parseCsv(text('90,00'), 'account')).closingBalance,
      { asOf: '2026-09-30', cents: 9000 },
    )
    assert.deepStrictEqual(
      parseCsv(text('100,00'), 'account'),
      Result.fail('summary_balance_mismatch'),
    )
    const newestFirst = Result.getOrThrow(
      parseCsv(
        'Data;Descrição;Valor;Saldo\n30/09/2026;Padaria;-10,00;\n05/09/2026;Salário;100,00;100,00\n',
        'account',
      ),
    )
    assert.deepStrictEqual(newestFirst.closingBalance, {
      asOf: '2026-09-30',
      cents: 9000,
    })
  })

  it('refuses bank balances that chain only with inverted signs', () => {
    assert.deepStrictEqual(
      parseCsv(
        'Data;Descrição;Valor;Saldo\n05/09/2026;A;-100,00;100,00\n06/09/2026;B;-10,00;110,00\n',
        'account',
      ),
      Result.fail('running_balance_mismatch'),
    )
  })
})
