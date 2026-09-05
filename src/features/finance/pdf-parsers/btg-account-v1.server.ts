import { toMinorUnits } from '#/domain/currency'
import type { PdfStatementParser, PdfParserTransaction } from './types'

const iso = (s: string) => {
  const [d, m, y] = s.split('/')
  return `20${y}-${m}-${d}`
}
export const btgAccountV1Parser: PdfStatementParser = {
  id: 'btg-account-v1',
  version: '1',
  institution: 'BTG',
  kind: 'bank_statement',
  matches: ({ text }) =>
    /BTG PACTUAL/i.test(text) && /corrente\s*-\s*Movimentação/i.test(text),
  parse: ({ lines }) => {
    const ordered = [...lines].sort(
      (a, b) => a.bounds.page - b.bounds.page || b.bounds.y - a.bounds.y,
    )
    let active = false,
      opening: number | null = null,
      closing: number | null = null,
      start: string | null = null,
      end: string | null = null,
      balance: number | null = null
    const transactions: PdfParserTransaction[] = []
    for (const line of ordered) {
      if (/corrente\s*-\s*Movimentação/i.test(line.text)) {
        active = true
        continue
      }
      if (!active) continue
      const initial = line.text.match(
        /^(\d{2}\/\d{2}\/\d{2})\s+Saldo Anterior\s+([\d.]+,\d{2}|-)$/i,
      )
      if (initial) {
        start = iso(initial[1])
        opening = initial[2] === '-' ? 0 : toMinorUnits(initial[2], 'BRL')
        balance = opening
        continue
      }
      const final = line.text.match(
        /^(\d{2}\/\d{2}\/\d{2})\s+Saldo Final.*?\s+([\d.]+,\d{2})$/i,
      )
      if (final) {
        end = iso(final[1])
        closing = toMinorUnits(final[2], 'BRL')
        active = false
        continue
      }
      const move = line.text.match(
        /^(\d{2}\/\d{2}\/\d{2})\s+(.+?)\s+(-?[\d.]+,\d{2})\s+(-?[\d.]+,\d{2})$/,
      )
      if (!move) continue
      const amount = toMinorUnits(move[3], 'BRL'),
        next = toMinorUnits(move[4], 'BRL')
      if (balance === null || balance + amount !== next)
        throw new Error('Saldo por movimento BTG não fecha.')
      balance = next
      transactions.push({
        postedAt: iso(move[1]),
        description: move[2],
        amountCents: amount,
        currency: 'BRL',
        raw: { line: line.text, bounds: line.bounds },
      })
    }
    if (
      opening === null ||
      closing === null ||
      !start ||
      !end ||
      balance !== closing
    )
      throw new Error('Controles da conta corrente BTG não fecham.')
    return {
      transactions,
      sourceTransactionCount: transactions.length,
      controls: {
        openingBalanceCents: opening,
        openingBalanceAt: start,
        closingBalanceCents: closing,
        closingBalanceType: 'posted',
        balanceAsOf: end,
        periodStart: start,
        periodEnd: end,
        dueDate: null,
      },
    }
  },
}
