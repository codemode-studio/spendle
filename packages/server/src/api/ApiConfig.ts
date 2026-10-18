import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'

export class ApiConfigError extends Schema.TaggedError<ApiConfigError>()(
  'ApiConfigError',
  { reason: Schema.Literals(['short_token']) },
) {
  override get message(): string {
    return 'SPENDLE_API_TOKEN must have at least 32 characters'
  }
}

export interface ApiSettings {
  /** The bearer token every `/api` request must carry; `None` accepts any local caller. */
  readonly token: Option.Option<Redacted.Redacted>
}

export class ApiConfig extends Context.Service<ApiConfig, ApiSettings>()(
  '@spendle/server/api/ApiConfig',
) {
  static readonly layer = Layer.effect(
    ApiConfig,
    Effect.gen(function* () {
      const token = yield* Config.option(Config.Redacted('SPENDLE_API_TOKEN'))
      if (Option.isSome(token) && Redacted.value(token.value).length < 32)
        return yield* new ApiConfigError({ reason: 'short_token' })
      return ApiConfig.of({ token })
    }),
  )

  static readonly layerTest = (token?: string) =>
    Layer.succeed(ApiConfig, {
      token:
        token === undefined ? Option.none() : Option.some(Redacted.make(token)),
    })
}
