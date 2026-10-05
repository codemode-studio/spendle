import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

import { Investments } from '../../investments/Investments.ts'
import { SpendleApi } from '../definition/Api.ts'
import { respond } from '../Failures.ts'

export const InvestmentsHandlers = HttpApiBuilder.group(
  SpendleApi,
  'investments',
  Effect.fn(function* (handlers) {
    const investments = yield* Investments
    return handlers.handleAll({
      snapshot: ({ query }) =>
        investments.snapshot(query.on).pipe(respond('investments.snapshot')),
      createPosition: ({ payload }) =>
        investments
          .createPosition(payload)
          .pipe(respond('investments.createPosition')),
      classify: ({ payload }) =>
        investments.classify(payload).pipe(respond('investments.classify')),
      unclassify: ({ params }) =>
        investments
          .unclassify(params.entryId)
          .pipe(respond('investments.unclassify')),
      recordValuation: ({ params, payload }) =>
        investments
          .recordValuation({ positionId: params.positionId, ...payload })
          .pipe(respond('investments.recordValuation')),
    })
  }),
)
