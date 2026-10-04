import * as Result from 'effect/Result'

import { parseDate } from '../Statement.ts'
import { cents, readingOrder } from './Layout.ts'
import type { LayoutLine, PdfLayout } from './Layout.ts'

/**
 * Reads the `Conta corrente - Movimentação` section of a BTG Pactual
 * statement, between `Saldo Anterior` and `Saldo Final`. Each movement prints
 * the balance after it, which must chain from the opening balance to the
 * final one. The `Posição` section above repeats balances, not movements.
 */
export const btgAccount: PdfLayout = {
  id: 'btg/account-statement/v1',
  kind: 'account',
  currency: 'BRL',
  matches: (text) =>
    /BTG PACTUAL/i.test(text) && /corrente\s*-\s*Movimentação/i.test(text),
  parse: ({ lines }) => {
    let active = false
    let opening: number | null = null
    let closing: number | null = null
    let start: string | null = null
    let end: string | null = null
    let balance: number | null = null
    const rows: Array<LayoutLine> = []
    for (const line of readingOrder(lines)) {
      if (/corrente\s*-\s*Movimentação/i.test(line.text)) {
        active = true
        continue
      }
      if (!active) continue
      const initial = line.text.match(
        /^(\d{2}\/\d{2}\/\d{2})\s+Saldo Anterior\s+([\d.]+,\d{2}|-)$/i,
      )
      if (initial) {
        start = parseDate(initial[1]!)
        opening = initial[2] === '-' ? 0 : cents(initial[2]!)
        balance = opening
        continue
      }
      const final = line.text.match(
        /^(\d{2}\/\d{2}\/\d{2})\s+Saldo Final.*?\s+([\d.]+,\d{2})$/i,
      )
      if (final) {
        end = parseDate(final[1]!)
        closing = cents(final[2]!)
        active = false
        continue
      }
      const move = line.text.match(
        /^(\d{2}\/\d{2}\/\d{2})\s+(.+?)\s+(-?[\d.]+,\d{2})\s+(-?[\d.]+,\d{2})$/,
      )
      if (!move) continue
      const bookedOn = parseDate(move[1]!)
      const amount = cents(move[3]!)
      const next = cents(move[4]!)
      if (
        bookedOn === null ||
        amount === null ||
        balance === null ||
        balance + amount !== next
      )
        return Result.fail('running_balance_mismatch')
      balance = next
      rows.push({
        bookedOn,
        description: move[2]!,
        amountCents: amount,
        source: line,
      })
    }
    if (opening === null || closing === null || !start || !end)
      return Result.fail('no_statement')
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
