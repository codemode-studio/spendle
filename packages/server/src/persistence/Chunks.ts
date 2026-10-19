import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'

// A Durable Object's SQLite binds at most 100 parameters per query; this
// leaves room for the query's own.
const chunkSize = 90

/**
 * Runs `query` over `values` in chunks and joins the rows, for lookups by a
 * list of ids that has no bound (`sql.in`).
 */
export const inChunks = <V, A, E, R>(
  values: ReadonlyArray<V>,
  query: (
    chunk: Arr.NonEmptyReadonlyArray<V>,
  ) => Effect.Effect<ReadonlyArray<A>, E, R>,
) =>
  Effect.forEach(Arr.chunksOf(values, chunkSize), query).pipe(
    Effect.map(Arr.flatten),
  )
