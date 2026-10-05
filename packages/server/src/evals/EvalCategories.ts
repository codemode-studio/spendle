/**
 * Replays the frozen category evaluation (`evals/categories`) through the
 * V2 classifier and the deterministic policy, and prints the scoreboard
 * used to choose `TYPESAFE_APPLY_THRESHOLD`. The model mode makes paid
 * TypeSafe calls, so it stays out of `pnpm verify`.
 *
 *   pnpm --filter @spendle/server eval:categories                 model
 *   pnpm --filter @spendle/server eval:categories --mode policy   patterns only, free
 *   pnpm --filter @spendle/server eval:categories --mode all      both, and combined
 */
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Console from 'effect/Console'
import * as DateTime from 'effect/DateTime'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as Command from 'effect/cli/Command'
import * as Flag from 'effect/cli/Flag'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'

import { Classifier } from '../categories/Classifier.ts'
import type { ClassifyItem } from '../categories/Classifier.ts'
import { categoryDescriptions } from '../categories/Descriptions.ts'
import { knowledgeKey } from '../categories/Patterns.ts'
import { MODEL_SUGGEST_FLOOR } from '../categories/Policy.ts'
import { policyOutcomes } from './PolicyReplay.ts'
import {
  calibration,
  combineOutcomes,
  modelOutcomes,
  recommendThreshold,
  scoreboard,
  sweep,
} from './Scoreboard.ts'
import type {
  ModelAnswer,
  Outcomes,
  Scoreboard,
  SubsetScore,
  ThresholdRow,
} from './Scoreboard.ts'

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

/** Thresholds always shown, besides the recommended one. */
const thresholds = [0.5, 0.7, 0.8, 0.9, 0.95, 0.97, 0.99]

const percent = (value: number | null) =>
  value === null ? '—' : `${(value * 100).toFixed(1)}%`

const subsetRow = (score: SubsetScore) => ({
  items: score.items,
  accuracyWhenConfident: percent(score.accuracyWhenConfident),
  coverage: percent(score.coverage),
  correctAndConfident: percent(score.correctAndConfident),
  accuracyAnyConfidence: percent(score.accuracyAnyConfidence),
})

const printBoard = Effect.fnUntraced(function* (
  title: string,
  board: Scoreboard,
  names: ReadonlyMap<string, string>,
) {
  yield* Console.log(`\n=== ${title} ===`)
  yield* Console.table({
    guessable: subsetRow(board.guessable),
    'personal convention': subsetRow(board.personalConvention),
    'all purchases': subsetRow(board.allPurchases),
  })
  yield* Console.log(
    `transfers and card payments with a category applied: ${board.movementsApplied.applied}/${board.movementsApplied.of}`,
  )
  for (const miss of board.misses.slice(0, 15))
    yield* Console.log(
      `  miss ${miss.id} ${miss.description} | expected ${names.get(miss.expected ?? '') ?? '(none)'} | applied ${names.get(miss.applied ?? '') ?? miss.applied}${miss.guessable ? '' : ' | personal convention'}`,
    )
})

const sweepRow = (row: ThresholdRow) => ({
  threshold: row.threshold,
  applied: row.applied,
  accuracyWhenConfident: percent(row.accuracyWhenConfident),
  correctAndConfident: percent(row.correctAndConfident),
  'guessable correctAndConfident': percent(row.guessableCorrectAndConfident),
  movementsApplied: row.movementsApplied,
})

