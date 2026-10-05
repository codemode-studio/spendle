import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

import { Accounts } from '../../ledger/Accounts.ts'
import { SpendleApi } from '../definition/Api.ts'
import { respond } from '../Failures.ts'
import { ReadModel } from '../ReadModel.ts'

export const OwnersHandlers = HttpApiBuilder.group(
  SpendleApi,
  'owners',
  Effect.fn(function* (handlers) {
    const accounts = yield* Accounts
    return handlers.handleAll({
      list: () => accounts.listOwners.pipe(respond('owners.list')),
      create: ({ payload }) =>
        accounts.createOwner(payload).pipe(respond('owners.create')),
    })
  }),
)

export const AccountsHandlers = HttpApiBuilder.group(
  SpendleApi,
  'accounts',
  Effect.fn(function* (handlers) {
    const accounts = yield* Accounts
    const reads = yield* ReadModel

    const views = reads.accountViews
    const view = reads.accountView

    return handlers.handleAll({
      list: ({ query }) =>
        accounts.list.pipe(
          Effect.map((list) =>
            query.includeArchived
              ? list
              : list.filter((account) => !account.archived),
          ),
          Effect.flatMap(views),
          respond('accounts.list'),
        ),
      get: ({ params }) =>
        accounts
          .get(params.accountId)
          .pipe(Effect.flatMap(view), respond('accounts.get')),
      open: ({ payload }) =>
        accounts
          .open(payload)
          .pipe(Effect.flatMap(view), respond('accounts.open')),
      update: ({ params, payload }) =>
        accounts
          .update(params.accountId, payload)
          .pipe(Effect.flatMap(view), respond('accounts.update')),
      setCardTerms: ({ params, payload }) =>
        accounts
          .update(params.accountId, { card: payload })
          .pipe(Effect.flatMap(view), respond('accounts.setCardTerms')),
      archive: ({ params }) =>
        accounts
          .setArchived(params.accountId, true)
          .pipe(Effect.flatMap(view), respond('accounts.archive')),
      restore: ({ params }) =>
        accounts
          .setArchived(params.accountId, false)
          .pipe(Effect.flatMap(view), respond('accounts.restore')),
    })
  }),
)
