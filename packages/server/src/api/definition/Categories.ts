import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

import {
  CategoryExplanation,
  Entry,
  InferenceOrigin,
  Proposal,
} from './Entries.ts'
import { EndpointErrors } from './Errors.ts'

export const Bucket = Schema.Literals([
  'essential',
  'lifestyle',
  'investment',
  'reserve',
  'income',
  'business',
  'tax',
  'excluded',
])

export const Category = Schema.Struct({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  name: Schema.String,
  bucket: Bucket,
  color: Schema.String,
  icon: Schema.NullOr(Schema.String),
  /** False once archived: kept for history, never offered. */
  active: Schema.Boolean,
  /** Owned by reconciliation (transfers, card payments): never edited or learned. */
  system: Schema.Boolean,
  /**
   * Whether a person may choose it for a movement: active and their own, or
   * the bill payment, for a payment reconciliation found no other side of.
   */
  assignable: Schema.Boolean,
})
export type Category = typeof Category.Type

const Color = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/))

export const NewCategory = Schema.Struct({
  name: Schema.NonEmptyString,
  bucket: Bucket,
  color: Schema.optional(Color),
  icon: Schema.optional(Schema.NullOr(Schema.String)),
  parentId: Schema.optional(Schema.NullOr(Schema.String)),
})

export const CategoryChanges = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyString),
  bucket: Schema.optional(Bucket),
  color: Schema.optional(Color),
  icon: Schema.optional(Schema.NullOr(Schema.String)),
  parentId: Schema.optional(Schema.NullOr(Schema.String)),
})

export const MatchMode = Schema.Literals(['exact', 'prefix'])

/** One row of what the person taught: a merchant pattern or a provider category mapping. */
export const StorePattern = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(['merchant', 'provider_category']),
  pattern: Schema.String,
  matchMode: MatchMode,
  /** Provider mappings apply to both directions. */
  direction: Schema.Literals(['income', 'expense', 'any']),
  categoryId: Schema.String,
  categoryName: Schema.String,
  categoryColor: Schema.String,
  signature: Schema.String,
  sampleDescription: Schema.String,
  source: Schema.Literals([
    'transaction_list',
    'review',
    'v1_import',
    'store_edit',
    'provider_mapping',
  ]),
  confirmations: Schema.Int,
  corrections: Schema.Int,
  lastLearnedAt: Schema.String,
  /** The aggregator this exact pattern could become a prefix of. */
  prefixCandidate: Schema.NullOr(Schema.String),
})

/** A person's edit of the store. Preview it first: it reapplies to history. */
export const StoreEdit = Schema.Union([
  Schema.TaggedStruct('Recategorize', {
    id: Schema.String,
    categoryId: Schema.String,
  }),
  Schema.TaggedStruct('EditPattern', {
    id: Schema.String,
    pattern: Schema.String,
    matchMode: MatchMode,
  }),
  Schema.TaggedStruct('Remove', { id: Schema.String }),
  Schema.TaggedStruct('PromoteToPrefix', { id: Schema.String }),
  Schema.TaggedStruct('SetProviderMapping', {
    /** `pluggy`, the only provider today. */
    provider: Schema.Literal('pluggy'),
    /** Pluggy's category id, or its name when the id is unknown. */
    providerCategory: Schema.NonEmptyString,
    categoryId: Schema.String,
  }),
])

export const Inference = Schema.Struct({
  entryId: Schema.String,
  categoryId: Schema.NullOr(Schema.String),
  origin: InferenceOrigin,
  originRef: Schema.NullOr(Schema.String),
  confidence: Schema.Number,
  status: Schema.Literals(['applied', 'review', 'none']),
  excludedFromSpending: Schema.Boolean,
  reasons: Schema.Array(Schema.String),
  candidates: Schema.Array(Proposal),
})

/** An entry whose category the edit would change. */
export const PreviewChange = Schema.Struct({
  entryId: Schema.String,
  entry: Schema.NullOr(Entry),
  before: Inference,
  after: Inference,
})

export const ProviderMapping = Schema.Struct({
  provider: Schema.String,
  providerCategory: Schema.String,
  categoryId: Schema.String,
  /** `person` applies automatically; `built_in` is only suggested for review. */
  source: Schema.Literals(['person', 'built_in']),
})

/** A movement waiting for the person to confirm or correct its category. */
export const ReviewItem = Schema.Struct({
  inference: CategoryExplanation,
  accountId: Schema.String,
  bookedOn: Schema.String,
  amountCents: Schema.Int,
  description: Schema.String,
})

const categoryParams = { categoryId: Schema.String }
const entryParams = { entryId: Schema.String }

export class CategoriesApi extends HttpApiGroup.make('categories')
  .add(
    HttpApiEndpoint.get('list', '/', {
      query: { includeArchived: Schema.optional(Schema.Boolean) },
      success: Schema.Array(Category),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('create', '/', {
      payload: NewCategory,
      success: Category,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.patch('update', '/:categoryId', {
      params: categoryParams,
      payload: CategoryChanges,
      success: Category,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('archive', '/:categoryId/archive', {
      params: categoryParams,
      success: Category,
      error: EndpointErrors,
    }),
  )
  .prefix('/api/categories') {}

export class CategoryStoreApi extends HttpApiGroup.make('categoryStore')
  .add(
    HttpApiEndpoint.get('patterns', '/patterns', {
      success: Schema.Array(StorePattern),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('preview', '/preview', {
      payload: Schema.Struct({ edit: StoreEdit }),
      success: Schema.Array(PreviewChange),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('edit', '/edits', {
      payload: Schema.Struct({ edit: StoreEdit }),
      /** The pattern the edit is about. Entries are recategorized in the background. */
      success: Schema.Struct({ patternId: Schema.String }),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.get('providerMappings', '/provider-mappings', {
      success: Schema.Array(ProviderMapping),
      error: EndpointErrors,
    }),
  )
  .prefix('/api/category-store') {}

export class CategoryDecisionsApi extends HttpApiGroup.make('categoryDecisions')
  .add(
    HttpApiEndpoint.get('review', '/category-review', {
      success: Schema.Array(ReviewItem),
      error: EndpointErrors,
    }),
    HttpApiEndpoint.get('explain', '/entries/:entryId/category', {
      params: entryParams,
      success: CategoryExplanation,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.put('decide', '/entries/:entryId/category', {
      params: entryParams,
      /**
       * The person's category, chosen in the transaction list;
       * `uncategorized` leaves the entry without one. `learn: false` keeps
       * the store from learning the merchant.
       */
      payload: Schema.Struct({
        categoryId: Schema.String,
        learn: Schema.optional(Schema.Boolean),
      }),
      success: CategoryExplanation,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('confirm', '/entries/:entryId/category/confirm', {
      params: entryParams,
      success: CategoryExplanation,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('correct', '/entries/:entryId/category/correct', {
      params: entryParams,
      payload: Schema.Struct({ categoryId: Schema.String }),
      success: CategoryExplanation,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.delete('undo', '/entries/:entryId/category', {
      params: entryParams,
      /** What the entry falls back to without the person's decision. */
      success: CategoryExplanation,
      error: EndpointErrors,
    }),
  )
  .prefix('/api') {}
