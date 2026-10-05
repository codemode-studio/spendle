import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PubSub from 'effect/PubSub'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

/**
 * An event to append. `eventId` makes the append idempotent: pass an id derived
 * from the source (for example a provider's event id) when the same fact can
 * arrive twice. Omit it to get a fresh time-ordered id.
 */
export const NewEvent = Schema.Struct({
  type: Schema.String,
  streamId: Schema.String,
  payload: Schema.Json,
  eventId: Schema.optional(Schema.String),
  correlationId: Schema.optional(Schema.String),
})
export type NewEvent = typeof NewEvent.Type

export class StoredEvent extends Schema.Class<StoredEvent>('StoredEvent')({
  sequence: Schema.Int,
  eventId: Schema.String,
  type: Schema.String,
  streamId: Schema.String,
  payload: Schema.Json,
  correlationId: Schema.NullOr(Schema.String),
  occurredAt: Schema.DateTimeUtc,
}) {}

const StoredEventRow = Schema.Struct({
  sequence: Schema.Int,
  eventId: Schema.String,
  type: Schema.String,
  streamId: Schema.String,
  payload: Schema.fromJsonString(Schema.Json),
  correlationId: Schema.NullOr(Schema.String),
  occurredAt: Schema.DateTimeUtcFromString,
}).pipe(Schema.decodeTo(StoredEvent))

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))
const LatestSequence = Schema.Struct({ sequence: Schema.NullOr(Schema.Int) })

export class EventLogError extends Schema.TaggedError<EventLogError>()(
  'EventLogError',
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Event log ${this.operation} failed`
  }
}

export interface EventLogShape {
  /** Appends in order and returns the events that were new. */
  readonly append: (
    events: ReadonlyArray<NewEvent>,
  ) => Effect.Effect<ReadonlyArray<StoredEvent>, EventLogError>
  readonly readAfter: (
    sequence: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<StoredEvent>, EventLogError>
  readonly latestSequence: Effect.Effect<number, EventLogError>
  /** Emits the latest sequence after each append that stored something. */
  readonly appended: Stream.Stream<number>
}

export class EventLog extends Context.Service<EventLog, EventLogShape>()(
  '@spendle/server/events/EventLog',
) {
  static readonly layer = Layer.effect(
    EventLog,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const crypto = yield* Crypto.Crypto
      const appends = yield* PubSub.sliding<number>(1)

      const insert = SqlSchema.findAll({
        Request: Schema.Struct({
          eventId: Schema.String,
          type: Schema.String,
          streamId: Schema.String,
          payload: Schema.String,
          correlationId: Schema.NullOr(Schema.String),
          occurredAt: Schema.String,
        }),
        Result: StoredEventRow,
        execute: (row) => sql`
          INSERT INTO domain_events (event_id, type, stream_id, payload, correlation_id, occurred_at)
          VALUES (${row.eventId}, ${row.type}, ${row.streamId}, ${row.payload}, ${row.correlationId}, ${row.occurredAt})
          ON CONFLICT (event_id) DO NOTHING
          RETURNING sequence, event_id AS eventId, type, stream_id AS streamId, payload,
            correlation_id AS correlationId, occurred_at AS occurredAt
        `,
      })

      const selectAfter = SqlSchema.findAll({
        Request: Schema.Struct({ sequence: Schema.Int, limit: Schema.Int }),
        Result: StoredEventRow,
        execute: ({ sequence, limit }) => sql`
          SELECT sequence, event_id AS eventId, type, stream_id AS streamId, payload,
            correlation_id AS correlationId, occurred_at AS occurredAt
          FROM domain_events WHERE sequence > ${sequence} ORDER BY sequence LIMIT ${limit}
        `,
      })

      const selectLatest = SqlSchema.findOne({
        Request: Schema.Void,
        Result: LatestSequence,
        execute: () => sql`SELECT max(sequence) AS sequence FROM domain_events`,
      })

      const latestSequence = selectLatest(undefined).pipe(
        Effect.map(({ sequence }) => sequence ?? 0),
        Effect.mapError(
          (cause) => new EventLogError({ operation: 'latestSequence', cause }),
        ),
      )

      const append = Effect.fn('EventLog.append')(function* (
        events: ReadonlyArray<NewEvent>,
      ) {
        const occurredAt = DateTime.formatIso(yield* DateTime.now)
        const stored: Array<StoredEvent> = []
        yield* sql
          .withTransaction(
            Effect.forEach(events, (event) =>
              Effect.gen(function* () {
                const eventId = event.eventId ?? (yield* crypto.randomUUIDv7)
                const rows = yield* insert({
                  eventId,
                  type: event.type,
                  streamId: event.streamId,
                  payload: yield* encodePayload(event.payload),
                  correlationId: event.correlationId ?? null,
                  occurredAt,
                })
                stored.push(...rows)
              }),
            ),
          )
          .pipe(
            Effect.mapError(
              (cause) => new EventLogError({ operation: 'append', cause }),
            ),
          )
        const last = stored.at(-1)
        if (last) yield* PubSub.publish(appends, last.sequence)
        return stored
      })

      const readAfter = Effect.fn('EventLog.readAfter')(
        (sequence: number, limit: number) =>
          selectAfter({ sequence, limit }).pipe(
            Effect.mapError(
              (cause) => new EventLogError({ operation: 'readAfter', cause }),
            ),
          ),
      )

      return EventLog.of({
        append,
        readAfter,
        latestSequence,
        appended: Stream.fromPubSub(appends),
      })
    }),
  )
}
