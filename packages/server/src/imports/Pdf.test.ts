import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'

import { mercadoPagoStatement, syntheticPdf } from '../testing/SyntheticPdf.ts'
import { extractPdfText, parsePdf, pdfLayouts } from './Pdf.ts'
import type { PdfText } from './Pdf.ts'

const matching = (text: string) =>
  pdfLayouts.filter((layout) => layout.matches(text)).map((layout) => layout.id)

describe('PDF layout selection', () => {
  it('recognizes the issuer, not the counterparties named in rows', () => {
    assert.deepStrictEqual(
      [
        matching(`Nu Financeira S.A. nubank.com.br
          Saldo final do período Total de entradas Movimentações
          Pix enviado para MERCADO PAGO IP LTDA.`),
        matching(`EXTRATO DE CONTA
          DETALHE DOS MOVIMENTOS
          Data Descrição ID da operação Valor Saldo
          Mercado Pago Instituição de Pagamento Ltda. mercadopago.com.br
          Pix enviado para NU PAGAMENTOS S.A.`),
        matching(`Banco Inter S/A inter.co/atendimento
          Resumo da fatura Fatura atual Despesas da fatura
          CARTÃO 5364****3879`),
        matching(`Nu Pagamentos S.A.
          Resumo da fatura atual Período vigente
          Total de compras de todos os cartões Transações`),
      ],
      [
        ['nubank/account-statement/v1'],
        ['mercado-pago/account-statement/v1'],
        ['inter/card-statement/v1'],
        ['nubank/card-statement/v1'],
      ],
    )
  })

  const pdf = (text: string, pagesNeedingOcr: ReadonlyArray<number> = []) => ({
    text,
    items: text.split('\n').map((line, index) => ({
      text: line,
      page: 1,
      x: 36,
      y: 790 - index * 20,
      width: line.length * 5,
      height: 10,
      itemType: 'Text',
    })),
    pagesNeedingOcr,
  })

  it('refuses a PDF no single layout recognizes', () => {
    assert.deepStrictEqual(
      parsePdf(
        pdf('Pix enviado para MERCADO PAGO IP LTDA. no valor de R$ 10,00'),
        'account',
      ),
      Result.fail('unsupported_format'),
    )
  })

  it('refuses a statement with a date that does not exist', () => {
    assert.deepStrictEqual(
      parsePdf(
        pdf(`Nu Pagamentos S.A.
RESUMO DA FATURA ATUAL
Data de vencimento: 10 OUT 2026
Período vigente: 03 SET a 03 OUT
Total de compras de todos os cartões R$ 10,00
Total a pagar R$ 10,00
TRANSAÇÕES DE 03 SET A 03 OUT
31 SET Mercado R$ 10,00`),
        'card',
      ),
      Result.fail('invalid_date'),
    )
  })

  it('refuses a statement of the other kind of account', () => {
    assert.deepStrictEqual(
      parsePdf(pdf(mercadoPagoStatement.join('\n')), 'card'),
      Result.fail('account_mismatch'),
    )
  })

  it('refuses text it cannot fully see rather than reading part of it', () => {
    const text = mercadoPagoStatement.join('\n')
    const truncated = pdf(text)
    assert.deepStrictEqual(
      [
        parsePdf(pdf(text, [1]), 'account'),
        parsePdf(
          { ...truncated, items: truncated.items.slice(0, 3) },
          'account',
        ),
      ],
      [Result.fail('unsupported_format'), Result.fail('unsupported_format')],
    )
  })

  it.effect('reads a synthetic PDF through the native extractor', () =>
    Effect.gen(function* () {
      const text = yield* extractPdfText(syntheticPdf(mercadoPagoStatement))
      const statement = Result.getOrThrow(parsePdf(text, 'account'))
      assert.deepStrictEqual(
        {
          format: statement.format,
          currency: statement.currency,
          period: statement.period,
          closingBalance: statement.closingBalance,
          rejectedRows: statement.rejectedRows,
        },
        {
          format: 'pdf',
          currency: 'BRL',
          period: { start: '2026-08-01', end: '2026-08-02' },
          closingBalance: { asOf: '2026-08-02', cents: 90_000 },
          rejectedRows: 0,
        },
      )
      assert.deepStrictEqual(
        statement.lines.map((line) => [
          line.externalId,
          line.bookedOn,
          line.amountCents,
          line.description,
        ]),
        [
          ['id:90000001@1', '2026-08-01', 100_000, 'Receita sintetica'],
          ['id:90000002@1', '2026-08-02', -10_000, 'Mercado sintetico'],
        ],
      )
      const raw = statement.lines[1]?.raw as Record<string, unknown>
      assert.deepStrictEqual(
        [raw['layout'], raw['line'], raw['page'], raw['x'], raw['y']],
        [
          'mercado-pago/account-statement/v1',
          '02-08-2026 Mercado sintetico 90000002 R$ -100,00 R$ 900,00',
          1,
          36,
          590,
        ],
      )
    }),
  )

  it.effect('fails as unreadable on bytes that are not a PDF', () =>
    Effect.gen(function* () {
      const error = yield* extractPdfText(
        new TextEncoder().encode('%PDF-1.7 binary'),
      ).pipe(Effect.flip)
      assert.strictEqual(error._tag, 'PdfUnreadable')
    }),
  )
})

