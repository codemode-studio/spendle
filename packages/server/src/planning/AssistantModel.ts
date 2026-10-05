import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'

export interface AssistantMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

export class AssistantModelError extends Schema.TaggedError<AssistantModelError>()(
  'AssistantModelError',
  {
    reason: Schema.Literals([
      /** No `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`: the model is never called. */
      'disabled',
      /** Network failure, timeout, rate limit or overload. */
      'unavailable',
      /** The key or request was refused. */
      'rejected',
      /** The answer did not fit the requested shape. */
      'invalid_response',
    ]),
    status: Schema.optional(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.status === undefined
      ? `Assistant model ${this.reason}`
      : `Assistant model ${this.reason} (HTTP ${this.status})`
  }
}

export interface AssistantModelShape {
  /** The model answers come from; `None` when the assistant is not configured. */
  readonly model: Option.Option<string>
  /** One structured answer, decoded with `schema`. */
  readonly generate: <A, I>(request: {
    readonly name: string
    readonly system: string
    readonly messages: ReadonlyArray<AssistantMessage>
    readonly schema: Schema.Codec<A, I>
  }) => Effect.Effect<A, AssistantModelError>
}

const ChatResponse = Schema.Struct({
  choices: Schema.NonEmptyArray(
    Schema.Struct({ message: Schema.Struct({ content: Schema.String }) }),
  ),
})

/**
 * The language model behind the assistant, as V1 used it: OpenRouter's
 * chat completions with a JSON schema for the answer. Every answer is
 * decoded before use; nothing it says is stored as a decision.
 */
export class AssistantModel extends Context.Service<
  AssistantModel,
  AssistantModelShape
>()('@spendle/server/planning/AssistantModel') {
  static readonly disabled = Layer.succeed(
    AssistantModel,
    AssistantModel.of({
      model: Option.none(),
      generate: () =>
        Effect.fail(new AssistantModelError({ reason: 'disabled' })),
    }),
  )

  static readonly makeOpenRouter = (options: {
    readonly apiKey: Redacted.Redacted
    readonly model: string
    readonly baseUrl: string
  }) =>
    Effect.gen(function* () {
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl(options.baseUrl)),
        HttpClient.mapRequest(HttpClientRequest.acceptJson),
      )
      const generate = Effect.fn('AssistantModel.generate')(function* <
        A,
        I,
      >(request: {
        readonly name: string
        readonly system: string
        readonly messages: ReadonlyArray<AssistantMessage>
        readonly schema: Schema.Codec<A, I>
      }) {
        const response = yield* HttpClientRequest.post(
          '/chat/completions',
        ).pipe(
          HttpClientRequest.bearerToken(options.apiKey),
          HttpClientRequest.bodyJsonUnsafe({
            model: options.model,
            messages: [
              { role: 'system', content: request.system },
              ...request.messages,
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: request.name,
                strict: false,
                schema: Schema.toJsonSchemaDocument(request.schema).schema,
              },
            },
          }),
          http.execute,
          Effect.timeout(Duration.seconds(60)),
          Effect.mapError(
            (cause) =>
              new AssistantModelError({ reason: 'unavailable', cause }),
          ),
        )
        if (response.status === 429 || response.status >= 500)
          return yield* new AssistantModelError({
            reason: 'unavailable',
            status: response.status,
          })
        if (response.status < 200 || response.status >= 300)
          return yield* new AssistantModelError({
            reason: 'rejected',
            status: response.status,
          })
        const body = yield* HttpClientResponse.schemaBodyJson(ChatResponse)(
          response,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new AssistantModelError({ reason: 'invalid_response', cause }),
          ),
        )
        return yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(request.schema),
        )(body.choices[0].message.content).pipe(
          Effect.mapError(
            (cause) =>
              new AssistantModelError({ reason: 'invalid_response', cause }),
          ),
        )
      })
      return AssistantModel.of({
        model: Option.some(`openrouter:${options.model}`),
        generate,
      })
    })

  /**
   * Reads `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` (`provider/model`);
   * without both the assistant stays off.
   */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const apiKey = yield* Config.option(Config.Redacted('OPENROUTER_API_KEY'))
      const model = yield* Config.option(
        Config.NonEmptyString('OPENROUTER_MODEL'),
      )
      if (
        Option.isNone(apiKey) ||
        Option.isNone(model) ||
        Redacted.value(apiKey.value) === ''
      )
        return AssistantModel.disabled
      const baseUrl = yield* Config.String('OPENROUTER_API_URL').pipe(
        Config.withDefault('https://openrouter.ai/api/v1'),
      )
      return Layer.effect(
        AssistantModel,
        AssistantModel.makeOpenRouter({
          apiKey: apiKey.value,
          model: model.value,
          baseUrl,
        }),
      )
    }),
  )
}
