import { createServerFn } from '@tanstack/react-start'
import * as Schema from 'effect/Schema'

import {
  AccountChanges,
  CardTerms,
  OpenAccount,
  OwnerKind,
} from '@spendle/server/api'

import { api } from '#/lib/api/client.server'

const accountId = Schema.Struct({ accountId: Schema.String })

export const listOwnersFn = createServerFn({ method: 'GET' }).handler(() =>
  api((client) => client.owners.list()),
)

export const createOwnerFn = createServerFn({ method: 'POST' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({ name: Schema.NonEmptyString, kind: OwnerKind }),
    ),
  )
  .handler(({ data }) =>
    api((client) => client.owners.create({ payload: data })),
  )

export const listAccountsFn = createServerFn({ method: 'GET' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({ includeArchived: Schema.Boolean }),
    ),
  )
  .handler(({ data }) =>
    api((client) =>
      client.accounts.list({
        query: { includeArchived: data.includeArchived },
      }),
    ),
  )

export const openAccountFn = createServerFn({ method: 'POST' })
  .validator(Schema.toStandardSchemaV1(OpenAccount))
  .handler(({ data }) =>
    api((client) => client.accounts.open({ payload: data })),
  )

export const updateAccountFn = createServerFn({ method: 'POST' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({ accountId: Schema.String, changes: AccountChanges }),
    ),
  )
  .handler(({ data }) =>
    api((client) =>
      client.accounts.update({
        params: { accountId: data.accountId },
        payload: data.changes,
      }),
    ),
  )

export const setCardTermsFn = createServerFn({ method: 'POST' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({ accountId: Schema.String, terms: CardTerms }),
    ),
  )
  .handler(({ data }) =>
    api((client) =>
      client.accounts.setCardTerms({
        params: { accountId: data.accountId },
        payload: data.terms,
      }),
    ),
  )

export const archiveAccountFn = createServerFn({ method: 'POST' })
  .validator(Schema.toStandardSchemaV1(accountId))
  .handler(({ data }) =>
    api((client) => client.accounts.archive({ params: data })),
  )

export const restoreAccountFn = createServerFn({ method: 'POST' })
  .validator(Schema.toStandardSchemaV1(accountId))
  .handler(({ data }) =>
    api((client) => client.accounts.restore({ params: data })),
  )

export const balanceProofFn = createServerFn({ method: 'GET' })
  .validator(Schema.toStandardSchemaV1(accountId))
  .handler(({ data }) =>
    api((client) => client.entries.balanceProof({ params: data })),
  )
