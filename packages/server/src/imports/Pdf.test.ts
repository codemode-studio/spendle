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
const tablePdf = (rows: ReadonlyArray<ReadonlyArray<string>>) =>
  syntheticPdf(
    rows.flatMap((row, index) =>
      row.map((text, column) => ({
        text,
        x: 36 + column * 140,
        y: 790 - index * 20,
      })),
    ),
  )

/** The extracted text with the positioned cells of one row lost. */
const losingRow = (pdf: PdfText, cell: string) => {
  const y = pdf.items.find((item) => item.text === cell)?.y
  return { ...pdf, items: pdf.items.filter((item) => item.y !== y) }
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

  it.effect('counts a plain line drawn twice in place once', () =>
    Effect.gen(function* () {
      const pdf = yield* extractPdfText(interAccount)
      const repeated = pdf.text
        .split('\n')
        .flatMap((line) =>
          /^-?R\$ [25]0,00$/.test(line) ? [line, line] : [line],
        )
        .join('\n')
      assert.notStrictEqual(repeated, pdf.text)
      assert.deepStrictEqual(
        amounts(parsePdf({ ...pdf, text: repeated }, 'account')),
        [5_000, -2_000],
      )
    }),
  )
})
