import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

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
    return handlers.handleAll({
      createTransaction: ({ payload }) => {
        const { accountId, categoryId, note, ...transaction } = payload
        return manual
          .createTransaction({ accountId, transaction, categoryId, note })
          .pipe(respond('manual.createTransaction'))
      },
      reviseTransaction: ({ params, payload }) =>
        manual
          .reviseTransaction(params.externalId, payload)
          .pipe(respond('manual.reviseTransaction')),
      removeTransaction: ({ params }) =>
        manual
          .removeTransaction(params.externalId)
          .pipe(respond('manual.removeTransaction')),
      recordCheckpoint: ({ params, payload }) =>
        manual
          .recordCheckpoint({ accountId: params.accountId, ...payload })
          .pipe(respond('manual.recordCheckpoint')),
      withdrawCheckpoint: ({ params }) =>
        manual
          .withdrawCheckpoint(params.checkpointId)
          .pipe(respond('manual.withdrawCheckpoint')),
      setNote: ({ params, payload }) =>
        notes.set(params.entryId, payload.note).pipe(respond('manual.setNote')),
    })
  }),
)
