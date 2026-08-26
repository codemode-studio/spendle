import { describe, expect, it } from 'vitest'

import {
  assignStatementValueMatches,
  sameStatementValues,
} from '#/domain/canonicalization'
import {
  isStaleIdenticalFileConflict,
  resolveIdenticalFileUsage,
  shouldReviewStagedBatch,
} from './import.server'
import {
  matchesDocumentLastFour,
  parseOfxBuffer,
  parseOfxStatement,
} from './statement-reader.server'

describe('parser OFX', () => {
  it('normaliza OFX SGML com FITID, data e centavos', () => {
    const source = `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\nENCODING:USASCII\nCHARSET:1252\nCOMPRESSION:NONE\nOLDFILEUID:NONE\nNEWFILEUID:NONE\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL<BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260801120000[-3:BRT]<TRNAMT>-123.45<FITID>abc-123<NAME>Mercado Teste</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`
    expect(parseOfxBuffer(Buffer.from(source))).toEqual([
      expect.objectContaining({
        externalId: 'abc-123',
        postedAt: '2026-08-01',
        description: 'Mercado Teste',
        amountCents: -12_345,
        currency: 'BRL',
      }),
    ])
  })

  it('retorna lista vazia para OFX válido sem lançamentos', () => {
    const source =
      '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL<BANKTRANLIST></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>'
    expect(parseOfxBuffer(Buffer.from(source))).toEqual([])
  })

  it('preserva saldo final e data de referência do extrato', () => {
    const source = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL<BANKTRANLIST></BANKTRANLIST><LEDGERBAL><BALAMT>3246.47<DTASOF>20260803120000[-3:BRT]</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`
    expect(parseOfxStatement(Buffer.from(source))).toMatchObject({
      closingBalanceCents: 324_647,
      balanceAsOf: '2026-08-03',
    })
  })

  it('separa o período declarado da atividade e rebaixa anomalias', () => {
    const source = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL<BANKTRANLIST><DTSTART>20260501<DTEND>20260531<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260601120000[-3:BRT]<TRNAMT>10.00<FITID>x1<NAME>Fora do período</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`
    expect(parseOfxStatement(Buffer.from(source))).toMatchObject({
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
      activityStart: '2026-06-01',
      activityEnd: '2026-06-01',
      periodSource: 'activity',
      coverageConfidence: 'low',
    })
  })

  it('não aceita data de controle impossível no OFX', () => {
    const source = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST><DTSTART>20260201<DTEND>20260230</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`
    expect(parseOfxStatement(Buffer.from(source))).toMatchObject({
      periodStart: '2026-02-01',
      periodEnd: null,
      periodSource: 'activity',
      coverageConfidence: 'low',
    })
  })
})

describe('controle complementar CSV/PDF', () => {
  it('compara somente os quatro últimos dígitos da conta', () => {
    expect(matchesDocumentLastFour('2673', ['379372673'])).toBe(true)
    expect(matchesDocumentLastFour('2673', ['account-2673'])).toBe(true)
    expect(matchesDocumentLastFour('2673', ['379370532'])).toBe(false)
  })

  it('confere data, valor, moeda e multiplicidade sem depender da descrição', () => {
    const csv = [
      { postedAt: '2026-08-01', amountCents: -1_000, currency: 'BRL' },
      { postedAt: '2026-08-01', amountCents: -1_000, currency: 'BRL' },
      { postedAt: '2026-08-02', amountCents: 5_000, currency: 'BRL' },
    ]
    const pdf = [csv[2], csv[0], csv[1]]

    expect(sameStatementValues(csv, pdf)).toBe(true)
    expect(sameStatementValues(csv, pdf.slice(1))).toBe(false)
    expect(
      sameStatementValues(csv, [
        pdf[0],
        pdf[1],
        { ...pdf[2], amountCents: -999 },
      ]),
    ).toBe(false)
  })

  it('liga o PDF definitivo ao CSV aberto anterior mesmo com descrição diferente', () => {
    const pendingCsv = [
      {
        id: 'canonical-csv',
        postedAt: '2026-08-03',
        amountCents: -12_345,
        currency: 'BRL',
        description: 'COMPRA CARTAO 03/08',
        status: 'pending',
      },
    ]
    const definitivePdf = [
      {
        id: 'pdf-observation',
        postedAt: '2026-08-03',
        amountCents: -12_345,
        currency: 'BRL',
        description: 'Mercado Exemplo',
      },
    ]

    const assignments = assignStatementValueMatches(definitivePdf, pendingCsv)

    expect(assignments).toEqual([
      {
        observation: definitivePdf[0],
        transaction: pendingCsv[0],
      },
    ])
  })

  it('não confunde IDs bancários diferentes com a mesma data e valor', () => {
    const canonical = [
      {
        externalId: 'E1',
        postedAt: '2026-08-03',
        amountCents: -12_345,
        currency: 'BRL',
      },
    ]
    expect(
      assignStatementValueMatches(
        [
          {
            externalId: 'E2',
            postedAt: '2026-08-03',
            amountCents: -12_345,
            currency: 'BRL',
          },
        ],
        canonical,
      ),
    ).toBeNull()
    expect(
      assignStatementValueMatches(
        [
          {
            postedAt: '2026-08-03',
            amountCents: -12_345,
            currency: 'BRL',
          },
        ],
        canonical,
      ),
    ).not.toBeNull()
  })
})

describe('reuso do arquivo original', () => {
  it('não abre uma revisão vazia ao reenviar somente arquivos consolidados', () => {
    expect(
      shouldReviewStagedBatch(
        [{ reused: true }, { reused: true }],
        ['committed', 'evidence'],
      ),
    ).toBe(false)
    expect(shouldReviewStagedBatch([{ reused: false }], ['committed'])).toBe(
      false,
    )
    expect(shouldReviewStagedBatch([{ reused: false }], ['evidence'])).toBe(
      false,
    )
    expect(shouldReviewStagedBatch([{ reused: true }], ['review'])).toBe(true)
    expect(shouldReviewStagedBatch([{ reused: false }], ['review'])).toBe(true)
  })

  it('ignora tentativas falhas ou rejeitadas no mesmo destino', () => {
    const usage = resolveIdenticalFileUsage(
      [
        {
          id: 'failed-1',
          status: 'failed',
          accountId: 'inter-pj',
          creditCardId: null,
        },
        {
          id: 'failed-2',
          status: 'failed',
          accountId: 'inter-pj',
          creditCardId: null,
        },
        {
          id: 'rejected-1',
          status: 'rejected',
          accountId: 'inter-pj',
          creditCardId: null,
        },
      ],
      'account',
      'inter-pj',
    )

    expect(usage).toEqual({
      reusableImportId: null,
      usedByAnotherDestination: false,
    })
  })

  it('reusa uma revisão ativa no mesmo destino', () => {
    expect(
      resolveIdenticalFileUsage(
        [
          {
            id: 'review-1',
            status: 'review',
            accountId: 'inter-pj',
            creditCardId: null,
          },
        ],
        'account',
        'inter-pj',
      ),
    ).toEqual({
      reusableImportId: 'review-1',
      usedByAnotherDestination: false,
    })
  })

  it('bloqueia um arquivo consolidado em outro destino', () => {
    expect(
      resolveIdenticalFileUsage(
        [
          {
            id: 'committed-1',
            status: 'committed',
            accountId: 'other-account',
            creditCardId: null,
          },
        ],
        'account',
        'inter-pj',
      ),
    ).toEqual({
      reusableImportId: null,
      usedByAnotherDestination: true,
    })
  })

  it('identifica a revisão presa pelo falso conflito antigo', () => {
    expect(
      isStaleIdenticalFileConflict(
        {
          status: 'review',
          validationStatus: 'divergent',
          validationMessage:
            'O mesmo arquivo já foi associado a outro destino. O lote foi bloqueado.',
        },
        false,
      ),
    ).toBe(true)
  })
})