/** A PDF whose rows are table cells drawn apart, as bank statements are. */
const tablePdf = (
  rows: ReadonlyArray<ReadonlyArray<string>>,
  columnWidth = 140,
) =>
  syntheticPdf(
    rows.flatMap((row, index) =>
      row.map((text, column) => ({
        text,
        x: 36 + column * columnWidth,
        y: 790 - index * 20,
      })),
    ),
  )

/** The extracted text with the positioned cells of one row lost. */
const losingRow = (pdf: PdfText, cell: string) => {
  const y = pdf.items.find((item) => item.text === cell)?.y
  return { ...pdf, items: pdf.items.filter((item) => item.y !== y) }
}

/** The extracted text with one positioned cell lost, the rest of its row kept. */
const losingCell = (pdf: PdfText, cell: string) => ({
  ...pdf,
  items: pdf.items.filter((item) => item.text !== cell),
})

/** The extracted text with one cell lost from the row printing another. */
const losingCellIn = (pdf: PdfText, row: string, cell: string) => {
  const y = pdf.items.find((item) => item.text === row)?.y
  return {
    ...pdf,
    items: pdf.items.filter((item) => item.y !== y || item.text !== cell),
  }
}

const amounts = (result: ReturnType<typeof parsePdf>) =>
  Result.getOrThrow(result).lines.map((line) => line.amountCents)

const nubankBill = (rows: ReadonlyArray<ReadonlyArray<string>>) =>
  tablePdf([
    ['Nu Pagamentos S.A.'],
    ['RESUMO DA FATURA ATUAL'],
    ['Data de vencimento: 10 AGO 2026'],
    ['Período vigente: 02 JUL a 02 AGO'],
    ['Total de compras de todos os cartões R$ 350,00'],
    ['Total a pagar R$ 350,00'],
    ['TRANSAÇÕES DE 02 JUL A 02 AGO'],
    ...rows,
  ])

