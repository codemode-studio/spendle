import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { assert, describe, it } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as SqlClient from 'effect/sql/SqlClient'
import * as TestClock from 'effect/testing/TestClock'

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

  it.effect('drains events one reactor appends for another', () =>
    Effect.gen(function* () {
      const handled = yield* Ref.make<ReadonlyArray<string>>([])
      const relay = Reactor.layer({
        name: 'relay',
        types: ['Request'],
        handle: () => append('Work').pipe(Effect.orDie),
      })
      const worker = Reactor.layer({
        name: 'worker',
        types: ['Work'],
        handle: (event: StoredEvent) =>
          Ref.update(handled, (all) => [...all, `Work${event.sequence}`]),
      })

      yield* Effect.gen(function* () {
        yield* append('Request')
        yield* (yield* Reactor.Reactors).drain
      }).pipe(
        Effect.provide(
          // The worker registers first, so a single pass would miss the relayed event.
          Layer.mergeAll(worker, relay).pipe(
            Layer.provideMerge(Reactor.Reactors.layer),
            Layer.provideMerge(EventLog.layer),
          ),
        ),
        Effect.scoped,
      )

      assert.deepStrictEqual(yield* Ref.get(handled), ['Work2'])
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

  it.effect('keeps processing in the background after a handler crashes', () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const done = yield* Deferred.make<void>()
      const spec = {
        name: 'crashy',
        types: ['A'],
        handle: () =>
          Effect.gen(function* () {
            const attempt = yield* Ref.updateAndGet(
              attempts,
              (count) => count + 1,
            )
            if (attempt === 1) return yield* Effect.die('handler crashed')
            yield* Deferred.succeed(done, undefined)
          }),
      }

      yield* withReactor(
        spec,
        Effect.gen(function* () {
          yield* append('A')
          // Let the retry backoff elapse without ever calling drain.
          yield* TestClock.adjust('1 second').pipe(
            Effect.repeat({ until: () => Deferred.isDoneUnsafe(done) }),
          )
          yield* Deferred.await(done)
        }),
      )

      assert.strictEqual(yield* Ref.get(attempts), 2)
    }).pipe(Effect.provide(Database)),
  )

  it.effect('forgets a reactor whose layer closed', () =>
    Effect.gen(function* () {
      const handled = yield* Ref.make<ReadonlyArray<string>>([])
      const spec = (label: string) => ({
        name: 'projection',
        types: ['A'],
        handle: (event: StoredEvent) =>
          Ref.update(handled, (all) => [...all, `${label}${event.sequence}`]),
      })
      // The registry and log outlive the first reactor, as on a hot restart.
      yield* Effect.gen(function* () {
        const context = Context.pick(
          Reactor.Reactors,
          EventLog,
          SqlClient.SqlClient,
        )(
          yield* Effect.context<
            Reactor.Reactors | EventLog | SqlClient.SqlClient
          >(),
        )
        yield* Layer.build(Reactor.layer(spec('old'))).pipe(
          Effect.provide(context),
          Effect.scoped,
        )
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(Reactor.layer(spec('new'))).pipe(
              Effect.provide(context),
            )
            yield* append('A')
            yield* (yield* Reactor.Reactors).drain
          }),
        )
      }).pipe(
        Effect.provide(
          Reactor.Reactors.layer.pipe(Layer.provideMerge(EventLog.layer)),
        ),
      )
      assert.deepStrictEqual(yield* Ref.get(handled), ['new1'])
    }).pipe(Effect.provide(Database)),
  )

  it.effect('never runs a reactor that closed during a drain', () =>
    Effect.gen(function* () {
      const handled = yield* Ref.make<ReadonlyArray<string>>([])
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const blocking = Reactor.layer({
        name: 'blocking',
        types: ['A'],
        handle: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
      })
      const projection = (label: string) =>
        Reactor.layer({
          name: 'projection',
          types: ['A'],
          handle: (event: StoredEvent) =>
            Ref.update(handled, (all) => [...all, `${label}${event.sequence}`]),
        })
      yield* Effect.gen(function* () {
        const context = Context.pick(
          Reactor.Reactors,
          EventLog,
          SqlClient.SqlClient,
        )(
          yield* Effect.context<
            Reactor.Reactors | EventLog | SqlClient.SqlClient
          >(),
        )
        const reactors = yield* Reactor.Reactors
        yield* Layer.build(blocking).pipe(Effect.provide(context))
        const old = yield* Scope.make()
        yield* Layer.buildWithScope(projection('old'), old).pipe(
          Effect.provide(context),
        )
        yield* append('A')
        // The drain has listed both reactors and waits inside the first.
        const draining = yield* Effect.forkChild(reactors.drain)
        yield* Deferred.await(entered)
        yield* Scope.close(old, Exit.void)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(draining)
        yield* Layer.build(projection('new')).pipe(Effect.provide(context))
        yield* reactors.drain
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Reactor.Reactors.layer.pipe(Layer.provideMerge(EventLog.layer)),
        ),
      )
      assert.deepStrictEqual(yield* Ref.get(handled), ['new1'])
    }).pipe(Effect.provide(Database)),
  )

  it.effect('refuses to drain inside an open transaction', () =>
    Effect.gen(function* () {
      const spec = { name: 'noop', types: ['A'], handle: () => Effect.void }
      const error = yield* withReactor(
        spec,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* append('A')
                yield* (yield* Reactor.Reactors).drain
              }),
            )
            .pipe(Effect.flip)
        }),
      )
      assert.strictEqual(error._tag, 'ReactorError')
    }).pipe(Effect.provide(Database)),
  )
})
