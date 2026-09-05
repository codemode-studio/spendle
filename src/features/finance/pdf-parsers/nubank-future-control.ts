import { toMinorUnits } from '#/domain/currency'

export function readNubankFutureControl(
  markdown: string | null,
  plans: Array<{
    installmentAmountCents: number
    currentInstallment: number
    totalInstallments: number
  }> = [],
) {
  const section = markdown
    ?.split('PRÓXIMAS FATURAS')[1]
    ?.split('<!-- page -->')[0]
  if (!section) return null
  const date = section.match(
    /Fechamento da próxima fatura\|(\d{2}) ([A-Z]{3}) (\d{4})\|/,
  )
  const next = section.match(
    /Saldo em aberto da próxima fatura\|R\$ ([\d.]+,\d{2})\|/,
  )
  const total = section.match(/Saldo em aberto total\|R\$ ([\d.]+,\d{2})\|/)
  if (!date || !next || !total) return null
  const month =
    [
      'JAN',
      'FEV',
      'MAR',
      'ABR',
      'MAI',
      'JUN',
      'JUL',
      'AGO',
      'SET',
      'OUT',
      'NOV',
      'DEZ',
    ].indexOf(date[2]) + 1
  if (!month) return null
  const nextCents = toMinorUnits(next[1], 'BRL'),
    totalCents = toMinorUnits(total[1], 'BRL')
  if (nextCents > totalCents) return null
  const months = Math.max(
    1,
    ...plans.map((p) => p.totalInstallments - p.currentInstallment),
  )
  if (months > 120) return null
  const amounts = Array.from({ length: months }, (_, i) =>
    plans.reduce(
      (sum, p) =>
        sum +
        (p.currentInstallment + i + 1 <= p.totalInstallments
          ? p.installmentAmountCents
          : 0),
      0,
    ),
  )
  const unexplainedNextCents = nextCents - amounts[0]
  amounts[0] = nextCents
  return {
    closingDate: `${date[3]}-${String(month).padStart(2, '0')}-${date[1]}`,
    nextCents,
    totalCents,
    unexplainedNextCents,
    monthlyCents:
      unexplainedNextCents >= 0 &&
      amounts.reduce((sum, amount) => sum + amount, 0) === totalCents
        ? amounts
        : null,
  }
}
