import * as Layer from 'effect/Layer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

import { SpendleApi } from './definition/Api.ts'
import { AccountsHandlers, OwnersHandlers } from './handlers/Accounts.ts'
import { CardsHandlers } from './handlers/Cards.ts'
import { EntriesHandlers } from './handlers/Entries.ts'
import { ImportsHandlers } from './handlers/Imports.ts'
import { OpenFinanceHandlers } from './handlers/OpenFinance.ts'
import { ReconciliationHandlers } from './handlers/Reconciliation.ts'
import { SystemHandlers } from './handlers/System.ts'
import { ReadModel } from './ReadModel.ts'
import { SecurityLive } from './Security.ts'

/** Every handler of `SpendleApi`; needs the domain services and `ApiConfig`. */
export const ApiHandlers = Layer.mergeAll(
  SystemHandlers,
  OwnersHandlers,
  AccountsHandlers,
  OpenFinanceHandlers,
  ImportsHandlers,
  EntriesHandlers,
  ReconciliationHandlers,
  CardsHandlers,
).pipe(Layer.provide(ReadModel.layer), Layer.provideMerge(SecurityLive))

/** `SpendleApi` as routes, with its OpenAPI document at `/api/v2/openapi.json`. */
export const ApiRoutes = HttpApiBuilder.layer(SpendleApi, {
  openapiPath: '/api/v2/openapi.json',
}).pipe(Layer.provide(ApiHandlers))
