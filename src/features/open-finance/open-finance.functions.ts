import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import {
  createPluggyConnectToken,
  disconnectPluggyConnection,
  getOpenFinanceSnapshot,
  mapPluggyAccount,
  registerPluggyItem,
  registerPluggyWebhook,
  resolvePluggyCorrection,
  resumePluggyConnection,
  syncPluggyConnection,
} from './open-finance.server'

export const getOpenFinanceSnapshotFn = createServerFn({
  method: 'GET',
}).handler(() => getOpenFinanceSnapshot())

export const createPluggyConnectTokenFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      ownershipScopeId: z.string().min(1),
      connectionId: z.string().min(1).optional(),
    }),
  )
  .handler(({ data }) => createPluggyConnectToken(data))

export const registerPluggyItemFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      connectionId: z.string().min(1),
      itemId: z.string().min(1),
    }),
  )
  .handler(({ data }) => registerPluggyItem(data))

const existingTargetSchema = z.object({
  type: z.enum(['account', 'card']),
  id: z.string().min(1),
})
const newTargetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('account'),
    name: z.string().trim().min(2).max(80),
    kind: z.enum(['checking', 'savings']),
    purpose: z.enum(['operating', 'reserve', 'investment']),
  }),
  z.object({
    type: z.literal('card'),
    name: z.string().trim().min(2).max(80),
    limitCents: z.number().int().min(0),
    closingDay: z.number().int().min(1).max(31),
    dueDay: z.number().int().min(1).max(31).optional(),
  }),
])

export const mapPluggyAccountFn = createServerFn({ method: 'POST' })
  .validator(
    z
      .object({
        providerAccountId: z.string().min(1),
        existingTarget: existingTargetSchema.optional(),
        newTarget: newTargetSchema.optional(),
      })
      .refine(
        (value) => Boolean(value.existingTarget) !== Boolean(value.newTarget),
        'Escolha um instrumento existente ou crie um novo.',
      ),
  )
  .handler(({ data }) =>
    mapPluggyAccount(data as Parameters<typeof mapPluggyAccount>[0]),
  )

export const syncPluggyConnectionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ connectionId: z.string().min(1) }))
  .handler(({ data }) => syncPluggyConnection(data))

export const resolvePluggyCorrectionFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      observationId: z.string().min(1),
      action: z.enum(['accept', 'reject']),
    }),
  )
  .handler(({ data }) => resolvePluggyCorrection(data))

export const disconnectPluggyConnectionFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      connectionId: z.string().min(1),
      confirmation: z.string(),
    }),
  )
  .handler(({ data }) => disconnectPluggyConnection(data))

export const resumePluggyConnectionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ connectionId: z.string().min(1) }))
  .handler(({ data }) => resumePluggyConnection(data))

export const registerPluggyWebhookFn = createServerFn({
  method: 'POST',
}).handler(() => registerPluggyWebhook())
