import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'

import * as Sqlite from '../persistence/Sqlite.ts'
import { Deployment, oncePerDeployment } from './Startup.ts'

const under = (deployment: string | undefined) =>
  Effect.provideService(Deployment, Option.fromNullishOr(deployment))

describe('oncePerDeployment', () => {
  it.effect('runs once per deployment, and on every start without one', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make(0)
      const start = oncePerDeployment(
        'rebuild',
        Ref.update(runs, (n) => n + 1),
      )

      yield* start.pipe(under('v1'))
      yield* start.pipe(under('v1'))
      const sameDeployment = yield* Ref.get(runs)
      yield* start.pipe(under('v2'))
      const nextDeployment = yield* Ref.get(runs)
      yield* start.pipe(under(undefined))
      yield* start.pipe(under(undefined))

      assert.deepStrictEqual(
        [sameDeployment, nextDeployment, yield* Ref.get(runs)],
        [1, 2, 4],
      )
    }).pipe(Effect.provide(Sqlite.layerMemory)),
  )

  it.effect('tries a failed run again on the next start', () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make(0)
      const flaky = Ref.updateAndGet(runs, (n) => n + 1).pipe(
        Effect.flatMap((n) =>
          n === 1 ? Effect.fail('Pluggy down') : Effect.void,
        ),
      )
      const start = oncePerDeployment('subscribe', flaky).pipe(under('v1'))

      const first = yield* start.pipe(Effect.flip)
      yield* start
      yield* start

      assert.deepStrictEqual([first, yield* Ref.get(runs)], ['Pluggy down', 2])
    }).pipe(Effect.provide(Sqlite.layerMemory)),
  )
})
