import * as Result from 'effect/Result'

import { fingerprintIds, parseDate, parseMoney } from './Statement.ts'
import type {
  ParsedStatement,
  StatementLine,
  StatementProblem,
} from './Statement.ts'

/** OFX 1.x is SGML with Windows-1252 text unless the header says otherwise. */
export const decodeOfx = (bytes: Uint8Array) => {
  const head = new TextDecoder('ascii').decode(bytes.slice(0, 512))
  const utf8 =
    /CHARSET:\s*(UTF-?8|NONE)|encoding="utf-8"/i.test(head) &&
    !/CHARSET:\s*1252/i.test(head)
  return new TextDecoder(utf8 ? 'utf-8' : 'windows-1252').decode(bytes)
}

export const looksLikeOfx = (text: string) =>
  /OFXHEADER|<OFX>/i.test(text.slice(0, 2048))

// Reads `<TAG>value` in both SGML (unclosed) and XML (closed) OFX.
const tag = (block: string, name: string) =>
  block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, 'i'))?.[1]?.trim() || null

const blocks = (text: string, name: string) =>
  [
    ...text.matchAll(
      new RegExp(`<${name}>([\\s\\S]*?)(?=<\\/${name}>|<${name}>|$)`, 'gi'),
    ),
  ].map((match) => match[1] ?? '')

/**
 * Parses a bank (`STMTRS`) or card (`CCSTMTRS`) statement. OFX amounts are
 * already signed from the account holder's view, for cards too. A FITID the
 * bank repeats within the file still yields distinct lines.
 */
export const parseOfx = (
  text: string,
): Result.Result<ParsedStatement, StatementProblem> => {
  const statements = [...blocks(text, 'STMTRS'), ...blocks(text, 'CCSTMTRS')]
  if (statements.length === 0) return Result.fail('no_statement')
  if (statements.length > 1) return Result.fail('multiple_statements')
  const statement = statements[0]!

  let rejectedRows = 0
  const lines: Array<
    Omit<StatementLine, 'externalId'> & { externalId?: string }
  > = []
  for (const transaction of blocks(statement, 'STMTTRN')) {
    const bookedOn = parseDate(tag(transaction, 'DTPOSTED') ?? '')
    const amountCents = parseMoney(tag(transaction, 'TRNAMT') ?? '')
    const memo = tag(transaction, 'MEMO')
    const name = tag(transaction, 'NAME')
    const description = memo || name || ''
    if (bookedOn === null || amountCents === null || !description) {
      rejectedRows++
      continue
    }
    const fitid = tag(transaction, 'FITID')
    lines.push({
      ...(fitid ? { externalId: fitid } : {}),
      bookedOn,
      amountCents,
      description,
      raw: {
        fitid,
        type: tag(transaction, 'TRNTYPE'),
        name,
        memo,
        checkNumber: tag(transaction, 'CHECKNUM'),
      },
    })
  }

  const start = parseDate(tag(statement, 'DTSTART') ?? '')
  const end = parseDate(tag(statement, 'DTEND') ?? '')
  const ledger = blocks(statement, 'LEDGERBAL')[0]
  const balanceCents = ledger ? parseMoney(tag(ledger, 'BALAMT') ?? '') : null
  const balanceAsOf = ledger ? parseDate(tag(ledger, 'DTASOF') ?? '') : null
  const accountId = tag(statement, 'ACCTID')?.replace(/\D/g, '') ?? ''

  return Result.succeed({
    format: 'ofx',
    currency: tag(statement, 'CURDEF')?.toUpperCase() ?? null,
    accountHint: accountId.length >= 4 ? accountId.slice(-4) : null,
    period: start && end ? { start, end } : null,
    closingBalance:
      balanceCents !== null && balanceAsOf !== null
        ? { asOf: balanceAsOf, cents: balanceCents }
        : null,
    lines: fingerprintIds(lines),
    rejectedRows,
  })
}
