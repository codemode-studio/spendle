import * as HttpApi from 'effect/http-api/HttpApi'
import * as OpenApi from 'effect/http-api/OpenApi'

import { AccountsApi, OwnersApi } from './Accounts.ts'
import { CardsApi } from './Cards.ts'
import {
  CategoriesApi,
  CategoryDecisionsApi,
  CategoryStoreApi,
} from './Categories.ts'
import { EntriesApi } from './Entries.ts'
import { ImportsApi } from './Imports.ts'
import { InvestmentsApi } from './Investments.ts'
import { ManualApi } from './Manual.ts'
import { OpenFinanceApi } from './OpenFinance.ts'
import {
  AssistantApi,
  DashboardApi,
  PlanningApi,
  RecurrencesApi,
} from './Planning.ts'
import { ReconciliationApi } from './Reconciliation.ts'
import { ApiAuthorization, RequestValidation } from './Security.ts'
import { SystemApi } from './System.ts'

/**
 * The API under `/api`. Clients derive a typed client from it with
 * `HttpApiClient.make(SpendleApi)`; this module and its siblings import only
 * `effect`, so they are safe to bundle in the web app.
 */
export class AuthorizedApi extends HttpApi.make('spendle-api')
  .add(
    OwnersApi,
    AccountsApi,
    OpenFinanceApi,
    ImportsApi,
    EntriesApi,
    ReconciliationApi,
    CardsApi,
    CategoriesApi,
    CategoryStoreApi,
    CategoryDecisionsApi,
    ManualApi,
    InvestmentsApi,
    PlanningApi,
    DashboardApi,
    RecurrencesApi,
    AssistantApi,
  )
  .middleware(ApiAuthorization) {}

/** `AuthorizedApi` plus `/health`, which answers without a token. */
export class SpendleApi extends HttpApi.make('spendle')
  .addHttpApi(AuthorizedApi)
  .add(SystemApi)
  .middleware(RequestValidation)
  .annotateMerge(OpenApi.annotations({ title: 'Spendle API', version: '2' })) {}
