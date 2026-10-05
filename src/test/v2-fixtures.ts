import { v2 } from '#/lib/v2/client.server'

/** An OFX statement for one account; amounts in reais, dates `YYYYMMDD`. */
export function ofxStatement(input: {
  start: string
  end: string
  closing: string
  lines: ReadonlyArray<{
    id: string
    date: string
    amount: string
    memo: string
  }>
}) {
  return `OFXHEADER:100
CHARSET:UTF-8

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL
<BANKTRANLIST><DTSTART>${input.start}<DTEND>${input.end}
${input.lines
  .map(
    (line) =>
      `<STMTTRN><TRNTYPE>${line.amount.startsWith('-') ? 'DEBIT' : 'CREDIT'}<DTPOSTED>${line.date}<TRNAMT>${line.amount}<FITID>${line.id}<MEMO>${line.memo}</STMTTRN>`,
  )
  .join('\n')}
</BANKTRANLIST><LEDGERBAL><BALAMT>${input.closing}<DTASOF>${input.end}</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`
}

export function statementUpload(
  accountId: string,
  content: string,
  name: string,
) {
  const data = new FormData()
  data.append('accountId', accountId)
  data.append('file', new Blob([content]), name)
  return data
}

/** A household with one checking account, through the V2 API. */
export async function openChecking(name = 'Conta', currency = 'BRL') {
  const owner = await v2((client) =>
    client.owners.create({ payload: { name: 'Família', kind: 'household' } }),
  )
  return v2((client) =>
    client.accounts.open({
      payload: {
        ownerId: owner.id,
        institutionName: 'Banco',
        name,
        kind: 'checking',
        purpose: 'operating',
        currency,
      },
    }),
  )
}
