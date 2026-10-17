import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Ref from 'effect/Ref'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'

import { ApiConfig } from '../api/ApiConfig.ts'
import { SpendleApi } from '../api/definition/Api.ts'
import { memberHeader } from '../api/definition/Security.ts'
import { ServerConfig } from '../config.ts'
import type { ServerConfigShape } from '../config.ts'
import { PluggyClient } from '../openfinance/PluggyClient.ts'
import { WebhookConfig } from '../openfinance/WebhookConfig.ts'
import { spaceRoutes } from '../spaces/Routes.ts'
import { SpaceApps } from '../spaces/Space.ts'
import { SpaceDirectory } from '../spaces/SpaceDirectory.ts'
import { SpaceWebhooks, webhookRoutes } from '../spaces/SpaceWebhooks.ts'
import { FakePluggyState, makeFake } from './FakePluggy.ts'
import type { FakePluggyData } from './FakePluggy.ts'

export const webhookSecret = 'whsec-0123456789abcdef0123456789abcdef'

const fakePluggy = Layer.unwrap(
  Effect.gen(function* () {
    const state = yield* Ref.make<FakePluggyData>({
      clientUserId: '',
      accounts: [],
      transactions: {},
      deleted: [],
      webhooks: [],
      connectTokens: [],
    })
    return Layer.mergeAll(
      Layer.succeed(PluggyClient, makeFake(state)),
      Layer.succeed(FakePluggyState, state),
    )
  }),
)

/**
 * The server with one database per space, over a real socket and a fake
 * Pluggy. Spaces live in memory unless `config` names a data directory.
 */
export const spacesTest = (
  options: {
    readonly token?: string
    readonly config?: Partial<ServerConfigShape>
  } = {},
) =>
  HttpRouter.serve(Layer.mergeAll(spaceRoutes, webhookRoutes), {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provideMerge(SpaceWebhooks.layer),
    Layer.provideMerge(SpaceApps.layer),
    Layer.provideMerge(SpaceDirectory.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        ApiConfig.layerTest(options.token),
        WebhookConfig.layerTest(
          Option.some({
            url: 'https://spendle.example/api/pluggy/webhook',
            secret: Redacted.make(webhookSecret),
          }),
        ),
        fakePluggy,
        ServerConfig.layerTest(options.config),
      ),
    ),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(NodeServices.layer),
  )

/** The typed client the web server uses, naming `email` as the member. */
export const clientFor = (email: string, bearer?: string) =>
  HttpApiClient.make(SpendleApi, {
    transformClient: HttpClient.mapRequest((request) => {
      const named = HttpClientRequest.setHeader(request, memberHeader, email)
      return bearer === undefined
        ? named
        : HttpClientRequest.bearerToken(named, bearer)
    }),
  })