describe('PDF amounts the positioned text lost', () => {
  it.effect('refuses a Nubank bill missing a payment printed in cells', () =>
    Effect.gen(function* () {
      const pdf = yield* extractPdfText(
        nubankBill([
          ['02 JUL', 'Mercado', 'R$ 100,00'],
          ['11 JUL', 'Plano NuCel', 'R$ 250,00'],
          ['08 JUL', 'Pagamento em 08 JUL', '-R$ 500,00'],
        ]),
      )
      // The plain text has each cell on its own line, never a whole row.
      assert.include(pdf.text, '\nPagamento em 08 JUL\n-R$ 500,00\n')
      assert.deepStrictEqual(
        amounts(parsePdf(pdf, 'card')),
        [-10_000, -25_000, 50_000],
      )
      assert.deepStrictEqual(
        parsePdf(losingRow(pdf, 'Pagamento em 08 JUL'), 'card'),
        Result.fail('unsupported_format'),
      )
    }),
  )

  it.effect(
    'refuses a Nubank bill missing a payment that a purchase repeats',
    () =>
      Effect.gen(function* () {
        const pdf = yield* extractPdfText(
          nubankBill([
            ['08 JUL Mercado R$ 100,00'],
            ['08 JUL Plano NuCel R$ 250,00'],
            ['08 JUL Pagamento em 08 JUL -R$ 100,00'],
          ]),
        )
        assert.deepStrictEqual(
          amounts(parsePdf(pdf, 'card')),
          [-10_000, -25_000, 10_000],
        )
        assert.deepStrictEqual(
          parsePdf(
            losingRow(pdf, '08 JUL Pagamento em 08 JUL -R$ 100,00'),
            'card',
          ),
          Result.fail('unsupported_format'),
        )
      }),
  )

  it.effect('refuses an Inter bill missing a payment printed in cells', () =>
    Effect.gen(function* () {
      const pdf = yield* extractPdfText(
        tablePdf([
          ['Banco Inter S/A inter.co/atendimento'],
          ['Este é o valor que você precisa pagar nesse mês 15/09/2026'],
          ['Resumo da fatura'],
          ['Fatura atual R$ 0,00'],
          ['Valor antecipado R$ 160,00'],
          ['Despesas do mês R$ 150,00'],
          ['Despesas da fatura'],
          ['CARTÃO 5364****3879'],
          ['20 de ago. 2026', 'Compra A', '-', 'R$ 100,00'],
          ['21 de ago. 2026', 'Compra B', '-', 'R$ 50,00'],
          ['22 de ago. 2026', 'CRED PARC LOJ', '-', '+ R$ 20,00'],
          ['25 de ago. 2026', 'PAGAMENTO ON LINE', '-', '+ R$ 140,00'],
          ['Data de corte: 08/10/2026'],
        ]),
      )
      assert.deepStrictEqual(
        amounts(parsePdf(pdf, 'card')),
        [-10_000, -5_000, 2_000, 14_000],
      )
      assert.deepStrictEqual(
        parsePdf(losingRow(pdf, 'PAGAMENTO ON LINE'), 'card'),
        Result.fail('unsupported_format'),
      )
    }),
  )

  const interAccount = tablePdf([
    ['Instituição: Banco Inter'],
    ['Período: 01/06/2026 a 30/06/2026'],
    ['Saldo total Saldo disponível: Saldo bloqueado:'],
    ['R$ 130,00', 'R$ 130,00', 'R$ 0,00'],
    ['1 de Junho de 2026 Saldo do dia: R$ 150,00 Valor Saldo por transação'],
    ['Pix recebido: EMPRESA', 'R$ 50,00', 'R$ 150,00'],
    ['2 de Junho de 2026 Saldo do dia: R$ 130,00'],
    ['Pix enviado: LOJA', '-R$ 20,00', 'R$ 130,00'],
  ])

  it.effect('refuses an Inter statement missing its first movement', () =>
    Effect.gen(function* () {
      const pdf = yield* extractPdfText(interAccount)
      assert.deepStrictEqual(amounts(parsePdf(pdf, 'account')), [5_000, -2_000])
      assert.deepStrictEqual(
        parsePdf(losingRow(pdf, 'Pix recebido: EMPRESA'), 'account'),
        Result.fail('unsupported_format'),
      )
    }),
  )

  // Inter repeats a balance across columns: a first deposit from zero
  // prints R$ 130,00 as total, available, amount and balance of the day.
  it.effect(
    'refuses an Inter statement missing a first movement whose amount repeats',
    () =>
      Effect.gen(function* () {
        const pdf = yield* extractPdfText(
          tablePdf([
            ['Instituição: Banco Inter'],
            ['Período: 01/06/2026 a 30/06/2026'],
            ['Saldo total Saldo disponível: Saldo bloqueado:'],
            ['R$ 130,00', 'R$ 130,00', 'R$ 0,00'],
            [
              '1 de Junho de 2026 Saldo do dia: R$ 130,00 Valor Saldo por transação',
            ],
            ['Pix recebido: EMPRESA', 'R$ 130,00', 'R$ 130,00'],
            ['2 de Junho de 2026 Saldo do dia: R$ 130,00'],
            ['Pix recebido: AMIGO', 'R$ 20,00', 'R$ 150,00'],
            ['Pix enviado: LOJA', '-R$ 20,00', 'R$ 130,00'],
          ]),
        )
        assert.deepStrictEqual(
          amounts(parsePdf(pdf, 'account')),
          [13_000, 2_000, -2_000],
        )
        assert.deepStrictEqual(
          parsePdf(losingRow(pdf, 'Pix recebido: EMPRESA'), 'account'),
          Result.fail('unsupported_format'),
        )
      }),
  )
})

