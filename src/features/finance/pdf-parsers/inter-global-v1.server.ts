import { toMinorUnits } from '#/domain/currency'
import type { PdfStatementParser, PdfParserTransaction } from './types'

const months = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
]
const iso = (s: string) => s.split('/').reverse().join('-')
export const interGlobalV1Parser: PdfStatementParser = {
  id: 'inter-global-v1',
  version: '1',
  institution: 'Inter',
  kind: 'bank_statement',
  matches: ({ text }) =>
    /Account type:\s*Digital Account/i.test(text) &&
    /INTER\s*&\s*CO PAYMENTS/i.test(text),
  parse: ({ lines }) => {
    const ordered = [...lines].sort(
      (a, b) => a.bounds.page - b.bounds.page || b.bounds.y - a.bounds.y,
    )
    const text = ordered.map((l) => l.text).join('\n')
    const period = text.match(
      /Período do extrato:\s*(\d{2}\/\d{2}\/\d{4})\s*a\s*(\d{2}\/\d{2}\/\d{4})/,
    )
    const opening = text.match(/Saldo Inicial:\s*\$\s*([\d.]+,\d{2})/i)
    const closing = text.match(/Saldo Final:\s*\$\s*([\d.]+,\d{2})/i)
    if (!period || !opening || !closing)
      throw new Error('Controles Global Account incompletos.')
    const transactions: PdfParserTransaction[] = []
    const balances = new Map<string, number>()
    let postedAt: string | null = null
    for (const line of ordered) {
      const day = line.text.match(
        /^(\d{1,2}) de (\S+) de (\d{4})\s+Saldo do dia:\s*\$\s*([\d.]+,\d{2})/i,
      )
      if (day) {
        const month = months.indexOf(day[2].toLowerCase()) + 1
        if (!month) throw new Error('Mês Global inválido.')
        postedAt = `${day[3]}-${String(month).padStart(2, '0')}-${day[1].padStart(2, '0')}`
        balances.set(postedAt, toMinorUnits(day[4], 'USD'))
        continue
      }
      const movement = line.text.match(
        /^((?:Resgate|Transferência).*?\b(enviad[ao]|recebid[ao])\b.*?)\s+\$\s*([\d.]+,\d{2})\s*$/i,
      )
      if (!movement || !postedAt) continue
      transactions.push({
        postedAt,
        description: movement[1],
        amountCents:
          toMinorUnits(movement[3], 'USD') *
          (/enviad/i.test(movement[2]) ? -1 : 1),
        currency: 'USD',
        raw: { line: line.text, bounds: line.bounds },
      })
    }
    let balance = toMinorUnits(opening[1], 'USD')
    for (const day of [...balances.keys()].sort()) {
      balance += transactions
        .filter((t) => t.postedAt === day)
        .reduce((s, t) => s + t.amountCents, 0)
      if (balance !== balances.get(day))
        throw new Error(`Saldo diário Global não fecha em ${day}.`)
    }
    if (balance !== toMinorUnits(closing[1], 'USD'))
      throw new Error('Saldo final Global não fecha.')
    return {
      transactions,
      sourceTransactionCount: transactions.length,
      controls: {
        openingBalanceCents: toMinorUnits(opening[1], 'USD'),
        openingBalanceAt: iso(period[1]),
        closingBalanceCents: balance,
        closingBalanceType: 'posted',
        balanceAsOf: iso(period[2]),
        periodStart: iso(period[1]),
        periodEnd: iso(period[2]),
        dueDate: null,
      },
    }
  },
}
