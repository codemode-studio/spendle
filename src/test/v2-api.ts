import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Scope from 'effect/Scope'
import * as HttpServer from 'effect/http/HttpServer'
import * as NetAddress from 'effect/net/NetAddress'

import * as Ref from 'effect/Ref'

import * as Reactor from '../../packages/server/src/events/Reactor.ts'
import { apiTest } from '../../packages/server/src/testing/ApiTest.ts'
import { FakePluggyState } from '../../packages/server/src/testing/FakePluggy.ts'
import type { FakePluggyData } from '../../packages/server/src/testing/FakePluggy.ts'

export { bank, card, tx } from '../../packages/server/src/testing/FakePluggy.ts'

/**
 * A real V2 API served in this process on a random local port, with an
 * in-memory database and a fake Pluggy. `SPENDLE_API_URL` points at it, so
 * the web app's server-side client (`v2()`) talks to it over HTTP.
 */
export async function startV2Api() {
  const scope = Scope.makeUnsafe()
  const context = await Effect.runPromise(
    Layer.buildWithScope(apiTest(), scope),
  )
  const server = Context.get(context, HttpServer.HttpServer)
  const previous = {
    url: process.env.SPENDLE_API_URL,
    token: process.env.SPENDLE_API_TOKEN,
  }
  process.env.SPENDLE_API_URL = NetAddress.formatUrlUnsafe(server.address)
  delete process.env.SPENDLE_API_TOKEN
  return {
    /** Waits until background reactors processed every event so far. */
    drain: () =>
      Effect.runPromise(
        Effect.provideContext(
          Effect.gen(function* () {
            yield* (yield* Reactor.Reactors).drain
          }),
          context,
        ),
      ),
    /** Changes what the fake Pluggy answers, as Pluggy's own state would change. */
    pluggy: (update: (current: FakePluggyData) => FakePluggyData) =>
      Effect.runPromise(
        Effect.provideContext(
          Effect.gen(function* () {
            yield* Ref.update(yield* FakePluggyState, update)
          }),
          context,
        ),
      ),
    close: async () => {
      process.env.SPENDLE_API_URL = previous.url
      if (previous.token !== undefined)
        process.env.SPENDLE_API_TOKEN = previous.token
      await Effect.runPromise(Scope.close(scope, Exit.void))
    },
  }
}

export type V2TestApi = Awaited<ReturnType<typeof startV2Api>>
