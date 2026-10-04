import * as Result from 'effect/Result'

import { fingerprintIds, parseDate, parseOfxAmount } from './Statement.ts'
import type {
  ParsedStatement,
  StatementLine,
  StatementProblem,
} from './Statement.ts'

/**
 * Decodes an OFX file in the encoding it declares: a UTF-8 BOM, an XML
 * `encoding` declaration (XML defaults to UTF-8), or an SGML `CHARSET`
 * header. Undeclared bytes are UTF-8 when they are valid UTF-8 and
 * Windows-1252, the OFX 1.x norm, otherwise.
 */
export const decodeOfx = (bytes: Uint8Array) => {
  const decode = (encoding: string) => new TextDecoder(encoding).decode(bytes)
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return decode('utf-8')
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 1024))
  const xml = head.match(/<\?xml[^>]*?encoding\s*=\s*["']([^"']+)["']/i)
  if (xml) return decode(/utf-?8/i.test(xml[1]!) ? 'utf-8' : 'windows-1252')
  if (/^\s*<\?xml/i.test(head)) return decode('utf-8')
  const charset = head.match(/CHARSET:\s*([\w-]+)/i)?.[1]
  if (charset && /1252|8859/i.test(charset)) return decode('windows-1252')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return decode('windows-1252')
  }
}

export const looksLikeOfx = (text: string) =>
  /OFXHEADER|<OFX>/i.test(text.slice(0, 2048))

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

// Decodes XML character references; SGML OFX uses the same named entities.
const decodeEntities = (value: string) =>
  value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code: string) =>
    code.startsWith('#x') || code.startsWith('#X')
      ? String.fromCodePoint(Number.parseInt(code.slice(2), 16))
      : code.startsWith('#')
        ? String.fromCodePoint(Number(code.slice(1)))
        : (entities[code.toLowerCase()] ?? whole),
  )

// Reads `<TAG>value` in both SGML (unclosed) and XML (closed) OFX; the value
// may sit on the next line.
const tag = (block: string, name: string) => {
  const raw = block.match(new RegExp(`<${name}>([^<]*)`, 'i'))?.[1]
  const value = raw === undefined ? '' : decodeEntities(raw.trim())
  return value || null
}

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
  const statements = [
    ...blocks(text, 'STMTRS').map((block) => ({
      block,
      kind: 'account' as const,
    })),
    ...blocks(text, 'CCSTMTRS').map((block) => ({
      block,
      kind: 'card' as const,
    })),
  ]
  if (statements.length === 0) return Result.fail('no_statement')
  if (statements.length > 1) return Result.fail('multiple_statements')
  const { block: statement, kind } = statements[0]!

  let rejectedRows = 0
  const lines: Array<
    Omit<StatementLine, 'externalId'> & { externalId?: string }
  > = []
  for (const transaction of blocks(statement, 'STMTTRN')) {
    const bookedOn = parseDate(tag(transaction, 'DTPOSTED') ?? '')
    const amountCents = parseOfxAmount(tag(transaction, 'TRNAMT') ?? '')
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
  const balanceCents = ledger
    ? parseOfxAmount(tag(ledger, 'BALAMT') ?? '')
    : null
  const balanceAsOf = ledger ? parseDate(tag(ledger, 'DTASOF') ?? '') : null
  const accountId = tag(statement, 'ACCTID')?.replace(/\D/g, '') ?? ''

  return Result.succeed({
    format: 'ofx',
    currency: tag(statement, 'CURDEF')?.toUpperCase() ?? null,
    accountKind: kind,
    accountHint: accountId.length >= 4 ? accountId.slice(-4) : null,
    period: start && end ? { start, end } : null,
    // A bank's LEDGERBAL is its balance at DTASOF. A card's is the card's
    // current balance, not the total of an issued bill, so it is not offered
    // as one.
    closingBalance:
      kind === 'account' && balanceCents !== null && balanceAsOf !== null
        ? { asOf: balanceAsOf, cents: balanceCents }
        : null,
    lines: fingerprintIds(lines),
    rejectedRows,
  })
}
