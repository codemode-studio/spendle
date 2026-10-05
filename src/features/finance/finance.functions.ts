import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { createManualTransaction } from './finance.server'
import { serverInput } from './input-errors.server'

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Informe uma data válida.')

export const createManualTransactionFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      targetType: z.enum(['account', 'card']),
      targetId: z.string().min(1),
      postedAt: isoDateSchema,
      description: z.string().trim().min(2).max(200),
      direction: z.enum(['inflow', 'outflow']),
      amountCents: z.number().int().positive(),
      categoryId: z.string().min(1).optional(),
      counterpartyAccountId: z.string().min(1).optional(),
      notes: z.string().trim().max(200).optional(),
    }),
  )
  .handler(({ data }) => serverInput(() => createManualTransaction(data)))
