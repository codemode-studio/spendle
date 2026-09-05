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
const date = (v: string) => v.split('/').reverse().join('-')
export const interAccountV1Parser: PdfStatementParser = {
  id: 'inter-account-v1',
  version: '1',
  institution: 'Inter',
  kind: 'bank_statement',
  matches: ({ text }) =>
    /Instituição:\s*Banco Inter/i.test(text) &&
    /Saldo por transação/i.test(text),
  parse: ({ text, lines }) => {
    const period = text.match(
      /Período:\s*(\d{2}\/\d{2}\/\d{4})\s*a\s*(\d{2}\/\d{2}\/\d{4})/,
    )
    if (!period) throw new Error('Período Inter não identificado.')
    const ordered = [...lines].sort(
      (a, b) => a.bounds.page - b.bounds.page || b.bounds.y - a.bounds.y,
    )
    const transactions: PdfParserTransaction[] = []
    let postedAt: string | null = null,
      previous: number | null = null,
      opening: number | null = null
    for (const line of ordered) {
      const day = line.text.match(
        /^(\d{1,2}) de (\S+) de (\d{4})\s+Saldo do dia:/i,
      )
      if (day) {
        const month = months.indexOf(day[2].toLowerCase()) + 1
        if (!month) throw new Error('Mês Inter inválido.')
        postedAt = `${day[3]}-${String(month).padStart(2, '0')}-${day[1].padStart(2, '0')}`
        continue
      }
      const movement = line.text.match(
        /^(.*?)\s+(-?R\$\s*[\d.]+,\d{2})\s+(-?R\$\s*[\d.]+,\d{2})\s*$/,
      )
      if (!movement || !postedAt) continue
      const amount = toMinorUnits(
        movement[2].replace('R$', '').replace(/\s/g, ''),
        'BRL',
      )
      const balance = toMinorUnits(
        movement[3].replace('R$', '').replace(/\s/g, ''),
        'BRL',
      )
      if (previous !== null && previous + amount !== balance)
        throw new Error('Saldo por transação Inter não fecha.')
      if (opening === null) opening = balance - amount
      previous = balance
      transactions.push({
        postedAt,
        description: movement[1],
        amountCents: amount,
        currency: 'BRL',
        raw: { line: line.text, bounds: line.bounds },
      })
    }
    const closing = ordered
      .map((line) => line.text)
      .join('\n')
      .match(
        /Saldo total\s+Saldo disponível:\s+Saldo bloqueado:\s*R\$\s*([\d.]+,\d{2})/i,
      )
    const final = closing ? toMinorUnits(closing[1], 'BRL') : null
    if (final === null || previous !== final)
      throw new Error('Saldo total Inter não confere com a última transação.')
    return {
      transactions,
      sourceTransactionCount: transactions.length,
      controls: {
        openingBalanceCents: opening,
        openingBalanceAt: date(period[1]),
        closingBalanceCents: final,
        closingBalanceType: 'posted',
        balanceAsOf: date(period[2]),
        periodStart: date(period[1]),
        periodEnd: date(period[2]),
        dueDate: null,
      },
    }
  },
}
