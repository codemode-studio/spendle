import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { currencySchema } from '#/domain/currency'

import {
  classifyInvestmentTransaction,
  deleteInvestmentMovement,
  getInvestmentsSnapshot,
  updateInvestmentPositionValue,
} from './investments.server'

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const getInvestmentsSnapshotFn = createServerFn({
  method: 'GET',
}).handler(() => getInvestmentsSnapshot())

export const classifyInvestmentTransactionFn = createServerFn({
  method: 'POST',
})
  .validator(
    z.object({
      transactionId: z.string().min(1),
      positionId: z.string().min(1).optional(),
      newPosition: z
        .object({
          name: z.string().trim().min(2).max(100),
          assetClassId: z.string().min(1),
          goalId: z.string().min(1).optional(),
          currency: currencySchema.optional(),
        })
        .optional(),
    }),
  )
  .handler(({ data }) => classifyInvestmentTransaction(data))

export const deleteInvestmentMovementFn = createServerFn({ method: 'POST' })
  .validator(z.object({ movementId: z.string().min(1) }))
  .handler(({ data }) => deleteInvestmentMovement(data))

export const updateInvestmentPositionValueFn = createServerFn({
  method: 'POST',
})
  .validator(
    z.object({
      positionId: z.string().min(1),
      amountMinor: z.number().int().min(0),
      asOf: isoDateSchema,
    }),
  )
  .handler(({ data }) => updateInvestmentPositionValue(data))
