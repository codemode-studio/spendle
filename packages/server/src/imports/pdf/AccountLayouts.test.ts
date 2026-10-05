import { assert, describe, it } from '@effect/vitest'
import * as Result from 'effect/Result'

import { positionedText, textLayout } from '../../testing/SyntheticPdf.ts'
import { btgAccount } from './BtgAccount.ts'
import { interAccount } from './InterAccount.ts'
import { interGlobal } from './InterGlobal.ts'
import { groupLines } from './Layout.ts'
import type { LayoutLine } from './Layout.ts'
import { readMercadoPagoRows } from './MercadoPagoAccount.ts'
import { nubankAccount, readNubankAccountRows } from './NubankAccount.ts'

const amounts = (lines: ReadonlyArray<LayoutLine>) =>
  lines.map((line) => line.amountCents)

describe('Mercado Pago account statement', () => {
  it('keeps the sign and the source line of each row', () => {
    const { rows } = readMercadoPagoRows(
      groupLines([
        positionedText(
          '01-06-2026 Pix recebido 1744539409425 R$ 1.234,56 R$ 2.000,00',
          2,
          10,
          40,
        ),
        positionedText(
          '02-06-2026 Compra mercado 161200559281 R$ -50,00 R$ 1.950,00',
          2,
          10,
          20,
        ),
      ]),
    )
    assert.deepStrictEqual(
      rows.map((row) => [
        row.bookedOn,
        row.amountCents,
        row.source.bounds.page,
      ]),
      [
        ['2026-06-01', 123_456, 2],
        ['2026-06-02', -5_000, 2],
      ],
    )
  })

  it('reads Valor, not Saldo', () => {
    const { rows } = readMercadoPagoRows(
      groupLines([
        positionedText('01-06-2026', 1, 40, 130),
        positionedText('Rendimentos', 1, 120, 130),
        positionedText('1744539409425', 1, 260, 130),
        positionedText('R$ 0,29', 1, 400, 130),
        positionedText('R$ 618,44', 1, 500, 130),
        positionedText('01-06-2026', 1, 40, 100),
        positionedText('Pix enviado WHOOSH BR', 1, 120, 100),
        positionedText('161200559281', 1, 260, 100),
        positionedText('R$ -20,00', 1, 400, 100),
        positionedText('R$ 598,44', 1, 500, 100),
      ]),
    )
    assert.deepStrictEqual(
      rows.map((row) => [row.description, row.externalId, row.amountCents]),
      [
        ['Rendimentos', '1744539409425', 29],
        ['Pix enviado WHOOSH BR', '161200559281', -2_000],
      ],
    )
  })

  it('joins descriptions wrapped over several lines', () => {
    const { rows } = readMercadoPagoRows(
      groupLines([
        positionedText('03-06-2026', 1, 40, 200),
        positionedText('161510117955', 1, 260, 200),
        positionedText('R$ 2.900,00', 1, 400, 200),
        positionedText('R$ 3.315,90', 1, 500, 200),
        positionedText('Pix recebido FULANO', 1, 120, 208),
        positionedText('DE TAL SILVA', 1, 120, 192),
      ]),
    )
    assert.deepStrictEqual(
      rows.map((row) => [row.description, row.externalId, row.amountCents]),
      [['Pix recebido FULANO DE TAL SILVA', '161510117955', 290_000]],
    )
  })
})

describe('Nubank account statement', () => {
  it('reads movements grouped by day under inflow and outflow totals', () => {
    const rows = readNubankAccountRows(
      groupLines([
        positionedText('Movimentações', 1, 57, 560),
        positionedText('01 AGO 2026 Total de entradas + 1.586,49', 1, 57, 538),
        positionedText('Crédito em conta 1.586,49', 1, 120, 517),
        positionedText('Total de saídas - 1.600,00', 1, 120, 483),
        positionedText('Transferência enviada pelo Pix 1.600,00', 1, 120, 462),
        positionedText('07 AGO 2026 Total de entradas + 25.000,00', 1, 57, 377),
        positionedText(
          'Transferência recebida pelo Pix EMPRESA 00.000.000/0001- 25.000,00',
          1,
          120,
          356,
        ),
        positionedText('Total de saídas - 24.987,79', 1, 120, 282),
        positionedText('Pagamento de fatura 23.254,90', 1, 120, 261),
        positionedText('Transferência enviada pelo Pix 1.732,89', 1, 120, 240),
        positionedText('17 AGO 2026 Total de saídas - 73,93', 1, 57, 155),
        positionedText('Débito em conta 73,93', 2, 120, 673),
        positionedText(
          'O saldo líquido corresponde ao total de depósitos e rendimentos em conta.',
          2,
          57,
          621,
        ),
      ]),
    )
    assert.deepStrictEqual(
      Result.getOrThrow(rows).map((row) => [row.bookedOn, row.amountCents]),
      [
        ['2026-08-01', 158_649],
        ['2026-08-01', -160_000],
        ['2026-08-07', 2_500_000],
        ['2026-08-07', -2_325_490],
        ['2026-08-07', -173_289],
        ['2026-08-17', -7_393],
      ],
    )
  })

  it('refuses a statement whose day group does not close', () => {
    const rows = readNubankAccountRows(
      groupLines([
        positionedText('Movimentações', 1, 57, 560),
        positionedText('01 AGO 2026 Total de entradas + 100,00', 1, 57, 538),
        positionedText('Crédito em conta 90,00', 1, 120, 517),
        positionedText(
          'O saldo líquido corresponde ao total de depósitos e rendimentos em conta.',
          1,
          57,
          490,
        ),
      ]),
    )
    assert.deepStrictEqual(rows, Result.fail('summary_balance_mismatch'))
  })

  it('names the issuer and the account, not the counterparties', () => {
    const input =
      textLayout(`Nu Financeira S.A. - Sociedade de Crédito, Financiamento e Investimento
Nu Pagamentos S.A. - Instituição de Pagamento
disponíveis em nubank.com.br/contatos
01 DE AGOSTO DE 2026 a 31 DE AGOSTO DE 2026
CPF Agência Conta 5468660-7
Saldo inicial 101,30
Saldo final do período R$ 26,07
Total de entradas
Movimentações
Transferência enviada pelo Pix
MERCADO PAGO IP LTDA. Agência: 1`)
    assert.isTrue(nubankAccount.matches(input.text))
    const statement = Result.getOrThrow(nubankAccount.parse(input))
    assert.deepStrictEqual(
      [statement.accountHint, statement.period, statement.closingBalance],
      [
        '6607',
        { start: '2026-08-01', end: '2026-08-31' },
        { asOf: '2026-08-31', cents: 2_607 },
      ],
    )
  })
})

