import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Ref from 'effect/Ref'
import * as Schedule from 'effect/Schedule'
import type * as Scope from 'effect/Scope'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { EventLog } from './EventLog.ts'
import type { StoredEvent } from './EventLog.ts'

/**
 * A reactor turns events into side effects. Delivery is at-least-once: the
 * cursor advances after `handle` succeeds, so a crash between the two repeats
 * the event. Handlers must therefore be idempotent, and should keep provider
 * I/O outside their own write transactions.
 */
export interface ReactorSpec<E, R> {
  /** Stable name; it keys the durable cursor. Renaming it replays history. */
  readonly name: string
  readonly types: ReadonlyArray<string>
  readonly handle: (event: StoredEvent) => Effect.Effect<void, E, R>
}

export class ReactorError extends Schema.TaggedError<ReactorError>()(
  'ReactorError',
  {
    reactor: Schema.String,
    sequence: Schema.optional(Schema.Int),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.sequence === undefined
      ? `Reactor ${this.reactor} failed`
      : `Reactor ${this.reactor} failed on event ${this.sequence}`
  }
}

export interface ReactorsShape {
  /** Processes every event appended so far in every reactor. For tests and shutdown. */
  readonly drain: Effect.Effect<void, ReactorError>
}

const batchSize = 100
// Appends from this process wake reactors at once; the sweep covers other writers.
const sweepInterval = Duration.seconds(5)
// Exponential backoff from 1 second, capped at one attempt per minute.
const retrySchedule = Schedule.min([
  Schedule.exponential(Duration.seconds(1)),
  Schedule.spaced(Duration.minutes(1)),
])

/**
 * Whether background loops also run on timers: reactors sweeping for other
 * writers and retrying failures, Pluggy deliveries being routed again. A
 * Durable Object turns this off, since a pending timer keeps it in memory and
 * billed; its alarm finishes and retries that work instead.
 */
export const Polling = Context.Reference<boolean>(
  '@spendle/server/events/Reactor/Polling',
  { defaultValue: () => true },
)

export class Reactors extends Context.Service<
  Reactors,
  ReactorsShape & {
    /** Adds a reactor's drain until the caller's scope closes. */
    readonly register: (
      drain: Effect.Effect<void, ReactorError>,
    ) => Effect.Effect<void, never, Scope.Scope>
  }
>()('@spendle/server/events/Reactor/Reactors') {
  static readonly layer = Layer.effect(
    Reactors,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const log = yield* EventLog
      const drains = yield* Ref.make<
        ReadonlyArray<Effect.Effect<void, ReactorError>>
      >([])
      const latest = log.latestSequence.pipe(
        Effect.mapError(
          (cause) => new ReactorError({ reactor: 'drain', cause }),
        ),
      )
      // A reactor may append events another reactor handles, so passes repeat
      // until one ends with no new events.
      const drain = Effect.gen(function* () {
        // Reactors write their cursors through the single SQLite connection,
        // which an open transaction holds: draining inside one would deadlock.
        if (
          Option.isSome(yield* Effect.serviceOption(sql.transactionService))
        ) {
          return yield* new ReactorError({
            reactor: 'drain',
            cause: 'drain must run after the caller commits its transaction',
          })
        }
        let before: number
        do {
          before = yield* latest
          yield* Effect.forEach(yield* Ref.get(drains), (each) => each, {
            discard: true,
          })
        } while ((yield* latest) !== before)
      })
      return Reactors.of({
        register: (each) =>
          Effect.acquireRelease(
            Ref.update(drains, (all) => [...all, each]),
            () =>
              Ref.update(drains, (all) => all.filter((one) => one !== each)),
          ),
        drain,
      })
    }),
  )
}

const Cursor = Schema.Struct({ sequence: Schema.Int })

/** Runs `spec` in the background for the lifetime of the layer. */
export const layer = <E, R>(spec: ReactorSpec<E, R>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const log = yield* EventLog
      const reactors = yield* Reactors
      const polling = yield* Polling
      const context = yield* Effect.context<R>()
      const types = new Set(spec.types)
      const lock = yield* Semaphore.make(1)

      const readCursor = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Cursor,
        execute: (reactor) =>
          sql`SELECT sequence FROM reactor_cursors WHERE reactor = ${reactor}`,
      })

      const fail = (sequence?: number) => (cause: unknown) =>
        new ReactorError({ reactor: spec.name, sequence, cause })

      const advance = (sequence: number) =>
        Effect.gen(function* () {
          const updatedAt = DateTime.formatIso(yield* DateTime.now)
          yield* sql`
            INSERT INTO reactor_cursors (reactor, sequence, updated_at)
            VALUES (${spec.name}, ${sequence}, ${updatedAt})
            ON CONFLICT (reactor) DO UPDATE SET sequence = excluded.sequence, updated_at = excluded.updated_at
          `
        }).pipe(Effect.mapError(fail(sequence)))

      // Handles one batch and returns how many events it consumed.
      const step = Effect.gen(function* () {
        const cursor = yield* readCursor(spec.name).pipe(
          Effect.mapError(fail()),
        )
        const events = yield* log
          .readAfter(
            cursor._tag === 'Some' ? cursor.value.sequence : 0,
            batchSize,
          )
          .pipe(Effect.mapError(fail()))
        for (const event of events) {
          if (types.has(event.type)) {
            yield* spec.handle(event).pipe(
              Effect.provideContext(context),
              Effect.withSpan(`Reactor.${spec.name}`, {
                attributes: { 'event.type': event.type },
              }),
              Effect.mapError(fail(event.sequence)),
            )
          }
          yield* advance(event.sequence)
        }
        return events.length
      })

      // Once the layer closes, a drain that had already listed this reactor
      // finds it closed instead of running it with released dependencies.
      const open = yield* Ref.make(true)
      const catchUp = lock.withPermits(1)(
        Effect.gen(function* () {
          if (!(yield* Ref.get(open))) return
          while ((yield* step) > 0) {
            // keep going until the log is exhausted
          }
        }),
      )

      yield* reactors.register(catchUp)
      // Closing waits for a catch-up already running to finish.
      yield* Effect.addFinalizer(() =>
        Ref.set(open, false).pipe(
          Effect.andThen(lock.withPermits(1)(Effect.void)),
        ),
      )

      // The background loop must outlive any failure but shutdown: defects
      // (a thrown handler, a failed COMMIT) are handled like typed errors,
      // retried here or, without polling, left for the next wake or drain.
      const loggedCatchUp = catchUp.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.fail(
                new ReactorError({
                  reactor: spec.name,
                  cause: Cause.squash(cause),
                }),
              ),
        ),
        Effect.tapError((error) => Effect.logError(error.message, error.cause)),
      )
      const wake = polling
        ? log.appended.pipe(
            Stream.merge(Stream.tick(sweepInterval)),
            Stream.runForEach(() =>
              loggedCatchUp.pipe(Effect.retry(retrySchedule)),
            ),
          )
        : log.appended.pipe(
            Stream.runForEach(() => Effect.ignore(loggedCatchUp)),
          )
      yield* Effect.forkScoped(wake)
    }),
  )
