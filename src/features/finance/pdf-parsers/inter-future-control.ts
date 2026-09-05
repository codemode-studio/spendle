import { toMinorUnits } from '#/domain/currency'

/** Read the issuer's installment schedule, never the available credit limit. */
interface PreviousInstallment {
  description: string
  installmentAmountCents: number
  currentInstallment: number
  totalInstallments: number
}

export function readInterFutureControl(
  markdown: string | null,
  previousInstallments: PreviousInstallment[] = [],
) {
  if (!markdown) return null
  const start = markdown.indexOf('Próxima fatura')
  if (start < 0) return null
  const section = markdown.slice(start).split('<!-- page -->')[0]
  const date = section.match(/Data de corte:\s*(\d{2})\/(\d{2})\/(\d{4})/)
  const rows = [...section.matchAll(/^\|(.+?)\|R\$\s*([\d.]+,\d{2})\|\s*$/gm)]
  const control = (label: string) => {
    const row = rows.find((r) => r[1] === label)
    return row ? toMinorUnits(row[2], 'BRL') : null
  }
  const next = control('Saldo total de compras parceladas'),
    remaining = control('Saldo demais compras parceladas'),
    total = control('Saldo em aberto total')
  if (!date || next === null || remaining === null || total === null)
    return null
  const movements = rows.filter((r) => !r[1].startsWith('Saldo '))
  if (
    movements.reduce((sum, r) => sum + toMinorUnits(r[2], 'BRL'), 0) !== next ||
    next + remaining !== total
  )
    return null
  const plans = movements.map((row) => {
    const amount = toMinorUnits(row[2], 'BRL')
    const fraction = row[1].match(/\(Parcela (\d+) de (\d+)\)/i)
    if (fraction)
      return {
        amount,
        current: Number(fraction[1]),
        total: Number(fraction[2]),
      }
    // Texto sobreposto só pode ser resolvido por uma parcela anterior única.
    const name = row[1]
      .split(/\(Parcela/i)[0]
      .trim()
      .toLowerCase()
    const candidates = previousInstallments.filter(
      (plan) =>
        plan.installmentAmountCents === amount &&
        (row[1].startsWith('de ') ||
          plan.description
            .replace(/\s*\(\s*\)$/, '')
            .trim()
            .toLowerCase() === name),
    )
    if (candidates.length !== 1) return null
    const previous = candidates[0]
    return {
      amount,
      current: previous.currentInstallment + 1,
      total: previous.totalInstallments,
    }
  })
  let monthlyCents: number[] | null = null
  if (
    plans.every(
      (plan) =>
        plan &&
        plan.current >= 1 &&
        plan.current <= plan.total &&
        plan.total <= 120,
    )
  ) {
    const validPlans = plans.filter((plan) => plan !== null)
    const months = Math.max(
      ...validPlans.map((plan) => plan.total - plan.current + 1),
    )
    const amounts = Array.from({ length: months }, (_, index) =>
      validPlans.reduce(
        (sum, plan) =>
          sum + (plan.current + index <= plan.total ? plan.amount : 0),
        0,
      ),
    )
    if (amounts.reduce((sum, amount) => sum + amount, 0) === total)
      monthlyCents = amounts
  }
  return {
    monthlyCents,
    closingDate: `${date[3]}-${date[2]}-${date[1]}`,
    nextCents: next,
    remainingCents: remaining,
    totalCents: total,
  }
}
