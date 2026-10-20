import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

import { Reactors, settled } from '../../events/Reactor.ts'
import { ManualEntries } from '../../ledger/Manual.ts'
import { Notes } from '../../ledger/Notes.ts'
import { SpendleApi } from '../definition/Api.ts'
import { respond } from '../Failures.ts'

export const ManualHandlers = HttpApiBuilder.group(
  SpendleApi,
  'manual',
  Effect.fn(function* (handlers) {
    const manual = yield* ManualEntries
    const notes = yield* Notes
    // A typed-in change resolves its entry in the request; its category and
    // pairs are rebuilt in reactors, so it answers once those show it too.
    // Notes are stored as they are.
    const settle = settled(yield* Reactors)
    return handlers.handleAll({
      createTransaction: ({ payload }) => {
        const { accountId, categoryId, note, ...transaction } = payload
        return manual
          .createTransaction({ accountId, transaction, categoryId, note })
          .pipe(settle, respond('manual.createTransaction'))
      },
      reviseTransaction: ({ params, payload }) =>
        manual
          .reviseTransaction(params.externalId, payload)
          .pipe(settle, respond('manual.reviseTransaction')),
      removeTransaction: ({ params }) =>
        manual
          .removeTransaction(params.externalId)
          .pipe(settle, respond('manual.removeTransaction')),
      recordCheckpoint: ({ params, payload }) =>
        manual
          .recordCheckpoint({ accountId: params.accountId, ...payload })
          .pipe(settle, respond('manual.recordCheckpoint')),
      withdrawCheckpoint: ({ params }) =>
        manual
          .withdrawCheckpoint(params.checkpointId)
          .pipe(settle, respond('manual.withdrawCheckpoint')),
      setNote: ({ params, payload }) =>
        notes.set(params.entryId, payload.note).pipe(respond('manual.setNote')),
    })
  }),
)
