import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { assert, describe, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'

import * as Sqlite from '../persistence/Sqlite.ts'
import { EventLog } from './EventLog.ts'
import type { StoredEvent } from './EventLog.ts'
import * as Reactor from './Reactor.ts'

class HandlerFailed extends Schema.TaggedError<HandlerFailed>()(
  'HandlerFailed',
  {},
) {}

// Runs `spec` with fresh EventLog and reactor layers over the outer database, as
// a server restart would.
const withReactor = <SE, A, E, R>(
  spec: Reactor.ReactorSpec<SE, never>,
  body: Effect.Effect<A, E, R>,
) =>
  body.pipe(
    Effect.provide(
      Reactor.layer(spec).pipe(
        Layer.provideMerge(Reactor.Reactors.layer),
        Layer.provideMerge(EventLog.layer),
      ),
    ),
    Effect.scoped,
  )

const Database = Layer.mergeAll(Sqlite.layerMemory, NodeCrypto.layer)

const append = (...types: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const log = yield* EventLog
    yield* log.append(
      types.map((type) => ({ type, streamId: 's', payload: null })),
    )
  })

describe('Reactor', () => {
  it.effect('handles subscribed events once, in order, across restarts', () =>
    Effect.gen(function* () {
      const handled = yield* Ref.make<ReadonlyArray<string>>([])
      const spec = {
        name: 'collector',
        types: ['A', 'C'],
        handle: (event: StoredEvent) =>
          Ref.update(handled, (all) => [
            ...all,
            `${event.type}${event.sequence}`,
          ]),
      }

      yield* withReactor(
        spec,
        Effect.gen(function* () {
          yield* append('A', 'B', 'C')
          yield* (yield* Reactor.Reactors).drain
        }),
      )
      yield* withReactor(
        spec,
        Effect.gen(function* () {
          yield* append('A')
          yield* (yield* Reactor.Reactors).drain
        }),
      )

      assert.deepStrictEqual(yield* Ref.get(handled), ['A1', 'C3', 'A4'])
    }).pipe(Effect.provide(Database)),
  )

  it.effect('retries an event whose handler failed', () =>
    Effect.gen(function* () {
      const failing = yield* Ref.make(true)
      const handled = yield* Ref.make(0)
      const spec = {
        name: 'flaky',
        types: ['A'],
        handle: () =>
          Effect.gen(function* () {
            if (yield* Ref.get(failing)) return yield* new HandlerFailed()
            yield* Ref.update(handled, (count) => count + 1)
          }),
      }

      yield* withReactor(
        spec,
        Effect.gen(function* () {
          yield* append('A')
          const reactors = yield* Reactor.Reactors
          const error = yield* reactors.drain.pipe(Effect.flip)
          assert.strictEqual(error.sequence, 1)

          yield* Ref.set(failing, false)
          yield* reactors.drain
        }),
      )

      assert.strictEqual(yield* Ref.get(handled), 1)
    }).pipe(Effect.provide(Database)),
  )

  it.effect('reacts to new events without being drained', () =>
    Effect.gen(function* () {
      const seen = yield* Deferred.make<number>()
      const spec = {
        name: 'background',
        types: ['A'],
        handle: (event: StoredEvent) =>
          Deferred.succeed(seen, event.sequence).pipe(Effect.asVoid),
      }

      const sequence = yield* withReactor(
        spec,
        Effect.gen(function* () {
          yield* append('A')
          return yield* Deferred.await(seen)
        }),
      )

      assert.strictEqual(sequence, 1)
    }).pipe(Effect.provide(Database)),
  )
})
