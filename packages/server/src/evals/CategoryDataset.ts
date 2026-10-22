/**
 * The frozen category evaluation (`evals/categories`), as the evaluation
 * commands read it, and where they write their full results.
 */
import * as Console from 'effect/Console'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'

const DatasetItem = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  amountCents: Schema.Int,
  currency: Schema.String,
  targetType: Schema.Literals(['account', 'card']),
  expectedCategoryId: Schema.NullOr(Schema.String),
  guessable: Schema.Boolean,
  origin: Schema.Literals(['decision', 'synthetic', 'synthetic_movement']),
  split: Schema.Literals(['context', 'exam']),
})
const Dataset = Schema.fromJsonString(
  Schema.Struct({ items: Schema.Array(DatasetItem) }),
)
const Categories = Schema.fromJsonString(
  Schema.Struct({
    categories: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        bucket: Schema.String,
      }),
    ),
  }),
)
const Json = Schema.fromJsonString(Schema.Unknown)

const directoryUrl = new URL('../../evals/categories/', import.meta.url)

/** The exam, the context split standing for past decisions, and the categories. */
export const loadCategoryDataset = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* path.fromFileUrl(directoryUrl)
  const { items } = yield* Schema.decodeEffect(Dataset)(
    yield* fs.readFileString(path.join(directory, 'dataset.json')),
  )
  const { categories } = yield* Schema.decodeEffect(Categories)(
    yield* fs.readFileString(path.join(directory, 'categories.json')),
  )
  return {
    exam: items.filter((item) => item.split === 'exam'),
    context: items.filter((item) => item.split === 'context'),
    categories,
    names: new Map(categories.map((category) => [category.id, category.name])),
  }
})

/** Writes a full report under `evals/categories/results/`, outside Git. */
export const saveCategoryResults = Effect.fnUntraced(function* (
  report: Record<string, unknown>,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const now = DateTime.formatIso(yield* DateTime.now)
  const directory = path.join(yield* path.fromFileUrl(directoryUrl), 'results')
  yield* fs.makeDirectory(directory, { recursive: true })
  const file = path.join(directory, `${now.replace(/[:.]/g, '-')}.json`)
  yield* fs.writeFileString(
    file,
    yield* Schema.encodeEffect(Json)({ ranAt: now, ...report }),
  )
  yield* Console.log(`\nFull results: ${file}`)
})
