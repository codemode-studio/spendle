import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'

import { Classifier } from '../categories/Classifier.ts'
import type { Classification, ClassifyItem } from '../categories/Classifier.ts'

/** Every item the fake model was asked about, in order. */
export class FakeClassifierCalls extends Context.Service<
  FakeClassifierCalls,
  Ref.Ref<ReadonlyArray<ClassifyItem>>
>()('@spendle/server/testing/FakeClassifier/FakeClassifierCalls') {}

/**
 * A model that answers from a script keyed by merchant pattern; anything
 * unscripted gets "no category fits".
 */
export const fakeClassifier = (
  script: Readonly<Record<string, Classification>>,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const asked = yield* Ref.make<ReadonlyArray<ClassifyItem>>([])
      return Layer.mergeAll(
        Layer.succeed(FakeClassifierCalls, asked),
        Layer.succeed(
          Classifier,
          Classifier.of({
            modelVersion: Option.some('fake-model'),
            classify: (items) =>
              Ref.update(asked, (all) => [...all, ...items]).pipe(
                Effect.as(
                  items.map(
                    (item) =>
                      script[item.pattern] ?? {
                        categoryId: null,
                        probability: 0.9,
                      },
                  ),
                ),
              ),
          }),
        ),
      )
    }),
  )
