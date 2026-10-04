import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'

import { mercadoPagoStatement, syntheticPdf } from '../testing/SyntheticPdf.ts'
import { extractPdfText, parsePdf, pdfLayouts } from './Pdf.ts'

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
