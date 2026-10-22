/**
 * Asks several models the category exam (`evals/categories`) and prints them
 * side by side: how often each is right, how honest its confidence is, how
 * much it could apply without review, and what it costs. Any OpenRouter
 * model is asked exactly as the production classifier asks GPT-6 Luna; Jev
 * answers through TypeSafe, which production used before. Every model makes
 * paid calls, so this stays out of `vp run verify`.
 *
 *   vp run --filter @spendle/server eval:models \
 *     --model openai/gpt-6-luna --model typesafe:jev-1.13.0
 *
 * Each model sees the same questions the server would send, with the
 * context split as the person's past decisions (`--no-examples` without).
 */
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Config from 'effect/Config'
import * as Console from 'effect/Console'
import * as DateTime from 'effect/DateTime'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Command from 'effect/cli/Command'
import * as Flag from 'effect/cli/Flag'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'

import { Classifier } from '../categories/Classifier.ts'
import type { Classification, Usage } from '../categories/Classifier.ts'
import { categoryDescriptions } from '../categories/Descriptions.ts'
import { MODEL_SUGGEST_FLOOR } from '../categories/Policy.ts'
import { loadCategoryDataset, saveCategoryResults } from './CategoryDataset.ts'
import { modelQuestions } from './ModelReplay.ts'
import { makeOpenRouterClassifier } from './OpenRouterClassifier.ts'
import {
  calibration,
  calibrationError,
  modelOutcomes,
  recommendThreshold,
  scoreboard,
} from './Scoreboard.ts'
import type { ModelAnswer } from './Scoreboard.ts'

const typesafePrefix = 'typesafe:'

/** What one model answered, and what that took. */
interface Run {
  readonly model: string
  readonly answers: ReadonlyArray<Classification | null>
  readonly seconds: number
  /** `null` where the provider does not report it (TypeSafe). */
  readonly usage: Usage | null
  readonly failures: ReadonlyArray<string>
}

const percent = (value: number | null) =>
  value === null ? '—' : `${(value * 100).toFixed(1)}%`

