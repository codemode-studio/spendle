import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

import { Entries } from '../../ledger/Entries.ts'
import { SpendleApi } from '../definition/Api.ts'
import { InvalidRequest, NotFound } from '../definition/Errors.ts'
import { respond } from '../Failures.ts'
import { ReadModel } from '../ReadModel.ts'

export const EntriesHandlers = HttpApiBuilder.group(
  SpendleApi,
  'entries',
  Effect.fn(function* (handlers) {
    const entries = yield* Entries
    const reads = yield* ReadModel
    return handlers.handleAll({
      list: ({ query }) =>
        reads.entriesPage(query).pipe(
          respond('entries.list'),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new InvalidRequest({
                    reason: 'invalid_cursor',
                    detail: query.cursor ?? null,
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        ),
      get: ({ params }) =>
        reads.entryDetail(params.entryId).pipe(
          respond('entries.get'),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new NotFound({
                    reason: 'entry_not_found',
                    detail: params.entryId,
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        ),
      balanceProof: ({ params }) =>
        entries
          .balanceProof(params.accountId)
          .pipe(respond('entries.balanceProof')),
    })
  }),
)
