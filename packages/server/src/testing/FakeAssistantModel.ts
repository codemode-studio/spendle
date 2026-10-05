import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import {
  AssistantModel,
  AssistantModelError,
} from '../planning/AssistantModel.ts'
import type { AssistantMessage } from '../planning/AssistantModel.ts'

/**
 * A model that answers from a script by request name; the answer is decoded
 * with the request's schema, as a real answer would be. Unscripted
 * requests fail as an unavailable model.
 */
export const fakeAssistantModel = (
  script: Readonly<
    Record<string, (messages: ReadonlyArray<AssistantMessage>) => unknown>
  >,
) =>
  Layer.succeed(
    AssistantModel,
    AssistantModel.of({
      model: Option.some('fake-model'),
      generate: (request) => {
        const answer = script[request.name]
        if (answer === undefined)
          return Effect.fail(new AssistantModelError({ reason: 'unavailable' }))
        return Schema.decodeUnknownEffect(request.schema)(
          answer(request.messages),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new AssistantModelError({ reason: 'invalid_response', cause }),
          ),
        )
      },
    }),
  )
