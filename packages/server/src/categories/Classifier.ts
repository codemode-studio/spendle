import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type * as Redacted from 'effect/Redacted'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'

import type { ClassifierExample } from './Examples.ts'
import type { Direction } from './Patterns.ts'
import {
  fitsDirection,
  MODEL_APPLY_THRESHOLD,
  MODEL_SUGGEST_FLOOR,
} from './Policy.ts'

/** A merchant the store knows nothing about, as the model sees it. */
export interface ClassifyItem {
  readonly pattern: string
  readonly direction: Direction
  /** An example description of the merchant. */
  readonly description: string
  readonly amountCents: number
  /**
   * The person's own decisions about similar merchants (see `Examples.ts`);
   * the cached answer is keyed by them, so they must be exactly what the
   * model sees.
   */
  readonly examples?: ReadonlyArray<ClassifierExample> | undefined
}

/** A category the model may choose. */
export interface ClassifierCategory {
  readonly id: string
  readonly name: string
  readonly bucket: string
  /** What the category covers, beside its name; see `Descriptions.ts`. */
  readonly description?: string | undefined
}

/** The model's answer for one item: `null` when nothing fits. */
export interface Classification {
  readonly categoryId: string | null
  readonly probability: number
}

export class ClassifierError extends Schema.TaggedError<ClassifierError>()(
  'ClassifierError',
  {
    reason: Schema.Literals([
      /** No `TYPESAFE_API_KEY`: the model is never called. */
      'disabled',
      /** Network failure, rate limit or overload; retried on the next change. */
      'unavailable',
      /** The key or request was refused; check `TYPESAFE_API_KEY`. */
      'rejected',
      'invalid_response',
    ]),
    status: Schema.optional(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.status === undefined
      ? `Classifier ${this.reason}`
      : `Classifier ${this.reason} (HTTP ${this.status})`
  }
}

export interface ClassifierShape {
  /** What answers are cached under; `None` when the model is disabled. */
  readonly modelVersion: Option.Option<string>
  /**
   * From this probability an answer is applied instead of sent to review;
   * infinite (always review) unless `TYPESAFE_APPLY_THRESHOLD` is set.
   */
  readonly applyThreshold: number
  /** One answer per item, in order, choosing among the categories that fit its direction. */
  readonly classify: (
    items: ReadonlyArray<ClassifyItem>,
    categories: ReadonlyArray<ClassifierCategory>,
  ) => Effect.Effect<ReadonlyArray<Classification>, ClassifierError>
}

const ChoiceAnswer = Schema.Struct({
  type: Schema.Literal('choice'),
  choice: Schema.String,
  probabilities: Schema.Record(Schema.String, Schema.Number),
})
const SystemOneResponse = Schema.Struct({
  answers: Schema.Record(Schema.String, ChoiceAnswer),
})

/** The choice for "no category fits"; never a category id (those have no `:`). */
const noCategory = 'none:no_category_fits'
/** Questions per request, to keep each one well within the API's limits. */
const batchSize = 25
/** Requests in flight at once, well below the API's rate limit. */
const concurrency = 4
/** One request answers in seconds; past this it counts as unavailable. */
const requestTimeout = Duration.seconds(30)

/** The Jev version the threshold is chosen for; see `evals/categories`. */
export const defaultModel = 'jev-1.13.0'

/**
 * Raised only after `vp run --filter @spendle/server eval:categories` shows
 * answers at or above it right often enough; never below the suggest floor.
 */
const ApplyThreshold = Config.schema(
  Schema.Finite.check(
    Schema.isBetween({ minimum: MODEL_SUGGEST_FLOOR, maximum: 1 }),
  ),
  'TYPESAFE_APPLY_THRESHOLD',
)

const formatAmount = (amountCents: number) =>
  `R$ ${(Math.abs(amountCents) / 100).toFixed(2).replace('.', ',')}`

export class Classifier extends Context.Service<Classifier, ClassifierShape>()(
  '@spendle/server/categories/Classifier',
) {
  /** Never calls out; every movement without a rule stays uncategorised. */
  static readonly disabled = Layer.succeed(
    Classifier,
    Classifier.of({
      modelVersion: Option.none(),
      applyThreshold: MODEL_APPLY_THRESHOLD,
      classify: () => Effect.fail(new ClassifierError({ reason: 'disabled' })),
    }),
  )

  /**
   * TypeSafe's System One API: a typed choice over the categories that fit
   * each movement's direction, with its probability.
   */
  static readonly makeTypeSafe = (options: {
    readonly apiKey: Redacted.Redacted
    readonly model: string
    readonly baseUrl: string
    readonly applyThreshold?: number
  }) =>
    Effect.gen(function* () {
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl(options.baseUrl)),
        HttpClient.mapRequest(HttpClientRequest.acceptJson),
      )

      const ask = Effect.fnUntraced(function* (
        items: ReadonlyArray<ClassifyItem>,
        categories: ReadonlyArray<ClassifierCategory>,
      ) {
        const criteria: Record<string, string> = {
          [noCategory]:
            'None of the listed categories fits this transaction, or the description says too little to tell.',
        }
        for (const category of categories)
          criteria[category.id] = category.description
            ? `${category.name}: ${category.description}`
            : category.name
        const names = new Map(
          categories.map((category) => [category.id, category.name]),
        )
        const transactions = items.map((item) => {
          // Only categories offered for this direction, by the name the
          // criteria begin with.
          const pastDecisions = (item.examples ?? []).flatMap((example) => {
            const category = names.get(example.categoryId)
            return category === undefined
              ? []
              : [{ description: example.description, category }]
          })
          return {
            description: item.description,
            amount: formatAmount(item.amountCents),
            direction:
              item.direction === 'income' ? 'money received' : 'money spent',
            ...(pastDecisions.length > 0 ? { pastDecisions } : {}),
          }
        })
        const questions: Record<string, unknown> = {}
        transactions.forEach((transaction, index) => {
          const base = `Which category of a Brazilian family's personal finances best describes the transaction \`transactions[${index}]\`? Judge by who was paid or who paid, as the bank statement names them.`
          questions[`t${index}`] = {
            type: 'choice',
            instructions:
              'pastDecisions' in transaction
                ? `${base} \`transactions[${index}].pastDecisions\` shows how this family categorized similar transactions before; when the same payee or the same kind of payment appears there, follow their choice.`
                : base,
            criteria,
          }
        })
        const response = yield* HttpClientRequest.post('/v1/systemone').pipe(
          HttpClientRequest.bearerToken(options.apiKey),
          HttpClientRequest.bodyJsonUnsafe({
            model: options.model,
            state: { transactions },
            questions,
          }),
          http.execute,
          Effect.timeout(requestTimeout),
          Effect.mapError(
            (cause) => new ClassifierError({ reason: 'unavailable', cause }),
          ),
        )
        if (response.status === 429 || response.status >= 500)
          return yield* new ClassifierError({
            reason: 'unavailable',
            status: response.status,
          })
        if (response.status < 200 || response.status >= 300)
          return yield* new ClassifierError({
            reason: 'rejected',
            status: response.status,
          })
        const { answers } = yield* HttpClientResponse.schemaBodyJson(
          SystemOneResponse,
        )(response).pipe(
          Effect.mapError(
            (cause) =>
              new ClassifierError({ reason: 'invalid_response', cause }),
          ),
        )
        return yield* Effect.forEach(items, (_, index) => {
          const answer = answers[`t${index}`]
          if (answer === undefined || !(answer.choice in criteria))
            return Effect.fail(
              new ClassifierError({ reason: 'invalid_response' }),
            )
          return Effect.succeed<Classification>({
            categoryId: answer.choice === noCategory ? null : answer.choice,
            probability: answer.probabilities[answer.choice] ?? 0,
          })
        })
      })

      const classify = Effect.fn('Classifier.classify')(function* (
        items: ReadonlyArray<ClassifyItem>,
        categories: ReadonlyArray<ClassifierCategory>,
      ) {
        const batches: Array<{
          readonly indexed: ReadonlyArray<{
            readonly item: ClassifyItem
            readonly index: number
          }>
          readonly options: ReadonlyArray<ClassifierCategory>
        }> = []
        for (const direction of ['expense', 'income'] as const) {
          const indexed = items
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => item.direction === direction)
          const options = categories.filter((category) =>
            fitsDirection(category.bucket, direction),
          )
          for (let start = 0; start < indexed.length; start += batchSize)
            batches.push({
              indexed: indexed.slice(start, start + batchSize),
              options,
            })
        }
        const results = yield* Effect.forEach(
          batches,
          ({ indexed, options }) =>
            ask(
              indexed.map(({ item }) => item),
              options,
            ).pipe(
              Effect.retry({
                while: (error) => error.reason === 'unavailable',
                schedule: Schedule.exponential(Duration.seconds(1)),
                times: 3,
              }),
            ),
          { concurrency },
        )
        const answers = new Map<number, Classification>()
        batches.forEach(({ indexed }, batch) =>
          indexed.forEach(({ index }, position) =>
            answers.set(index, results[batch]![position]!),
          ),
        )
        return items.map((_, index) => answers.get(index)!)
      })

      return Classifier.of({
        modelVersion: Option.some(`typesafe:${options.model}`),
        applyThreshold: options.applyThreshold ?? MODEL_APPLY_THRESHOLD,
        classify,
      })
    })

  /**
   * Reads `TYPESAFE_API_KEY` (and optionally `TYPESAFE_MODEL`,
   * `TYPESAFE_API_URL`, `TYPESAFE_APPLY_THRESHOLD`); without a key the
   * classifier is disabled. The model defaults to a pinned version: an
   * alias such as `jev-latest` moves, and both the cached answers and the
   * threshold chosen from the evaluation belong to one version.
   */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const apiKey = yield* Config.option(Config.Redacted('TYPESAFE_API_KEY'))
      if (Option.isNone(apiKey)) return Classifier.disabled
      const model = yield* Config.String('TYPESAFE_MODEL').pipe(
        Config.withDefault(defaultModel),
      )
      const baseUrl = yield* Config.String('TYPESAFE_API_URL').pipe(
        Config.withDefault('https://api.typesafe.ai'),
      )
      const applyThreshold = yield* Config.option(ApplyThreshold)
      return Layer.effect(
        Classifier,
        Classifier.makeTypeSafe({
          apiKey: apiKey.value,
          model,
          baseUrl,
          applyThreshold: Option.getOrElse(
            applyThreshold,
            () => MODEL_APPLY_THRESHOLD,
          ),
        }),
      )
    }),
  )
}
