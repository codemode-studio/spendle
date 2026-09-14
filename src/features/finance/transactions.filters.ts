import { z } from 'zod'

export const transactionFiltersSchema = z.object({
  search: z.string().max(200).default(''),
  target: z.string().default('all'),
  category: z.string().default('all'),
  onlyUncategorized: z.boolean().default(false),
  direction: z.enum(['all', 'in', 'out']).default('all'),
  minCents: z.number().int().nonnegative().nullable().default(null),
  maxCents: z.number().int().nonnegative().nullable().default(null),
  dateFrom: z.iso.date().nullable().default(null),
  dateTo: z.iso.date().nullable().default(null),
  page: z.number().int().nonnegative().max(1_000_000).default(0),
})
export type TransactionFilters = z.infer<typeof transactionFiltersSchema>
