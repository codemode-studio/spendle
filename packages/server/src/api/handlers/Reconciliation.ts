import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

import { Reconciliation } from '../../reconciliation/Reconciliation.ts'
import { SpendleApi } from '../definition/Api.ts'
import { respond } from '../Failures.ts'
import { ReadModel } from '../ReadModel.ts'

export const ReconciliationHandlers = HttpApiBuilder.group(
  SpendleApi,
  'reconciliation',
  Effect.fn(function* (handlers) {
    const reconciliation = yield* Reconciliation
    const reads = yield* ReadModel
    return handlers.handleAll({
      relations: ({ query }) =>
        Effect.gen(function* () {
          const relations = (yield* reconciliation.relations).filter(
            (relation) =>
              (query.status === undefined ||
                relation.status === query.status) &&
              (query.kind === undefined || relation.kind === query.kind),
          )
          const entries = yield* reads.entriesById(
            relations.flatMap((relation) => [
              relation.outflowEntryId,
              relation.inflowEntryId,
            ]),
          )
          return relations
            .map((relation) => ({
              ...relation,
              outflow: entries.get(relation.outflowEntryId) ?? null,
              inflow: entries.get(relation.inflowEntryId) ?? null,
            }))
            .filter(
              (relation) =>
                query.accountId === undefined ||
                relation.outflow?.accountId === query.accountId ||
                relation.inflow?.accountId === query.accountId,
            )
        }).pipe(respond('reconciliation.relations')),
      decide: ({ payload }) =>
        reconciliation
          .decide(payload.key, payload.decision)
          .pipe(respond('reconciliation.decide')),
      link: ({ payload }) =>
        reconciliation.link(payload).pipe(
          Effect.map((key) => ({ key })),
          respond('reconciliation.link'),
        ),
      orphanedDecisions: () =>
        reconciliation.orphanedDecisions.pipe(
          respond('reconciliation.orphanedDecisions'),
        ),
    })
  }),
)
