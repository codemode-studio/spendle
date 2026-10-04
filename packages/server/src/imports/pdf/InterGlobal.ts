import * as Result from 'effect/Result'

import { parseDate } from '../Statement.ts'
import { cents, isoDate, monthNumber, readingOrder } from './Layout.ts'
import type { LayoutLine, PdfLayout } from './Layout.ts'

/**
 * Reads an Inter Global Account statement, in US dollars. Movements carry no
 * sign: `enviado` is an outflow and `recebido` an inflow. Each day's closing
 * balance, and the final balance, must follow from the opening balance.
 */
export const interGlobal: PdfLayout = {
  id: 'inter/global-account-statement/v1',
  kind: 'account',
  currency: 'USD',
  matches: (text) =>
    /Account type:\s*Digital Account/i.test(text) &&
    /INTER\s*&\s*CO PAYMENTS/i.test(text),
  parse: ({ lines }) => {
    const ordered = readingOrder(lines)
    const text = ordered.map((line) => line.text).join('\n')
    const period = text.match(
      /Período do extrato:\s*(\d{2}\/\d{2}\/\d{4})\s*a\s*(\d{2}\/\d{2}\/\d{4})/,
    )
    const start = parseDate(period?.[1] ?? '')
    const end = parseDate(period?.[2] ?? '')
    const opening = cents(
      text.match(/Saldo Inicial:\s*\$\s*([\d.]+,\d{2})/i)?.[1] ?? '',
    )
    const closing = cents(
      text.match(/Saldo Final:\s*\$\s*([\d.]+,\d{2})/i)?.[1] ?? '',
    )
    if (!start || !end || opening === null || closing === null)
      return Result.fail('no_statement')

    const rows: Array<LayoutLine> = []
    const dayBalances = new Map<string, number>()
    let bookedOn: string | null = null
    for (const line of ordered) {
      const day = line.text.match(
        /^(\d{1,2}) de (\S+) de (\d{4})\s+Saldo do dia:\s*\$\s*([\d.]+,\d{2})/i,
      )
      if (day) {
        const month = monthNumber(day[2]!)
        const balance = cents(day[4]!)
        if (!month || balance === null) return Result.fail('no_statement')
        bookedOn = isoDate(Number(day[3]), month, Number(day[1]))
        dayBalances.set(bookedOn, balance)
        continue
      }
      const movement = line.text.match(
        /^((?:Resgate|Transferência).*?\b(enviad[ao]|recebid[ao])\b.*?)\s+\$\s*([\d.]+,\d{2})\s*$/i,
      )
      if (!movement || !bookedOn) continue
      const amount = cents(movement[3]!)
      if (amount === null) return Result.fail('running_balance_mismatch')
      rows.push({
        bookedOn,
        description: movement[1]!,
        amountCents: /enviad/i.test(movement[2]!) ? -amount : amount,
        source: line,
      })
    }

    let balance = opening
    for (const day of [...dayBalances.keys()].sort()) {
      balance += rows
        .filter((row) => row.bookedOn === day)
        .reduce((sum, row) => sum + row.amountCents, 0)
      if (balance !== dayBalances.get(day))
        return Result.fail('running_balance_mismatch')
    }
    if (balance !== closing) return Result.fail('summary_balance_mismatch')

    return Result.succeed({
      lines: rows,
      period: { start, end },
      closingBalance: { asOf: end, cents: closing },
      accountHint: null,
      rejectedRows: 0,
    })
  },
}
