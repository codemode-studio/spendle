import { cents, isoDate, monthNumber } from './Layout.ts'

/**
 * Card bills print what is already committed to coming bills. These readers
 * take the Markdown of a bill (pages separated by `<!-- page -->`) and
 * return that schedule only when its own totals close. They read the
 * issuer's schedule, never the available credit limit.
 */

export interface InstallmentPlan {
  readonly installmentAmountCents: number
  readonly currentInstallment: number
  readonly totalInstallments: number
}

/**
 * Reads Nubank's `PRÓXIMAS FATURAS`: the next bill's open balance and the
 * total still open. Known installment plans spread the total over months;
 * the next bill keeps its documented amount even when the plans explain
 * only part of it.
 */
export const readNubankFutureControl = (
  markdown: string | null,
  plans: ReadonlyArray<InstallmentPlan> = [],
) => {
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
  const month = monthNumber(date[2]!)
  const nextCents = cents(next[1]!)
  const totalCents = cents(total[1]!)
  if (!month || nextCents === null || totalCents === null) return null
  if (nextCents > totalCents) return null
  const months = Math.max(
    1,
    ...plans.map((plan) => plan.totalInstallments - plan.currentInstallment),
  )
  if (months > 120) return null
  const amounts = Array.from({ length: months }, (_, index) =>
    plans.reduce(
      (sum, plan) =>
        sum +
        (plan.currentInstallment + index + 1 <= plan.totalInstallments
          ? plan.installmentAmountCents
          : 0),
      0,
    ),
  )
  const unexplainedNextCents = nextCents - amounts[0]!
  amounts[0] = nextCents
  return {
    closingDate: isoDate(Number(date[3]), month, Number(date[1])),
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

export interface PreviousInstallment extends InstallmentPlan {
  readonly description: string
}

/**
 * Reads Inter's `Próxima fatura`: the installments billed next, the rest of
 * the installments, and the total open. The rows must add up to the next
 * bill and, with the rest, to the total. An installment whose `(Parcela x
 * de y)` text is garbled is recovered only from a single matching plan of
 * the previous bill.
 */
export const readInterFutureControl = (
  markdown: string | null,
  previousInstallments: ReadonlyArray<PreviousInstallment> = [],
) => {
  if (!markdown) return null
  const start = markdown.indexOf('Próxima fatura')
  if (start < 0) return null
  const section = markdown.slice(start).split('<!-- page -->')[0]!
  const date = section.match(/Data de corte:\s*(\d{2})\/(\d{2})\/(\d{4})/)
  const rows = [
    ...section.matchAll(/^\|(.+?)\|R\$\s*([\d.]+,\d{2})\|\s*$/gm),
  ].map((row) => ({ label: row[1]!, cents: cents(row[2]!) }))
  if (rows.some((row) => row.cents === null)) return null
  const amountOf = (label: string) =>
    rows.find((row) => row.label === label)?.cents ?? null
  const next = amountOf('Saldo total de compras parceladas')
  const remaining = amountOf('Saldo demais compras parceladas')
  const total = amountOf('Saldo em aberto total')
  if (!date || next === null || remaining === null || total === null)
    return null
  const movements = rows
    .filter((row) => !row.label.startsWith('Saldo '))
    .map((row) => ({ label: row.label, cents: row.cents ?? 0 }))
  if (
    movements.reduce((sum, row) => sum + row.cents, 0) !== next ||
    next + remaining !== total
  )
    return null

  const plans = movements.map((row) => {
    const fraction = row.label.match(/\(Parcela (\d+) de (\d+)\)/i)
    if (fraction)
      return {
        amount: row.cents,
        current: Number(fraction[1]),
        total: Number(fraction[2]),
      }
    // Overlapping text can only be resolved by a single previous installment.
    const name = row.label
      .split(/\(Parcela/i)[0]!
      .trim()
      .toLowerCase()
    const candidates = previousInstallments.filter(
      (plan) =>
        plan.installmentAmountCents === row.cents &&
        (row.label.startsWith('de ') ||
          plan.description
            .replace(/\s*\(\s*\)$/, '')
            .trim()
            .toLowerCase() === name),
    )
    const previous = candidates.length === 1 ? candidates[0]! : null
    return previous
      ? {
          amount: row.cents,
          current: previous.currentInstallment + 1,
          total: previous.totalInstallments,
        }
      : null
  })

  let monthlyCents: Array<number> | null = null
  const validPlans = plans.filter(
    (plan) =>
      plan !== null &&
      plan.current >= 1 &&
      plan.current <= plan.total &&
      plan.total <= 120,
  )
  if (validPlans.length === plans.length) {
    const resolved = validPlans.filter((plan) => plan !== null)
    const months = Math.max(
      ...resolved.map((plan) => plan.total - plan.current + 1),
    )
    const amounts = Array.from({ length: months }, (_, index) =>
      resolved.reduce(
        (sum, plan) =>
          sum + (plan.current + index <= plan.total ? plan.amount : 0),
        0,
      ),
    )
    if (amounts.reduce((sum, amount) => sum + amount, 0) === total)
      monthlyCents = amounts
  }

  return {
    installments: movements.map((row, index) => ({
      description: row.label.split(/\(Parcela/i)[0]!.trim(),
      amountCents: row.cents,
      current: plans[index]?.current ?? null,
      total: plans[index]?.total ?? null,
    })),
    monthlyCents,
    closingDate: `${date[3]}-${date[2]}-${date[1]}`,
    nextCents: next,
    remainingCents: remaining,
    totalCents: total,
  }
}