const command = Command.make(
  'eval:models',
  {
    models: Flag.String('model').pipe(
      Flag.atLeast(1),
      Flag.withDescription(
        'typesafe:<Jev version> or an OpenRouter model id (anthropic/claude-haiku-5.5); repeat to compare',
      ),
    ),
    target: Flag.Finite('target').pipe(
      Flag.withDescription(
        'accuracyWhenConfident a threshold must reach for answers to be applied without review',
      ),
      Flag.withDefault(0.97),
    ),
    minApplied: Flag.Int('min-applied').pipe(
      Flag.withDescription(
        'Fewest applied answers a recommended threshold must rest on',
      ),
      Flag.withDefault(30),
    ),
    noExamples: Flag.Boolean('no-examples').pipe(
      Flag.withDescription(
        'Ask without the context split as past decisions, to compare',
      ),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ models, target, minApplied, noExamples }) {
    const { exam, context, categories } = yield* loadCategoryDataset()
    const asked = modelQuestions(context, exam, { examples: !noExamples })
    const offered = categories.map((category) => ({
      ...category,
      description: categoryDescriptions[category.id],
    }))

    const typesafeKey = yield* Config.option(
      Config.Redacted('TYPESAFE_API_KEY'),
    )
    const openRouterKey = yield* Config.option(
      Config.Redacted('OPENROUTER_API_KEY'),
    )
    const missing = models.flatMap((model) =>
      model.startsWith(typesafePrefix)
        ? Option.isNone(typesafeKey)
          ? [`${model} needs TYPESAFE_API_KEY`]
          : []
        : Option.isNone(openRouterKey)
          ? [`${model} needs OPENROUTER_API_KEY`]
          : [],
    )
    if (missing.length > 0) {
      for (const problem of missing) yield* Console.error(problem)
      yield* Console.error(
        'Set the keys in the environment or the repository .env.local and run again.',
      )
      process.exitCode = 1
      return
    }

    const askModel = Effect.fnUntraced(function* (model: string) {
      if (model.startsWith(typesafePrefix)) {
        const classifier = yield* Classifier.makeTypeSafe({
          apiKey: Option.getOrThrow(typesafeKey),
          model: model.slice(typesafePrefix.length),
          baseUrl: yield* Config.String('TYPESAFE_API_URL').pipe(
            Config.withDefault('https://api.typesafe.ai'),
          ),
        })
        return yield* classifier.classify(asked, offered).pipe(
          Effect.map((answers) => ({
            answers,
            usage: null,
            failures: [],
          })),
          // TypeSafe fails a whole run at once; it scores as unanswered.
          Effect.catch((error) =>
            Effect.succeed({
              answers: asked.map(() => null),
              usage: null,
              failures: [error.message],
            }),
          ),
        )
      }
      const classifier = yield* makeOpenRouterClassifier({
        apiKey: Option.getOrThrow(openRouterKey),
        model,
        baseUrl: yield* Config.String('OPENROUTER_API_URL').pipe(
          Config.withDefault('https://openrouter.ai/api/v1'),
        ),
      })
      return yield* classifier.classify(asked, offered).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            answers: asked.map(() => null),
            usage: null,
            failures: [error.message],
          }),
        ),
      )
    })

    const runs: Array<Run> = []
    for (const model of models) {
      yield* Console.log(
        `Asking ${model} about ${exam.length} movements${noExamples ? ' without past decisions' : ''} (paid calls)…`,
      )
      const started = yield* DateTime.now
      const result = yield* askModel(model)
      const seconds =
        Duration.toMillis(DateTime.distance(started, yield* DateTime.now)) /
        1000
      runs.push({ model, seconds, ...result })
      for (const failure of result.failures)
        yield* Console.error(`  ${model}: ${failure}`)
    }

    const scored = runs.map((run) => {
      // An unanswered item counts as "no category": never right, never applied.
      const answers = new Map<string, ModelAnswer>(
        exam.map((item, index) => [
          item.id,
          run.answers[index] ?? { categoryId: null, probability: 0 },
        ]),
      )
      const everything = scoreboard(
        exam,
        modelOutcomes(answers, MODEL_SUGGEST_FLOOR, MODEL_SUGGEST_FLOOR),
      )
      const recommended = recommendThreshold(
        exam,
        answers,
        { accuracy: target, minApplied },
        MODEL_SUGGEST_FLOOR,
      )
      return {
        run,
        answers,
        everything,
        recommended,
        calibrationError: calibrationError(exam, answers),
        calibration: calibration(exam, answers),
        unanswered: run.answers.filter((answer) => answer === null).length,
      }
    })

    yield* Console.log(
      `\n=== ${exam.length} movements, ${noExamples ? 'no past decisions' : 'with past decisions'} ===`,
    )
    yield* Console.table(
      Object.fromEntries(
        scored.map((result) => [
          result.run.model,
          {
            'right (guessable)': percent(
              result.everything.guessable.accuracyAnyConfidence,
            ),
            'right (all purchases)': percent(
              result.everything.allPurchases.accuracyAnyConfidence,
            ),
            'transfers given a category': `${result.everything.movementsApplied.applied}/${result.everything.movementsApplied.of}`,
            'calibration error': result.calibrationError?.toFixed(3) ?? '—',
            [`threshold for ${percent(target)}`]:
              result.recommended?.threshold ?? '—',
            'right without review': percent(
              result.recommended?.correctAndConfident ?? 0,
            ),
            unanswered: result.unanswered,
            seconds: result.run.seconds.toFixed(1),
            'cost USD': result.run.usage?.costUsd.toFixed(4) ?? '—',
            'USD per 1k': result.run.usage
              ? ((result.run.usage.costUsd / exam.length) * 1000).toFixed(2)
              : '—',
          },
        ]),
      ),
    )
    yield* Console.log(
      '\nHow often answers in each confidence band are right (answers · right):',
    )
    yield* Console.table(
      Object.fromEntries(
        (scored[0]?.calibration ?? []).map((band, index) => [
          band.probability,
          Object.fromEntries(
            scored.map((result) => {
              const row = result.calibration[index]!
              return [
                result.run.model,
                row.answers === 0
                  ? '—'
                  : `${row.answers} · ${percent(row.accuracy)}`,
              ]
            }),
          ),
        ]),
      ),
    )
    yield* saveCategoryResults({
      kind: 'models',
      examItems: exam.length,
      examples: !noExamples,
      target,
      minApplied,
      models: scored.map((result) => ({
        model: result.run.model,
        seconds: result.run.seconds,
        usage: result.run.usage,
        failures: result.run.failures,
        unanswered: result.unanswered,
        calibrationError: result.calibrationError,
        calibration: result.calibration,
        recommended: result.recommended,
        scoreboard: result.everything,
        answers: Object.fromEntries(result.answers),
      })),
    })
  }),
).pipe(
  Command.withDescription(
    'Compares category models on the frozen exam: accuracy, calibration, cost',
  ),
)

command.pipe(
  Command.run({ version: '1.0.0' }),
  Effect.provide([NodeServices.layer, FetchHttpClient.layer]),
  NodeRuntime.runMain,
)
