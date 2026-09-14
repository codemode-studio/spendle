import { z } from 'zod'
import { toMinorUnits } from '#/domain/currency'

export const transactionSearchDefaults = {
  search: '',
  target: 'all',
  category: 'all',
  direction: 'all' as const,
  minAmount: '',
  maxAmount: '',
  dateFrom: '',
  dateTo: '',
  page: 1,
}

const optionalIsoDate = z
  .union([z.literal(''), z.iso.date()])
  .default('')
  .catch('')

// URL pages start at one; database pages start at zero.
export const transactionSearchSchema = z.object({
  search: z
    .string()
    .transform((value) => value.slice(0, 200))
    .default('')
    .catch(''),
  target: z.string().default('all').catch('all'),
  category: z.string().default('all').catch('all'),
  direction: z.enum(['all', 'in', 'out']).default('all').catch('all'),
  minAmount: z.string().default('').catch(''),
  maxAmount: z.string().default('').catch(''),
  dateFrom: optionalIsoDate,
  dateTo: optionalIsoDate,
  page: z.number().int().min(1).max(1_000_001).default(1).catch(1),
})

export function parseAmountInput(text: string): number | null {
  if (!text.trim()) return null
  try {
    return Math.abs(toMinorUnits(text.trim()))
  } catch {
    return null
  }
}

export function transactionSearchToFilters(
  search: z.infer<typeof transactionSearchSchema>,
) {
  return {
    search: search.search,
    target: search.target,
    category: search.category === 'uncategorized' ? 'all' : search.category,
    onlyUncategorized: search.category === 'uncategorized',
    direction: search.direction,
    minCents: parseAmountInput(search.minAmount),
    maxCents: parseAmountInput(search.maxAmount),
    dateFrom: search.dateFrom || null,
    dateTo: search.dateTo || null,
    page: search.page - 1,
  }
}
