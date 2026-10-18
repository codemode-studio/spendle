import { createServerFn } from '@tanstack/react-start'
import * as Schema from 'effect/Schema'

import { LinkTarget } from '@spendle/server/api'

import { api } from '#/lib/api/client.server'

const connectionId = Schema.Struct({ connectionId: Schema.String })
const providerAccountId = Schema.Struct({ providerAccountId: Schema.String })

/**
 * How the browser opens Pluggy Connect. `simulated` replaces the widget with
 * a local dialog, for QA against the fake Pluggy, whose tokens the real
 * widget would refuse. Never set it against a real Pluggy account.
 */
export const connectSettingsFn = createServerFn({ method: 'GET' }).handler(
  () => ({
    mode:
      process.env.SPENDLE_PLUGGY_CONNECT === 'simulated'
        ? ('simulated' as const)
        : ('widget' as const),
  }),
)

export const listConnectionsFn = createServerFn({ method: 'GET' }).handler(() =>
  api((client) => client.openFinance.connections()),
)

export const createConnectTokenFn = createServerFn({ method: 'POST' })
  .validator(
    Schema.toStandardSchemaV1(Schema.Struct({ ownerId: Schema.String })),
  )
  .handler(({ data }) =>
    api((client) => client.openFinance.createConnectToken({ payload: data })),
  )

export const reconnectTokenFn = createServerFn({ method: 'POST' })
  .validator(Schema.toStandardSchemaV1(connectionId))
  .handler(({ data }) =>
    api((client) => client.openFinance.reconnectToken({ params: data })),
  )

export const registerItemFn = createServerFn({ method: 'POST' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        connectionId: Schema.String,
        itemId: Schema.NonEmptyString,
      }),
    ),
  )
  .handler(({ data }) =>
    api((client) =>
      client.openFinance.registerItem({
        params: { connectionId: data.connectionId },
        payload: { itemId: data.itemId },
      }),
    ),
  )

export const refreshConnectionFn = createServerFn({ method: 'POST' })
  .validator(Schema.toStandardSchemaV1(connectionId))
  .handler(({ data }) =>
    api((client) => client.openFinance.refresh({ params: data })),
  )

export const providerAccountsFn = createServerFn({ method: 'GET' })
  .validator(Schema.toStandardSchemaV1(connectionId))
  .handler(({ data }) =>
    api((client) => client.openFinance.providerAccounts({ params: data })),
  )

export const syncConnectionFn = createServerFn({ method: 'POST' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        connectionId: Schema.String,
        providerAccountId: Schema.optional(Schema.String),
      }),
    ),
  )
  .handler(async ({ data }) => {
    await api((client) =>
      client.openFinance.sync({
        params: { connectionId: data.connectionId },
        payload: { providerAccountId: data.providerAccountId },
      }),
    )
    return { accepted: true }
  })

export const disconnectFn = createServerFn({ method: 'POST' })
  .validator(Schema.toStandardSchemaV1(connectionId))
  .handler(async ({ data }) => {
    await api((client) => client.openFinance.disconnect({ params: data }))
    return { disconnected: true }
  })

export const linkProviderAccountFn = createServerFn({ method: 'POST' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({
        providerAccountId: Schema.String,
        target: LinkTarget,
        historyMonths: Schema.Literals([3, 6]),
      }),
    ),
  )
  .handler(({ data }) =>
    api((client) =>
      client.openFinance.link({
        params: { providerAccountId: data.providerAccountId },
        payload: { target: data.target, historyMonths: data.historyMonths },
      }),
    ),
  )

export const unlinkProviderAccountFn = createServerFn({ method: 'POST' })
  .validator(Schema.toStandardSchemaV1(providerAccountId))
  .handler(async ({ data }) => {
    await api((client) => client.openFinance.unlink({ params: data }))
    return { unlinked: true }
  })
