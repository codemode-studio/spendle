import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'

import { Categories } from '../../categories/Categories.ts'
import { Categorizer } from '../../categories/Categorizer.ts'
import { KnowledgeStore } from '../../categories/KnowledgeStore.ts'
import { builtInProviderCategories } from '../../categories/ProviderCategories.ts'
import { Reactors, settled } from '../../events/Reactor.ts'
import { SpendleApi } from '../definition/Api.ts'
import { respond } from '../Failures.ts'
import { ReadModel } from '../ReadModel.ts'

export const CategoriesHandlers = HttpApiBuilder.group(
  SpendleApi,
  'categories',
  Effect.fn(function* (handlers) {
    const categories = yield* Categories
    return handlers.handleAll({
      list: ({ query }) =>
        categories.list.pipe(
          Effect.map((list) =>
            query.includeArchived
              ? list
              : list.filter((category) => category.active),
          ),
          respond('categories.list'),
        ),
      create: ({ payload }) =>
        categories.create(payload).pipe(respond('categories.create')),
      update: ({ params, payload }) =>
        categories
          .update(params.categoryId, payload)
          .pipe(respond('categories.update')),
      archive: ({ params }) =>
        categories
          .archive(params.categoryId)
          .pipe(respond('categories.archive')),
    })
  }),
)

export const CategoryStoreHandlers = HttpApiBuilder.group(
  SpendleApi,
  'categoryStore',
  Effect.fn(function* (handlers) {
    const store = yield* KnowledgeStore
    const categorizer = yield* Categorizer
    const reads = yield* ReadModel
    // The categorizer reapplies an edited store in a reactor; edits answer once it did.
    const settle = settled(yield* Reactors)
    return handlers.handleAll({
      patterns: () => store.list.pipe(respond('categoryStore.patterns')),
      preview: ({ payload }) =>
        Effect.gen(function* () {
          const changes = yield* categorizer.previewStoreEdit(payload.edit)
          const entries = yield* reads.entriesById(
            changes.map((change) => change.entryId),
          )
          return changes.map((change) => ({
            ...change,
            entry: entries.get(change.entryId) ?? null,
          }))
        }).pipe(respond('categoryStore.preview')),
      edit: ({ payload }) =>
        store.edit(payload.edit).pipe(
          settle,
          Effect.map((patternId) => ({ patternId })),
          respond('categoryStore.edit'),
        ),
      providerMappings: () =>
        store.rows.pipe(
          Effect.map((rows) => [
            ...rows.flatMap((row) => {
              if (row.kind !== 'provider_category') return []
              const separator = row.pattern.indexOf(':')
              return [
                {
                  provider: row.pattern.slice(0, separator),
                  providerCategory: row.pattern.slice(separator + 1),
                  categoryId: row.categoryId,
                  source: 'person' as const,
                },
              ]
            }),
            ...[...builtInProviderCategories].map(
              ([providerCategory, categoryId]) => ({
                provider: 'pluggy',
                providerCategory,
                categoryId,
                source: 'built_in' as const,
              }),
            ),
          ]),
          respond('categoryStore.providerMappings'),
        ),
    })
  }),
)

export const CategoryDecisionsHandlers = HttpApiBuilder.group(
  SpendleApi,
  'categoryDecisions',
  Effect.fn(function* (handlers) {
    const categorizer = yield* Categorizer
    // A decision rebuilds inferences as it commits; settling covers what its
    // events start (relations' categories, a store change), and the
    // explanation is read after both.
    const settle = settled(yield* Reactors)
    const then =
      (entryId: string) =>
      <A, E, R>(decided: Effect.Effect<A, E, R>) =>
        settle(decided).pipe(Effect.andThen(categorizer.explain(entryId)))
    return handlers.handleAll({
      review: () =>
        categorizer.reviewQueue.pipe(respond('categoryDecisions.review')),
      explain: ({ params }) =>
        categorizer
          .explain(params.entryId)
          .pipe(respond('categoryDecisions.explain')),
      decide: ({ params, payload }) =>
        categorizer
          .decide(params.entryId, payload.categoryId, {
            origin: 'transaction_list',
            ...(payload.learn === undefined ? {} : { learn: payload.learn }),
          })
          .pipe(then(params.entryId), respond('categoryDecisions.decide')),
      confirm: ({ params }) =>
        categorizer
          .confirm(params.entryId)
          .pipe(then(params.entryId), respond('categoryDecisions.confirm')),
      correct: ({ params, payload }) =>
        categorizer
          .correct(params.entryId, payload.categoryId)
          .pipe(then(params.entryId), respond('categoryDecisions.correct')),
      undo: ({ params }) =>
        categorizer
          .undo(params.entryId)
          .pipe(then(params.entryId), respond('categoryDecisions.undo')),
    })
  }),
)
