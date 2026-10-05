import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { CategoriesError } from '../categories/Categories.ts'
import { CategorizerError } from '../categories/Categorizer.ts'
import { KnowledgeStoreError } from '../categories/KnowledgeStore.ts'
import { ImportRejected } from '../imports/Imports.ts'
import {
  AccountNotFound,
  InvalidAccount,
  OwnerNotFound,
} from '../ledger/Accounts.ts'
import { CurrencyMismatch, InvalidReport } from '../ledger/Observations.ts'
import { OpenFinanceError } from '../openfinance/OpenFinance.ts'
import { PluggyError } from '../openfinance/PluggyClient.ts'
import { CardsError } from '../reconciliation/Cards.ts'
import { ReconciliationError } from '../reconciliation/Reconciliation.ts'
import {
  Conflict,
  InternalError,
  InvalidRequest,
  NotFound,
  ProviderFailed,
  Rejected,
  Unavailable,
} from './definition/Errors.ts'

/** What a V2 endpoint may fail with besides the middleware's errors. */
export type EndpointError =
  | NotFound
  | InvalidRequest
  | Conflict
  | Rejected
  | ProviderFailed
  | Unavailable
  | InternalError

type Status =
  typeof NotFound | typeof InvalidRequest | typeof Conflict | typeof Rejected

const byReason = (
  table: Readonly<Record<string, Status>>,
  reason: string,
  detail: string | null | undefined,
): EndpointError =>
  new (table[reason] ?? Rejected)({ reason, detail: detail ?? null })

const openFinance: Record<OpenFinanceError['reason'], Status> = {
  connection_not_found: NotFound,
  provider_account_not_found: NotFound,
  item_belongs_elsewhere: Conflict,
  connection_disconnected: Conflict,
  already_linked: Conflict,
  not_linked: Conflict,
  incompatible_account: Rejected,
  item_already_registered: Conflict,
  item_deleted: Conflict,
}

const reconciliation: Record<ReconciliationError['reason'], Status> = {
  relation_not_found: NotFound,
  entry_not_found: NotFound,
  already_linked: Conflict,
  not_a_pair: Rejected,
  exceeds_purchase: Rejected,
  link_not_applied: Rejected,
}

const categories: Record<CategoriesError['reason'], Status> = {
  category_not_found: NotFound,
  system_category: Rejected,
  protected_category: Rejected,
  invalid_parent: InvalidRequest,
  invalid_input: InvalidRequest,
}

const categorizer: Record<CategorizerError['reason'], Status> = {
  entry_not_found: NotFound,
  category_not_found: NotFound,
  decision_not_found: NotFound,
  category_not_assignable: Rejected,
  nothing_to_confirm: Rejected,
}

const store: Record<KnowledgeStoreError['reason'], Status> = {
  pattern_not_found: NotFound,
  category_not_found: NotFound,
  pattern_taken: Conflict,
  invalid_pattern: InvalidRequest,
  not_a_merchant_pattern: Rejected,
  no_prefix_candidate: Rejected,
  category_not_assignable: Rejected,
}

const isAccountNotFound = Schema.is(AccountNotFound)
const isCardsError = Schema.is(CardsError)
const isCategoriesError = Schema.is(CategoriesError)
const isCategorizerError = Schema.is(CategorizerError)
const isCurrencyMismatch = Schema.is(CurrencyMismatch)
const isImportRejected = Schema.is(ImportRejected)
const isInvalidAccount = Schema.is(InvalidAccount)
const isInvalidReport = Schema.is(InvalidReport)
const isKnowledgeStoreError = Schema.is(KnowledgeStoreError)
const isOpenFinanceError = Schema.is(OpenFinanceError)
const isOwnerNotFound = Schema.is(OwnerNotFound)
const isPluggyError = Schema.is(PluggyError)
const isReconciliationError = Schema.is(ReconciliationError)

/** The API error for a domain failure, or `None` when it is unexpected. */
const known = (error: unknown): EndpointError | undefined => {
  if (isAccountNotFound(error))
    return new NotFound({
      reason: 'account_not_found',
      detail: error.accountId,
    })
  if (isOwnerNotFound(error))
    return new NotFound({ reason: 'owner_not_found', detail: error.ownerId })
  if (isInvalidAccount(error))
    return error.reason === 'linked_to_provider'
      ? new Conflict({ reason: error.reason, detail: null })
      : new InvalidRequest({
          reason: error.reason,
          detail: error.issue ?? null,
        })
  if (isCurrencyMismatch(error))
    return new Rejected({
      reason: 'currency_mismatch',
      detail: `${error.reportedCurrency} for a ${error.accountCurrency} account`,
    })
  if (isInvalidReport(error))
    return new Rejected({ reason: 'invalid_report', detail: error.issue })
  if (isOpenFinanceError(error))
    return byReason(openFinance, error.reason, error.detail)
  if (isPluggyError(error)) {
    if (error.reason === 'not_configured')
      return new Unavailable({ reason: 'pluggy_not_configured', detail: null })
    if (error.reason === 'not_found')
      return new NotFound({
        reason: 'provider_not_found',
        detail: error.operation,
      })
    return new ProviderFailed({
      reason: `pluggy_${error.reason}`,
      detail: error.operation,
    })
  }
  if (isImportRejected(error))
    return new Rejected({ reason: error.reason, detail: error.detail ?? null })
  if (isReconciliationError(error))
    return byReason(reconciliation, error.reason, error.detail)
  if (isCardsError(error))
    return new Rejected({ reason: error.reason, detail: error.accountId })
  if (isCategoriesError(error))
    return byReason(categories, error.reason, error.categoryId ?? error.detail)
  if (isCategorizerError(error))
    return byReason(
      categorizer,
      error.reason,
      error.entryId ?? error.categoryId,
    )
  if (isKnowledgeStoreError(error))
    return byReason(store, error.reason, error.patternId ?? error.categoryId)
  return undefined
}

/**
 * Turns a domain failure into its API error. Anything unexpected (storage,
 * event log, decoding stored rows) is logged with its cause and answered as
 * `InternalError`, without internals in the body.
 */
export const respond =
  (operation: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, EndpointError, R> =>
    Effect.catch(effect, (error) => {
      const mapped = known(error)
      if (mapped) return Effect.fail(mapped)
      return Effect.logError(`${operation} failed`, error).pipe(
        Effect.andThen(
          Effect.fail(
            new InternalError({ reason: 'internal', detail: operation }),
          ),
        ),
      )
    })