describe('PDF amounts printed apart from a currency sign', () => {
  // Cells drawn separately put the currency sign and the amount on their own
  // plain-text lines.
  it.effect(
    'refuses an Inter statement missing a first movement whose sign is its own cell',
    () =>
      Effect.gen(function* () {
        const pdf = yield* extractPdfText(
          tablePdf(
            [
              ['Instituição: Banco Inter'],
              ['Período: 01/06/2026 a 30/06/2026'],
              ['Saldo total Saldo disponível: Saldo bloqueado:'],
              ['R$', '130,00', 'R$', '130,00', 'R$', '0,00'],
              [
                '1 de Junho de 2026 Saldo do dia: R$ 130,00 Valor Saldo por transação',
              ],
              ['Pix: EMPRESA', 'R$', '130,00', 'R$', '130,00'],
              ['2 de Junho de 2026 Saldo do dia: R$ 130,00'],
              ['Pix: AMIGO', 'R$', '20,00', 'R$', '150,00'],
              ['Pix: LOJA', '-R$', '20,00', 'R$', '130,00'],
            ],
            110,
          ),
        )
        assert.include(pdf.text, '\nR$\n130,00\n')
        assert.deepStrictEqual(
          amounts(parsePdf(pdf, 'account')),
          [13_000, 2_000, -2_000],
        )
        assert.deepStrictEqual(
          parsePdf(losingRow(pdf, 'Pix: EMPRESA'), 'account'),
          Result.fail('unsupported_format'),
        )
      }),
  )

  it.effect('refuses a Nubank account statement missing a day', () =>
    Effect.gen(function* () {
      const pdf = yield* extractPdfText(
        tablePdf([
          ['Nu Financeira S.A. nubank.com.br'],
          ['01 DE AGOSTO DE 2026 a 31 DE AGOSTO DE 2026'],
          ['Saldo final do período R$ 1.000,00'],
          ['Movimentações'],
          ['01 AGO 2026', 'Total de entradas', '+ 1.500,00'],
          ['Crédito em conta', '1.500,00'],
          ['05 AGO 2026', 'Total de saídas', '- 500,00'],
          ['Pix enviado', '500,00'],
          ['O saldo líquido corresponde ao total de depósitos em conta.'],
        ]),
      )
      assert.deepStrictEqual(
        amounts(parsePdf(pdf, 'account')),
        [150_000, -50_000],
      )
      assert.deepStrictEqual(
        parsePdf(
          losingRow(losingRow(pdf, '05 AGO 2026'), 'Pix enviado'),
          'account',
        ),
        Result.fail('unsupported_format'),
      )
    }),
  )

  it.effect('refuses a BTG statement missing transfers that offset', () =>
    Effect.gen(function* () {
      const pdf = yield* extractPdfText(
        tablePdf([
          ['BTG PACTUAL'],
          ['Conta corrente - Movimentação'],
          ['01/08/26 Saldo Anterior', '1.000,00'],
          ['02/08/26 Pix enviado', '-100,00', '900,00'],
          ['02/08/26 Pix recebido', '100,00', '1.000,00'],
          ['31/08/26 Saldo Final', '1.000,00'],
        ]),
      )
      assert.deepStrictEqual(
        amounts(parsePdf(pdf, 'account')),
        [-10_000, 10_000],
      )
      assert.deepStrictEqual(
        parsePdf(
          losingRow(
            losingRow(pdf, '02/08/26 Pix enviado'),
            '02/08/26 Pix recebido',
          ),
          'account',
        ),
        Result.fail('unsupported_format'),
      )
    }),
  )

  it.effect(
    'refuses an Inter Global statement missing transfers that offset',
    () =>
      Effect.gen(function* () {
        const pdf = yield* extractPdfText(
          tablePdf([
            ['Account type: Digital Account'],
            ['INTER & CO PAYMENTS'],
            ['Saldo Inicial: $ 100,00'],
            ['Saldo Final: $ 100,00'],
            ['Período do extrato: 01/06/2026 a 30/06/2026'],
            ['1 de junho de 2026 Saldo do dia:$ 100,00'],
            ['Resgate enviado', '$ 50,00'],
            ['Transferência ACH recebida Cliente', '$ 50,00'],
          ]),
        )
        assert.deepStrictEqual(
          amounts(parsePdf(pdf, 'account')),
          [-5_000, 5_000],
        )
        assert.deepStrictEqual(
          parsePdf(
            losingRow(
              losingRow(pdf, 'Resgate enviado'),
              'Transferência ACH recebida Cliente',
            ),
            'account',
          ),
          Result.fail('unsupported_format'),
        )
      }),
  )
})

