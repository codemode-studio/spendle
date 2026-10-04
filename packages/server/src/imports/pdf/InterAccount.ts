import * as Result from 'effect/Result'

import { parseDate } from '../Statement.ts'
import { cents, isoDate, monthNumber, readingOrder } from './Layout.ts'
import type { LayoutLine, PdfLayout } from './Layout.ts'

/**
 * Reads an Inter account statement, where days are headed `1 de Junho de
 * 2026 Saldo do dia:` and every movement prints the balance after it. The
 * balances must chain and end at the statement's total balance.
 */
export const interAccount: PdfLayout = {
  id: 'inter/account-statement/v1',
  kind: 'account',
  currency: 'BRL',
  matches: (text) =>
    /Instituição:\s*Banco Inter/i.test(text) &&
    /Saldo por transação/i.test(text),
  parse: ({ text, lines }) => {
    const periodMatch = text.match(
      /Período:\s*(\d{2}\/\d{2}\/\d{4})\s*a\s*(\d{2}\/\d{2}\/\d{4})/,
    )
    const start = parseDate(periodMatch?.[1] ?? '')
    const end = parseDate(periodMatch?.[2] ?? '')
    if (!start || !end) return Result.fail('no_statement')

    const ordered = readingOrder(lines)
    const rows: Array<LayoutLine> = []
    let bookedOn: string | null = null
    let previous: number | null = null
    for (const line of ordered) {
      const day = line.text.match(
        /^(\d{1,2}) de (\S+) de (\d{4})\s+Saldo do dia:/i,
      )
      if (day) {
        const month = monthNumber(day[2]!)
        if (!month) return Result.fail('no_statement')
        bookedOn = isoDate(Number(day[3]), month, Number(day[1]))
        continue
      }
      const movement = line.text.match(
        /^(.*?)\s+(-?R\$\s*[\d.]+,\d{2})\s+(-?R\$\s*[\d.]+,\d{2})\s*$/,
      )
      if (!movement || !bookedOn) continue
      const amount = cents(movement[2]!)
      const balance = cents(movement[3]!)
      if (amount === null || balance === null)
        return Result.fail('running_balance_mismatch')
      if (previous !== null && previous + amount !== balance)
        return Result.fail('running_balance_mismatch')
      previous = balance
      rows.push({
        bookedOn,
        description: movement[1]!,
        amountCents: amount,
        source: line,
      })
    }

    const closing = ordered
      .map((line) => line.text)
      .join('\n')
      .match(
        /Saldo total\s+Saldo disponível:\s+Saldo bloqueado:\s*R\$\s*([\d.]+,\d{2})/i,
      )?.[1]
    const closingCents = closing ? cents(closing) : null
    if (closingCents === null || previous !== closingCents)
      return Result.fail('summary_balance_mismatch')

    return Result.succeed({
      lines: rows,
      period: { start, end },
      closingBalance: { asOf: end, cents: closingCents },
      accountHint: null,
      rejectedRows: 0,
    })
  },
}
