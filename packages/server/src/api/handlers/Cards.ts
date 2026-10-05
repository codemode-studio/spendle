import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

import { Cards } from '../../reconciliation/Cards.ts'
import type { CardCycles } from '../../reconciliation/Cards.ts'
import { SpendleApi } from '../definition/Api.ts'
import { respond } from '../Failures.ts'

// Optional domain fields become explicit nulls, so the body keeps its keys.
const toResponse = (cycles: CardCycles) => ({
  ...cycles,
  cycles: cycles.cycles.map((cycle) => ({
    ...cycle,
    payments: cycle.payments.map((payment) => ({
      ...payment,
      creditedOn: payment.creditedOn ?? null,
      settles: payment.settles ?? null,
      statementClosing: payment.statementClosing ?? null,
    })),
  })),
})

export const CardsHandlers = HttpApiBuilder.group(
  SpendleApi,
  'cards',
  Effect.fn(function* (handlers) {
    const cards = yield* Cards
    return handlers.handleAll({
      cycles: ({ params }) =>
        cards
          .cycles(params.accountId)
          .pipe(Effect.map(toResponse), respond('cards.cycles')),
      installments: ({ params }) =>
        cards
          .installments(params.accountId)
          .pipe(respond('cards.installments')),
    })
  }),
)
