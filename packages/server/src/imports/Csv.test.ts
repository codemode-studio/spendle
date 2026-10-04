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
})

describe('splitCsv', () => {
  it('honours quotes, doubled quotes and embedded delimiters', () => {
    assert.deepStrictEqual(splitCsv('a,"b, c","say ""hi"""\r\n1,2,3', ','), [
      ['a', 'b, c', 'say "hi"'],
      ['1', '2', '3'],
    ])
  })
})
