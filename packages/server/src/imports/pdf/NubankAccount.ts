import * as Result from 'effect/Result'

import type { StatementProblem } from '../Statement.ts'
import {
  cents,
  fold,
  isoDate,
  lastFour,
  monthNumber,
  readingOrder,
  signedAmount,
} from './Layout.ts'
import type { LayoutLine, PdfLayout, PositionedLine } from './Layout.ts'

const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim()

const readPeriod = (text: string) => {
  const dates = [
    ...fold(text).matchAll(
      /\b(\d{2})\s+DE\s+(JANEIRO|FEVEREIRO|MARCO|ABRIL|MAIO|JUNHO|JULHO|AGOSTO|SETEMBRO|OUTUBRO|NOVEMBRO|DEZEMBRO)\s+DE\s+(\d{4})\b/g,
    ),
  ].map((match) =>
    isoDate(Number(match[3]), monthNumber(match[2]!), Number(match[1])),
  )
  const start = dates.at(0)
  const end = dates.at(1) ?? dates.at(0)
  return start && end ? { start, end } : null
}

interface Group {
  readonly direction: 'credit' | 'debit'
  readonly expectedCents: number
  actualCents: number
}

/**
 * Nubank groups each day's movements under `Total de entradas` and `Total de
 * saídas`; every group's total must equal the rows read under it. Amounts are
 * unsigned and take the group's direction.
 */
export const readNubankAccountRows = (
  lines: ReadonlyArray<PositionedLine>,
): Result.Result<ReadonlyArray<LayoutLine>, StatementProblem> => {
  const rows: Array<LayoutLine> = []
  let readingMovements = false
  let bookedOn: string | null = null
  let pending: { -readonly [K in keyof LayoutLine]: LayoutLine[K] } | null =
    null
  let group: Group | undefined

  const flushPending = () => {
    if (!pending) return
    pending.description = normalizeText(pending.description)
    rows.push(pending)
    if (group) group.actualCents += Math.abs(pending.amountCents)
    pending = null
  }
  // Closes the open group; false when its total does not match its rows.
  const closeGroup = () => {
    const balanced = !group || group.expectedCents === group.actualCents
    group = undefined
    return balanced
  }
  const openGroup = (line: PositionedLine, direction: Group['direction']) => {
    const total = line.text.match(
      /([+−-]?\s*(?:\d{1,3}(?:\.\d{3})*|\d+),\d{2})\s*$/,
    )?.[1]
    const expected = total ? cents(total) : null
    if (!bookedOn || expected === null) return false
    group = { direction, expectedCents: Math.abs(expected), actualCents: 0 }
    return true
  }
  const settle = () => {
    flushPending()
    return closeGroup()
  }

  for (const line of readingOrder(lines)) {
    if (/^movimenta[cç][oõ]es$/i.test(line.text)) {
      readingMovements = true
      continue
    }
    if (!readingMovements) continue
    if (
      /o saldo l[ií]quido corresponde|asseguramos a autenticidade|nu financeira s\.a\./i.test(
        line.text,
      )
    ) {
      if (!settle()) return Result.fail('summary_balance_mismatch')
      return Result.succeed(rows)
    }
    if (
      /extrato gerado|nubank\.com\.br|tem alguma d[uú]vida|caso a solu[cç][aã]o|^cpf\b|ag[eê]ncia.*conta|^\d{2} de [a-zç]+ de \d{4}\s+a\s+\d{2} de/i.test(
        line.text,
      )
    ) {
      continue
    }

    const dateMatch = fold(line.text).match(
      /^(\d{2})\s+(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\s+(\d{4})\b/,
    )
    if (dateMatch) {
      if (!settle()) return Result.fail('summary_balance_mismatch')
      bookedOn = isoDate(
        Number(dateMatch[3]),
        monthNumber(dateMatch[2]!),
        Number(dateMatch[1]),
      )
      const direction = /total de entradas/i.test(line.text)
        ? 'credit'
        : /total de sa[ií]das/i.test(line.text)
          ? 'debit'
          : null
      if (direction && !openGroup(line, direction))
        return Result.fail('summary_balance_mismatch')
      continue
    }
    const groupDirection = /^total de entradas\b/i.test(line.text)
      ? 'credit'
      : /^total de sa[ií]das\b/i.test(line.text)
        ? 'debit'
        : null
    if (groupDirection) {
      if (!settle() || !openGroup(line, groupDirection))
        return Result.fail('summary_balance_mismatch')
      continue
    }

    const amountMatch = line.text.match(
      /([+-]?\s*(?:\d{1,3}(?:\.\d{3})*|\d+),\d{2})\s*$/,
    )
    if (bookedOn && group && amountMatch?.index !== undefined) {
      const parsed = cents(amountMatch[1]!)
      const description = line.text
        .slice(0, amountMatch.index)
        .replace(/[|:;–—-]+$/g, '')
        .trim()
      if (parsed !== null && description) {
        flushPending()
        pending = {
          bookedOn,
          description,
          amountCents:
            group.direction === 'debit' ? -Math.abs(parsed) : Math.abs(parsed),
          source: line,
        }
        continue
      }
    }

    // Long descriptions wrap onto the next line, indented under the text.
    if (
      pending &&
      line.bounds.x >= 200 &&
      !/saldo|valores em|total de|movimenta[cç][oõ]es/i.test(line.text)
    ) {
      pending.description = `${pending.description} ${line.text}`
    }
  }
  if (!settle()) return Result.fail('summary_balance_mismatch')
  return Result.succeed(rows)
}

export const nubankAccount: PdfLayout = {
  id: 'nubank/account-statement/v1',
  kind: 'account',
  currency: 'BRL',
  matches: (text) =>
    /(?:nu financeira|nu pagamentos)\s+s\.?\s*a\.?/i.test(text) &&
    /nubank\.com\.br/i.test(text) &&
    /saldo final do per[ií]odo/i.test(text) &&
    /total de entradas/i.test(text) &&
    /movimenta[cç][oõ]es/i.test(text),
  parse: ({ text, lines }) => {
    const rows = readNubankAccountRows(lines)
    if (Result.isFailure(rows)) return Result.fail(rows.failure)
    const period = readPeriod(text)
    const closing = text.match(
      new RegExp(
        `saldo final do per[ií]odo\\s*(${signedAmount({ currency: 'required' })})`,
        'i',
      ),
    )?.[1]
    const closingCents = closing ? cents(closing) : null
    return Result.succeed({
      lines: rows.success,
      period,
      closingBalance:
        closingCents !== null && period
          ? { asOf: period.end, cents: closingCents }
          : null,
      accountHint: lastFour(
        text.match(/(?:cpf\s+)?ag[eê]ncia\s+conta\s+(\d(?:[\d.-]*\d)?)/i)?.[1],
      ),
      rejectedRows: 0,
    })
  },
}
