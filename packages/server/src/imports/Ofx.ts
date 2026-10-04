import * as Result from 'effect/Result'

import {
  decodeUndeclared,
  fingerprintIds,
  parseDate,
  parseOfxAmount,
} from './Statement.ts'
import type {
  ParsedStatement,
  StatementLine,
  StatementProblem,
} from './Statement.ts'

/**
 * Decodes an OFX file in the encoding it declares: a UTF-8 or UTF-16 byte
 * order mark, UTF-16 bytes opening an XML declaration, an XML `encoding`
 * declaration (XML defaults to UTF-8), or an SGML `CHARSET` header.
 * Undeclared bytes are UTF-8 when they are valid UTF-8 and Windows-1252, the
 * OFX 1.x norm, otherwise. A declared encoding that cannot be decoded is
 * refused rather than guessed.
 */
export const decodeOfx = (
  bytes: Uint8Array,
): Result.Result<string, StatementProblem> => {
  const decode = (encoding: string) =>
    Result.succeed(new TextDecoder(encoding).decode(bytes))
  const [b0, b1, b2, b3] = bytes
  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) return decode('utf-8')
  if (b0 === 0xff && b1 === 0xfe) return decode('utf-16le')
  if (b0 === 0xfe && b1 === 0xff) return decode('utf-16be')
  if (b0 === 0x3c && b1 === 0 && b2 === 0x3f && b3 === 0)
    return decode('utf-16le')
  if (b0 === 0 && b1 === 0x3c && b2 === 0 && b3 === 0x3f)
    return decode('utf-16be')
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 1024))
  const xml = head.match(/<\?xml[^>]*?encoding\s*=\s*["']([^"']+)["']/i)
  if (xml) {
    const label = xml[1]!.trim().toLowerCase()
    if (/^utf-?8$/.test(label)) return decode('utf-8')
    // UTF-16 text starts with a byte order mark or zero bytes, handled
    // above. A UTF-16 declaration over 8-bit bytes comes from writers that
    // serialize a string and save it as UTF-8 regardless.
    if (/^utf-?16(le|be)?$/.test(label))
      return Result.succeed(decodeUndeclared(bytes))
    const encoding = supportedEncoding(label)
    return encoding === null
      ? Result.fail('unsupported_encoding')
      : decode(encoding)
  }
  if (/^\s*<\?xml/i.test(head)) return decode('utf-8')
  const charset = head.match(/CHARSET:\s*([\w-]+)/i)?.[1]
  if (charset && /1252|8859/i.test(charset)) return decode('windows-1252')
  return Result.succeed(decodeUndeclared(bytes))
}

// The 8-bit encodings the WHATWG decoder implements; others, like EBCDIC or
// UTF-32, would be mis-read.
const supportedEncoding = (label: string) => {
  try {
    const { encoding } = new TextDecoder(label)
    return encoding.startsWith('utf-16') ? null : encoding
  } catch {
    return null
  }
}

export const looksLikeOfx = (text: string) =>
  /OFXHEADER|<OFX>/i.test(text.slice(0, 2048))

const escapeText = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Removes XML comments and turns CDATA sections into escaped text, so values
 * read the same however they were written. Returns null when either is left
 * open: the rest of the file would be swallowed.
 */
const unwrapMarkup = (text: string) => {
  let output = ''
  let index = 0
  for (;;) {
    const next = text.indexOf('<!', index)
    if (next === -1) return output + text.slice(index)
    output += text.slice(index, next)
    if (text.startsWith('<!--', next)) {
      const end = text.indexOf('-->', next + 4)
      if (end === -1) return null
      index = end + 3
    } else if (text.startsWith('<![CDATA[', next)) {
      const end = text.indexOf(']]>', next + 9)
      if (end === -1) return null
      output += escapeText(text.slice(next + 9, end))
      index = end + 3
    } else {
      output += '<!'
      index = next + 2
    }
  }
}

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

const characterReference = /&#([^;<&\s]*);/g

const codePointOf = (reference: string) =>
  /^x[0-9a-f]+$/i.test(reference)
    ? Number.parseInt(reference.slice(1), 16)
    : /^\d+$/.test(reference)
      ? Number(reference)
      : Number.NaN

// The characters XML allows in a document.
const isXmlChar = (code: number) =>
  code === 0x9 ||
  code === 0xa ||
  code === 0xd ||
  (code >= 0x20 && code <= 0xd7ff) ||
  (code >= 0xe000 && code <= 0xfffd) ||
  (code >= 0x10000 && code <= 0x10ffff)

const hasInvalidReference = (text: string) =>
  [...text.matchAll(characterReference)].some(
    (match) => !isXmlChar(codePointOf(match[1]!)),
  )

// Decodes XML character references; SGML OFX uses the same named entities.
// References were validated over the whole file first.
const decodeEntities = (value: string) =>
  value.replace(/&(#[^;<&\s]*|\w+);/g, (whole, code: string) =>
    code.startsWith('#')
      ? String.fromCodePoint(codePointOf(code.slice(1)))
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
  file: string,
): Result.Result<ParsedStatement, StatementProblem> => {
  const text = unwrapMarkup(file)
  if (text === null || hasInvalidReference(text))
    return Result.fail('malformed_ofx')
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
  const currency = tag(statement, 'CURDEF')?.toUpperCase() ?? null

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
    // CURRENCY says the amount is in that currency, unconverted; the account
    // keeps one currency, so such a line cannot be recorded. ORIGCURRENCY
    // says the amount was already converted to the statement's currency.
    const foreign = blocks(transaction, 'CURRENCY')[0]
    if (
      foreign !== undefined &&
      (tag(foreign, 'CURSYM')?.toUpperCase() ?? null) !== currency
    )
      return Result.fail('mixed_currencies')
    const original = blocks(transaction, 'ORIGCURRENCY')[0]
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
        ...(original === undefined
          ? {}
          : {
              originalCurrency: tag(original, 'CURSYM')?.toUpperCase() ?? null,
              originalRate: tag(original, 'CURRATE'),
            }),
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
    currency,
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
