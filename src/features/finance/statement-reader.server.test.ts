import { describe, expect, it } from 'vitest'

import {
  parseOfxAmount,
  pdfTransactionExtractionPrompt,
  readStatement,
} from './statement-reader.server'

const baseInput = {
  targetType: 'account' as const,
  targetCurrency: 'BRL',
  targetInstitution: null,
  targetIdentifiers: [],
  aiConsent: false,
  learnedCoverageTemplates: [],
}

describe('leitura normalizada de extratos', () => {
  it('instrui a IA a separar valor da transação e saldo acumulado', () => {
    expect(pdfTransactionExtractionPrompt).toContain(
      'Nunca use a coluna "Saldo"',
    )
    expect(pdfTransactionExtractionPrompt).toContain('preserve-o em externalId')
    expect(pdfTransactionExtractionPrompt).toContain(
      'Preserve a descrição original',
    )
  })

  it('normaliza o adapter OFX sem expor o formato ao staging', async () => {
    const buffer = Buffer.from(
      'OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\nENCODING:USASCII\nCHARSET:1252\nCOMPRESSION:NONE\nOLDFILEUID:NONE\nNEWFILEUID:NONE\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL<BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260803120000[-3:BRT]<TRNAMT>-10.00<FITID>ofx-1<NAME>Compra</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    )

    const result = await readStatement({
      ...baseInput,
      buffer,
      filename: 'extrato.ofx',
    })

    expect(result).toMatchObject({
      parser: 'ofx',
      documentKind: 'bank_statement',
      sourceTransactionCount: 1,
      controls: {
        closingBalanceCents: null,
        balanceAsOf: null,
      },
      coverage: {
        activityStart: '2026-08-03',
        activityEnd: '2026-08-03',
        periodSource: 'activity',
        confidence: 'low',
      },
    })
    expect(result.transactions).toEqual([
      expect.objectContaining({ externalId: 'ofx-1', amountCents: -1_000 }),
    ])
  })

  it('normaliza o adapter CSV para a mesma interface', async () => {
    const buffer = Buffer.from(
      'Data,Valor,Identificador,Descrição\n2026-08-03,-10.00,csv-1,Compra',
    )

    const result = await readStatement({
      ...baseInput,
      buffer,
      filename: 'extrato-2026-08.csv',
    })

    expect(result).toMatchObject({
      parser: 'csv',
      documentKind: 'bank_statement',
      controls: { closingBalanceCents: null },
      coverage: {
        activityStart: '2026-08-03',
        activityEnd: '2026-08-03',
      },
    })
    expect(result.transactions).toEqual([
      expect.objectContaining({ externalId: 'csv-1', amountCents: -1_000 }),
    ])
  })

  it('interpreta saldo OFX com separadores brasileiros', () => {
    expect(parseOfxAmount('1.234,56')).toBe(123_456)
    expect(parseOfxAmount('-1.234,56')).toBe(-123_456)
    expect(parseOfxAmount('1234.56')).toBe(123_456)
  })

  it('preserva um satoshi em OFX declarado como BTC', async () => {
    const buffer = Buffer.from(
      'OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\nENCODING:USASCII\nCHARSET:1252\nCOMPRESSION:NONE\nOLDFILEUID:NONE\nNEWFILEUID:NONE\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BTC<BANKTRANLIST><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260825120000[-3:BRT]<TRNAMT>0.00000001<FITID>btc-1<NAME>Aporte</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    )

    const result = await readStatement({
      ...baseInput,
      targetCurrency: 'BTC',
      buffer,
      filename: 'bitcoin.ofx',
    })

    expect(result.identity.currency).toBe('BTC')
    expect(result.transactions[0]).toMatchObject({
      amountCents: 1,
      currency: 'BTC',
    })
  })
})
