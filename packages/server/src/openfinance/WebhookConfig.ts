import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'

export interface WebhookSettings {
  /** Public HTTPS URL Pluggy posts to, ending in `/api/pluggy/webhook`. */
  readonly url: string
  readonly secret: Redacted.Redacted
}

export class WebhookConfigError extends Schema.TaggedError<WebhookConfigError>()(
  'WebhookConfigError',
  { reason: Schema.Literals(['incomplete', 'not_https', 'short_secret']) },
) {
  override get message(): string {
    switch (this.reason) {
      case 'incomplete':
        return 'Set PLUGGY_WEBHOOK_URL and PLUGGY_WEBHOOK_SECRET together, or neither'
      case 'not_https':
        return 'PLUGGY_WEBHOOK_URL must use HTTPS'
      case 'short_secret':
        return 'PLUGGY_WEBHOOK_SECRET must have at least 32 characters'
    }
  }
}

/** `None` when webhooks are off; syncs then run only when requested. */
export class WebhookConfig extends Context.Service<
  WebhookConfig,
  Option.Option<WebhookSettings>
>()('@spendle/server/openfinance/WebhookConfig') {
  static readonly layer = Layer.effect(
    WebhookConfig,
    Effect.gen(function* () {
      const url = yield* Config.option(
        Config.NonEmptyString('PLUGGY_WEBHOOK_URL'),
      )
      const secret = yield* Config.option(
        Config.Redacted('PLUGGY_WEBHOOK_SECRET'),
      )
      if (Option.isNone(url) && Option.isNone(secret)) return Option.none()
      if (Option.isNone(url) || Option.isNone(secret)) {
        return yield* new WebhookConfigError({ reason: 'incomplete' })
      }
      if (!url.value.startsWith('https://'))
        return yield* new WebhookConfigError({ reason: 'not_https' })
      if (Redacted.value(secret.value).length < 32) {
        return yield* new WebhookConfigError({ reason: 'short_secret' })
      }
      return Option.some({ url: url.value, secret: secret.value })
    }),
  )

  static readonly layerTest = (settings: Option.Option<WebhookSettings>) =>
    Layer.succeed(WebhookConfig, settings)
}
