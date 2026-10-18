import { z } from 'zod'
import { toMinorUnits } from '#/lib/currency'
import type { EntryPageQuery } from '#/features/data/entries.functions'

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

/**
 * The URL state as the API's entries query. `category` is a category id, or
 * `review` / `uncategorized` for the entries waiting on a decision. URL pages
 * start at one; API pages start at zero.
 */
export function transactionSearchToFilters(
  search: z.infer<typeof transactionSearchSchema>,
): EntryPageQuery {
  const minAmountCents = parseAmountInput(search.minAmount)
  const maxAmountCents = parseAmountInput(search.maxAmount)
  const text = search.search.trim()
  return {
    ...(text ? { text } : {}),
    ...(search.target !== 'all' ? { accountId: search.target } : {}),
    ...(search.category === 'uncategorized'
      ? { categoryStatus: 'none' as const }
      : search.category === 'review'
        ? { categoryStatus: 'review' as const }
        : search.category !== 'all'
          ? { categoryId: search.category }
          : {}),
    ...(search.direction === 'in'
      ? { direction: 'inflow' as const }
      : search.direction === 'out'
        ? { direction: 'outflow' as const }
        : {}),
    ...(minAmountCents !== null ? { minAmountCents } : {}),
    ...(maxAmountCents !== null ? { maxAmountCents } : {}),
    ...(search.dateFrom ? { from: search.dateFrom } : {}),
    ...(search.dateTo ? { to: search.dateTo } : {}),
    page: search.page - 1,
  }
}