const command = Command.make(
  'eval:categories',
  {
    mode: Flag.Literals('mode', ['model', 'policy', 'all']).pipe(
      Flag.withDescription(
        'model: TypeSafe answers (paid); policy: store patterns only; all: both and combined',
      ),
      Flag.withDefault('model' as const),
    ),
    target: Flag.Finite('target').pipe(
      Flag.withDescription(
        'accuracyWhenConfident a threshold must reach to be recommended',
      ),
      Flag.withDefault(0.97),
    ),
    minApplied: Flag.Int('min-applied').pipe(
      Flag.withDescription(
        'Fewest applied answers a recommended threshold must rest on',
      ),
      Flag.withDefault(30),
    ),
    threshold: Flag.Finite('threshold').pipe(
      Flag.withDescription(
        'Score at this threshold instead of the recommended one',
      ),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ mode, target, minApplied, threshold }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* path.fromFileUrl(directoryUrl)
    const { items } = yield* Schema.decodeEffect(Dataset)(
      yield* fs.readFileString(path.join(directory, 'dataset.json')),
    )
    const { categories } = yield* Schema.decodeEffect(Categories)(
      yield* fs.readFileString(path.join(directory, 'categories.json')),
    )
    const exam = items.filter((item) => item.split === 'exam')
    const context = items.filter((item) => item.split === 'context')
    const names = new Map(
      categories.map((category) => [category.id, category.name]),
    )
    const report: Record<string, unknown> = {
      examItems: exam.length,
      contextItems: context.length,
      target,
      minApplied,
    }

    const policy = policyOutcomes(
      context,
      exam,
      categories.map((category) => ({
        id: category.id,
        bucket: category.bucket,
        active: true,
        system: false,
      })),
    )
    if (mode !== 'model') {
      const board = scoreboard(exam, policy)
      yield* printBoard(
        'policy (patterns learned from the context split)',
        board,
        names,
      )
      report['policy'] = board
    }
    if (mode === 'policy') return yield* save(report)

    const classifier = yield* Classifier
    if (Option.isNone(classifier.modelVersion)) {
      yield* Console.error(
        'TYPESAFE_API_KEY is not set, so the model cannot be evaluated. Set it (in the environment or the repository .env.local) and run again, or use --mode policy to score the patterns alone.',
      )
      process.exitCode = 1
      return
    }
    const version = classifier.modelVersion.value
    yield* Console.log(
      `\nAsking ${version} about ${exam.length} movements (paid calls)…`,
    )
    const asked: ReadonlyArray<ClassifyItem> = exam.map((item) => {
      const key = knowledgeKey(item)
      return {
        pattern: key?.pattern ?? item.id,
        direction: item.amountCents < 0 ? 'expense' : 'income',
        description: item.description,
        amountCents: item.amountCents,
      }
    })
    const started = yield* DateTime.now
    const result = yield* classifier.classify(
      asked,
      categories.map((category) => ({
        ...category,
        description: categoryDescriptions[category.id],
      })),
    )
    const seconds =
      Duration.toMillis(DateTime.distance(started, yield* DateTime.now)) / 1000
    const answers = new Map<string, ModelAnswer>(
      exam.map((item, index) => [item.id, result[index]!]),
    )

    const recommended = recommendThreshold(
      exam,
      answers,
      { accuracy: target, minApplied },
      MODEL_SUGGEST_FLOOR,
    )
    const scoredAt = Option.getOrElse(
      Option.orElse(threshold, () =>
        Option.fromNullishOr(recommended?.threshold),
      ),
      () => 0.9,
    )
    yield* Console.log(`\n=== ${version} (${seconds.toFixed(1)}s) ===`)
    yield* Console.log(
      'Applied answers at each threshold (transfers count as wrong when applied):',
    )
    const rows = sweep(
      exam,
      answers,
      [...new Set([...thresholds, scoredAt])].sort((a, b) => a - b),
      MODEL_SUGGEST_FLOOR,
    )
    yield* Console.table(rows.map(sweepRow))
    yield* Console.log('Calibration (answers with a category):')
    yield* Console.table(
      calibration(exam, answers).map((row) => ({
        ...row,
        accuracy: percent(row.accuracy),
      })),
    )
    yield* Console.log(
      recommended
        ? `\nRecommended: TYPESAFE_APPLY_THRESHOLD=${recommended.threshold} for TYPESAFE_MODEL=${version.replace(/^typesafe:/, '')} (${recommended.applied} applied, ${percent(recommended.accuracyWhenConfident)} right; every higher threshold also reaches ${percent(target)}).`
        : `\nNo threshold reaches ${percent(target)} accuracyWhenConfident on ${minApplied}+ applied answers: leave TYPESAFE_APPLY_THRESHOLD unset, every answer goes to review.`,
    )
    const model = modelOutcomes(answers, scoredAt, MODEL_SUGGEST_FLOOR)
    const modelBoard = scoreboard(exam, model)
    yield* printBoard(`model at ${scoredAt}`, modelBoard, names)
    report['model'] = {
      version,
      seconds,
      scoredAt,
      recommended,
      sweep: rows,
      calibration: calibration(exam, answers),
      scoreboard: modelBoard,
      answers: Object.fromEntries(answers),
    }
    if (mode === 'all') {
      const combined: Outcomes = combineOutcomes(policy, model)
      const board = scoreboard(exam, combined)
      yield* printBoard(
        `policy, then model at ${scoredAt} (as the app runs)`,
        board,
        names,
      )
      report['combined'] = board
    }
    yield* save(report)
  }),
).pipe(
  Command.withDescription(
    'Scores the category classifier and policy against frozen human decisions',
  ),
  Command.provide(Classifier.layer.pipe(Layer.provide(FetchHttpClient.layer))),
)

/** Writes the full report under `evals/categories/results/`, outside Git. */
const save = Effect.fnUntraced(function* (report: Record<string, unknown>) {
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

command.pipe(
  Command.run({ version: '1.0.0' }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