const interText = (lastBalance = '130,00') => `Instituição: Banco Inter
Período: 01/06/2026 a 30/06/2026
Saldo total Saldo disponível: Saldo bloqueado:
R$ 130,00 R$ 130,00 R$ 0,00
1 de Junho de 2026 Saldo do dia: R$ 150,00 Valor Saldo por transação
Pix recebido: EMPRESA R$ 50,00 R$ 150,00
2 de Junho de 2026 Saldo do dia: R$ 130,00
Pix enviado: LOJA -R$ 20,00 R$ ${lastBalance}`

describe('Inter account statement', () => {
  it('keeps signs and closes on the total balance', () => {
    const statement = Result.getOrThrow(
      interAccount.parse(textLayout(interText())),
    )
    assert.deepStrictEqual(
      [amounts(statement.lines), statement.period, statement.closingBalance],
      [
        [5_000, -2_000],
        { start: '2026-06-01', end: '2026-06-30' },
        { asOf: '2026-06-30', cents: 13_000 },
      ],
    )
  })

  it('refuses a missing movement revealed by the running balance', () => {
    assert.deepStrictEqual(
      interAccount.parse(textLayout(interText('131,00'))),
      Result.fail('running_balance_mismatch'),
    )
  })

  it('refuses a total balance that the last movement does not reach', () => {
    const input = textLayout(interText())
    assert.deepStrictEqual(
      interAccount.parse({
        ...input,
        lines: input.lines.filter(
          (line) => !line.text.startsWith('Pix enviado'),
        ),
      }),
      Result.fail('summary_balance_mismatch'),
    )
  })
})

const globalText = `Account type: Digital Account
INTER & CO PAYMENTS
Saldo Inicial: $ 0,00
Saldo Final: $ 0,00
Período do extrato: 01/06/2026 a 30/06/2026
2 de junho de 2026 Saldo do dia:$ 0,00
Resgate enviado $ 100,00
1 de junho de 2026 Saldo do dia:$ 100,00
Transferência ACH recebida Cliente $ 100,00`

describe('Inter Global Account statement', () => {
  it('reconciles days printed newest first without counting balances as income', () => {
    const statement = Result.getOrThrow(
      interGlobal.parse(textLayout(globalText)),
    )
    assert.deepStrictEqual(amounts(statement.lines), [-10_000, 10_000])
    assert.strictEqual(interGlobal.currency, 'USD')
    assert.deepStrictEqual(
      interGlobal.parse(
        textLayout(
          globalText.replace(
            'Resgate enviado $ 100,00',
            'Resgate enviado $ 99,00',
          ),
        ),
      ),
      Result.fail('running_balance_mismatch'),
    )
  })
})

const btgText = `BTG PACTUAL
Conta corrente - Posição
31/08/26 36.600,00
Conta corrente - Movimentação
01/08/26 Saldo Anterior 35.000,00
01/08/26 TRANSFERÊNCIA A CRÉDITO VIA PIX 1.600,00 36.600,00
31/08/26 Saldo Final + Rendimento Provisionado de Saldo Remunerado - 36.600,00`

describe('BTG account statement', () => {
  it('reads the movements section and treats position and balances as controls', () => {
    const statement = Result.getOrThrow(btgAccount.parse(textLayout(btgText)))
    assert.deepStrictEqual(
      [amounts(statement.lines), statement.period, statement.closingBalance],
      [
        [160_000],
        { start: '2026-08-01', end: '2026-08-31' },
        { asOf: '2026-08-31', cents: 3_660_000 },
      ],
    )
    assert.deepStrictEqual(
      btgAccount.parse(
        textLayout(btgText.replace('PIX 1.600,00', 'PIX 1.500,00')),
      ),
      Result.fail('running_balance_mismatch'),
    )
  })
})
