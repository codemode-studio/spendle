import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

import { Accounts } from '../../ledger/Accounts.ts'
import type { Account } from '../../ledger/Accounts.ts'
import { SpendleApi } from '../definition/Api.ts'
import type { AccountView } from '../definition/Accounts.ts'
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

    const views = Effect.fnUntraced(function* (list: ReadonlyArray<Account>) {
      const state = yield* reads.accountState
      return list.map((account): AccountView => {
        const balances = state.balances(account.id)
        return {
          ...account,
          balances,
          lastCheckpoint:
            balances.find((balance) => balance.kind === 'booked') ?? null,
          link: state.link(account.id),
        }
      })
    })
    const view = (account: Account) =>
      Effect.map(views([account]), (list) => list[0]!)

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
