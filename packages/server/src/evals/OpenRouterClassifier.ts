/**
 * Any OpenRouter model asked the category question exactly as the production
 * classifier asks it (`makeOpenRouterRequest`), for `eval:models`.
 *
 * Evaluation only: a batch that still fails after retries leaves its items
 * unanswered instead of failing the run, since reliability is part of what
 * is measured, and the run adds up what every answer cost.
 */
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import type * as Redacted from 'effect/Redacted'

import {
  classifierBatches,
  makeOpenRouterRequest,
  retryModelRequest,
} from '../categories/Classifier.ts'
import type {
  Classification,
  ClassifierCategory,
  ClassifyItem,
  Usage,
} from '../categories/Classifier.ts'

export interface OpenRouterRun {
  /** One per item, in order; `null` when its batch never got a valid answer. */
  readonly answers: ReadonlyArray<Classification | null>
  readonly usage: Usage
  /** Why batches failed, when any did. */
  readonly failures: ReadonlyArray<string>
}

export const makeOpenRouterClassifier = (options: {
  readonly apiKey: Redacted.Redacted
  readonly model: string
  readonly baseUrl: string
}) =>
  Effect.gen(function* () {
    // Reasoning models can think for minutes before answering a batch.
    const request = yield* makeOpenRouterRequest({
      ...options,
      timeout: Duration.minutes(3),
    })

    /**
     * Fails only when OpenRouter refuses the request (a wrong key or model
     * id), since every batch would fail the same way.
     */
    const classify = Effect.fn('OpenRouterClassifier.classify')(function* (
      items: ReadonlyArray<ClassifyItem>,
      categories: ReadonlyArray<ClassifierCategory>,
    ) {
      const batches = classifierBatches(items, categories)
      const results = yield* Effect.forEach(
        batches,
        (batch) =>
          retryModelRequest(
            request(
              batch.indexes.map((index) => items[index]!),
              batch.categories,
            ),
          ).pipe(
            Effect.catchIf(
              (error) => error.reason !== 'rejected',
              (error) => Effect.succeed({ failure: error.message }),
            ),
          ),
        { concurrency: 4 },
      )
      const answers: Array<Classification | null> = items.map(() => null)
      const failures: Array<string> = []
      let usage: Usage = { promptTokens: 0, completionTokens: 0, costUsd: 0 }
      results.forEach((result, batch) => {
        if ('failure' in result) {
          failures.push(result.failure)
          return
        }
        batches[batch]!.indexes.forEach((index, position) => {
          answers[index] = result.classifications[position]!
        })
        usage = {
          promptTokens: usage.promptTokens + result.usage.promptTokens,
          completionTokens:
            usage.completionTokens + result.usage.completionTokens,
          costUsd: usage.costUsd + result.usage.costUsd,
        }
      })
      return { answers, usage, failures } satisfies OpenRouterRun
    })

    return { model: options.model, classify }
  })
