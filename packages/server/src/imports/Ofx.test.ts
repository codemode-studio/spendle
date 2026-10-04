import { assert, describe, it } from '@effect/vitest'
import * as Result from 'effect/Result'

import { decodeOfx, parseOfx } from './Ofx.ts'

// Banks still ship OFX 1.x: SGML without closing tags, in Windows-1252.
const sgml = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
CHARSET:1252

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>BRL
<BANKACCTFROM><BANKID>0260<ACCTID>12345-6607</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260901000000[-3:BRT]<DTEND>20260930000000[-3:BRT]
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260905120000[-3:BRT]<TRNAMT>1000.00<FITID>a1<MEMO>Salário</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260910120000[-3:BRT]<TRNAMT>-100,00<FITID>a2<NAME>Padaria São João</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260910120000[-3:BRT]<TRNAMT>-100,00<FITID>a2<NAME>Padaria São João</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>bad<TRNAMT>-1<FITID>a3<MEMO>broken</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>800.00<DTASOF>20260930000000[-3:BRT]</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`

const windows1252 = (text: string) =>
  Uint8Array.from(
    [...text].map((char) =>
      char === 'á' ? 0xe1 : char === 'ã' ? 0xe3 : char.charCodeAt(0),
    ),
  )

describe('parseOfx', () => {
  it('reads an SGML bank statement in Windows-1252', () => {
    const statement = Result.getOrThrow(parseOfx(decodeOfx(windows1252(sgml))))
    assert.deepStrictEqual(
      {
        currency: statement.currency,
        accountHint: statement.accountHint,
        period: statement.period,
        closingBalance: statement.closingBalance,
        rejectedRows: statement.rejectedRows,
      },
      {
        currency: 'BRL',
        accountHint: '6607',
        period: { start: '2026-09-01', end: '2026-09-30' },
        closingBalance: { asOf: '2026-09-30', cents: 80000 },
        rejectedRows: 1,
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
        ['id:a1@1', '2026-09-05', 100000, 'Salário'],
        ['id:a2@1', '2026-09-10', -10000, 'Padaria São João'],
        ['id:a2@2', '2026-09-10', -10000, 'Padaria São João'],
      ],
    )
  })

  it('reads an XML card statement with signed amounts', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
      <CURDEF>BRL</CURDEF><CCACCTFROM><ACCTID>5555********1889</ACCTID></CCACCTFROM>
      <BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260912</DTPOSTED><TRNAMT>-89.90</TRNAMT>
      <FITID>c1</FITID><MEMO>Mercado</MEMO></STMTTRN></BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`
    const statement = Result.getOrThrow(parseOfx(xml))
    assert.deepStrictEqual(
      [
        statement.accountHint,
        statement.lines[0]?.amountCents,
        statement.lines[0]?.description,
      ],
      ['1889', -8990, 'Mercado'],
    )
  })

  it('refuses a file without a statement', () => {
    assert.deepStrictEqual(parseOfx('<OFX></OFX>'), Result.fail('no_statement'))
  })

  it('decodes UTF-8 XML whatever the declaration looks like', () => {
    const body = (declaration: string) =>
      new TextEncoder()
        .encode(`${declaration}<OFX><STMTRS><CURDEF>BRL<BANKTRANLIST>
        <STMTTRN><DTPOSTED>
        20260905</DTPOSTED><TRNAMT>1.2300</TRNAMT><FITID>a</FITID>
        <MEMO>Salário de Jo&#227;o &amp; Filhos</MEMO></STMTTRN></BANKTRANLIST></STMTRS></OFX>`)
    for (const declaration of [
      `<?xml version='1.0' encoding = 'UTF-8'?>`,
      '<?xml version="1.0"?>',
      '',
    ]) {
      const [line] = Result.getOrThrow(
        parseOfx(decodeOfx(body(declaration))),
      ).lines
      assert.deepStrictEqual(
        [line?.bookedOn, line?.amountCents, line?.description],
        ['2026-09-05', 123, 'Salário de João & Filhos'],
      )
    }
  })

  it('says whether it is a card statement and offers no card balance as a bill total', () => {
    const card = Result.getOrThrow(
      parseOfx(`<OFX><CCSTMTRS><CURDEF>BRL<BANKTRANLIST></BANKTRANLIST>
        <LEDGERBAL><BALAMT>-200.00<DTASOF>20260715</LEDGERBAL></CCSTMTRS></OFX>`),
    )
    assert.deepStrictEqual(
      [card.accountKind, card.closingBalance],
      ['card', null],
    )
  })
})