describe('Card bill payments whose row lost a cell', () => {
  const rowsOf = (result: ReturnType<typeof parsePdf>) => {
    const statement = Result.getOrThrow(result)
    return {
      amounts: statement.lines.map((line) => line.amountCents),
      rejectedRows: statement.rejectedRows,
    }
  }

  const nubankCells = () =>
    extractPdfText(
      nubankBill([
        ['02 JUL', 'Mercado', 'R$', '100,00'],
        ['11 JUL', 'Plano NuCel', 'R$', '250,00'],
        ['08 JUL', 'Pagamento em 08 JUL', '-R$', '500,00'],
      ]),
    )

  const interCells = () =>
    extractPdfText(
      tablePdf(
        [
          ['Banco Inter S/A inter.co/atendimento'],
          ['Este é o valor que você precisa pagar nesse mês 15/09/2026'],
          ['Resumo da fatura'],
          ['Fatura atual R$ 0,00'],
          ['Valor antecipado R$ 160,00'],
          ['Despesas do mês R$ 150,00'],
          ['Despesas da fatura'],
          ['CARTÃO 5364****3879'],
          ['20 de ago. 2026', 'Compra A', '-', 'R$', '100,00'],
          ['21 de ago. 2026', 'Compra B', '-', 'R$', '50,00'],
          ['22 de ago. 2026', 'CRED PARC LOJ', '-', '+ R$', '20,00'],
          ['25 de ago. 2026', 'PAGAMENTO ON LINE', '-', '+ R$', '140,00'],
          ['Data de corte: 08/10/2026'],
        ],
        110,
      ),
    )

  it.effect('reads intact bills without rejected rows', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        [
          rowsOf(parsePdf(yield* nubankCells(), 'card')),
          rowsOf(parsePdf(yield* interCells(), 'card')),
        ],
        [
          { amounts: [-10_000, -25_000, 50_000], rejectedRows: 0 },
          { amounts: [-10_000, -5_000, 2_000, 14_000], rejectedRows: 0 },
        ],
      )
    }),
  )

  // Any line on a transaction page that prints an amount is a row unless the
  // layout knows it as a summary, whatever cell it lost.
  it.effect('counts a payment that lost its currency sign as rejected', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        [
          rowsOf(
            parsePdf(
              losingCellIn(yield* nubankCells(), 'Pagamento em 08 JUL', '-R$'),
              'card',
            ),
          ),
          rowsOf(
            parsePdf(
              losingCellIn(yield* interCells(), '25 de ago. 2026', '+ R$'),
              'card',
            ),
          ),
        ],
        [
          { amounts: [-10_000, -25_000], rejectedRows: 1 },
          { amounts: [-10_000, -5_000, 2_000], rejectedRows: 1 },
        ],
      )
    }),
  )

  // A row's date is not checked by any total, so a lost date cell is found
  // by comparing the extractions, like a lost amount.
  it.effect('refuses a bill whose payment lost its date', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        [
          parsePdf(losingCell(yield* nubankCells(), '08 JUL'), 'card'),
          parsePdf(losingCell(yield* interCells(), '25 de ago. 2026'), 'card'),
        ],
        [Result.fail('unsupported_format'), Result.fail('unsupported_format')],
      )
    }),
  )
})

