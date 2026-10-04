import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'

import type { Direction } from './Patterns.ts'
import { fitsDirection } from './Policy.ts'

/** A merchant the store knows nothing about, as the model sees it. */
export interface ClassifyItem {
  readonly pattern: string
  readonly direction: Direction
  /** An example description of the merchant. */
  readonly description: string
  readonly amountCents: number
}

/** A category the model may choose. */
export interface ClassifierCategory {
  readonly id: string
  readonly name: string
  readonly bucket: string
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
        for (const category of categories) criteria[category.id] = category.name
        const questions: Record<string, unknown> = {}
        items.forEach((_, index) => {
          questions[`t${index}`] = {
            type: 'choice',
            instructions: `Which category of a Brazilian family's personal finances best describes the transaction \`transactions[${index}]\`? Judge by who was paid or who paid, as the bank statement names them.`,
            criteria,
          }
        })
        const response = yield* HttpClientRequest.post('/v1/systemone').pipe(
          HttpClientRequest.bearerToken(options.apiKey),
          HttpClientRequest.bodyJsonUnsafe({
            model: options.model,
            state: {
              transactions: items.map((item) => ({
                description: item.description,
                amount: formatAmount(item.amountCents),
                direction:
                  item.direction === 'income'
                    ? 'money received'
                    : 'money spent',
              })),
            },
            questions,
          }),
          http.execute,
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
        const answers = new Map<number, Classification>()
        for (const direction of ['expense', 'income'] as const) {
          const indexed = items
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => item.direction === direction)
          const options = categories.filter((category) =>
            fitsDirection(category.bucket, direction),
          )
          for (let start = 0; start < indexed.length; start += batchSize) {
            const batch = indexed.slice(start, start + batchSize)
            const result = yield* ask(
              batch.map(({ item }) => item),
              options,
            ).pipe(
              Effect.retry({
                while: (error) => error.reason === 'unavailable',
                schedule: Schedule.exponential(Duration.seconds(1)),
                times: 3,
              }),
            )
            batch.forEach(({ index }, position) =>
              answers.set(index, result[position]!),
            )
          }
        }
        return items.map((_, index) => answers.get(index)!)
      })

      return Classifier.of({
        modelVersion: Option.some(`typesafe:${options.model}`),
        classify,
      })
    })

  /**
   * Reads `TYPESAFE_API_KEY` (and optionally `TYPESAFE_MODEL`,
   * `TYPESAFE_API_URL`); without a key the classifier is disabled.
   */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const apiKey = yield* Config.option(Config.Redacted('TYPESAFE_API_KEY'))
      if (Option.isNone(apiKey)) return Classifier.disabled
      const model = yield* Config.String('TYPESAFE_MODEL').pipe(
        Config.withDefault('jev-latest'),
      )
      const baseUrl = yield* Config.String('TYPESAFE_API_URL').pipe(
        Config.withDefault('https://api.typesafe.ai'),
      )
      return Layer.effect(
        Classifier,
        Classifier.makeTypeSafe({ apiKey: apiKey.value, model, baseUrl }),
      )
    }),
  )
}