describe('Account statements whose day lost its date', () => {
  // Movements under a day header take its date; without it they would be
  // booked on the previous day, which no balance can show.
  it.effect('refuses an Inter statement missing a day header date', () =>
    Effect.gen(function* () {
      const pdf = yield* extractPdfText(
        tablePdf([
          ['Instituição: Banco Inter'],
          ['Período: 01/06/2026 a 30/06/2026'],
          ['Saldo total Saldo disponível: Saldo bloqueado:'],
          ['R$ 130,00', 'R$ 130,00', 'R$ 0,00'],
          [
            '1 de Junho de 2026',
            'Saldo do dia: R$ 150,00 Valor Saldo por transação',
          ],
          ['Pix recebido: EMPRESA', 'R$ 50,00', 'R$ 150,00'],
          ['2 de Junho de 2026', 'Saldo do dia: R$ 130,00'],
          ['Pix enviado: LOJA', '-R$ 20,00', 'R$ 130,00'],
        ]),
      )
      assert.deepStrictEqual(
        Result.getOrThrow(parsePdf(pdf, 'account')).lines.map((line) => [
          line.bookedOn,
          line.amountCents,
        ]),
        [
          ['2026-06-01', 5_000],
          ['2026-06-02', -2_000],
        ],
      )
      assert.deepStrictEqual(
        parsePdf(losingCell(pdf, '2 de Junho de 2026'), 'account'),
        Result.fail('unsupported_format'),
      )
    }),
  )

  it.effect('refuses a Nubank statement missing a day date', () =>
    Effect.gen(function* () {
      const pdf = yield* extractPdfText(
        tablePdf([
          ['Nu Financeira S.A. nubank.com.br'],
          ['01 DE AGOSTO DE 2026 a 31 DE AGOSTO DE 2026'],
          ['Saldo final do período R$ 1.000,00'],
          ['Movimentações'],
          ['01 AGO 2026', 'Total de entradas', '+ 1.500,00'],
          ['Crédito em conta', '1.500,00'],
          ['05 AGO 2026', 'Total de saídas', '- 500,00'],
          ['Pix enviado', '500,00'],
          ['O saldo líquido corresponde ao total de depósitos em conta.'],
        ]),
      )
      assert.deepStrictEqual(
        Result.getOrThrow(parsePdf(pdf, 'account')).lines.map((line) => [
          line.bookedOn,
          line.amountCents,
        ]),
        [
          ['2026-08-01', 150_000],
          ['2026-08-05', -50_000],
        ],
      )
      assert.deepStrictEqual(
        parsePdf(losingCell(pdf, '05 AGO 2026'), 'account'),
        Result.fail('unsupported_format'),
      )
    }),
  )
})
