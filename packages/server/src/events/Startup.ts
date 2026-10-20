import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as SqlClient from 'effect/sql/SqlClient'

/**
 * The deployment this server runs, when the platform names one: the Worker
 * version on Cloudflare, which changes with the code and with every variable
 * or secret. Node and tests name none.
 */
export const Deployment = Context.Reference<Option.Option<string>>(
  '@spendle/server/events/Startup/Deployment',
  { defaultValue: () => Option.none() },
)

/**
 * Runs `work` on start unless this deployment already finished it, for work
 * that depends only on code and configuration (rebuilding projections,
 * subscribing to Pluggy). A Durable Object starts again after every
 * hibernation, many times between deploys; a Node process starts once, so
 * without a deployment the work runs on every start. A failed run leaves no
 * mark and is tried again on the next start.
 */
export const oncePerDeployment = <A, E, R>(
  task: string,
  work: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const deployment = yield* Deployment
    if (Option.isNone(deployment)) {
      yield* work
      return
    }
    const sql = yield* SqlClient.SqlClient
    const done = yield* sql`
      SELECT 1 FROM startup_marks WHERE task = ${task} AND deployment = ${deployment.value}
    `
    if (done.length > 0) return
    yield* work
    yield* sql`
      INSERT INTO startup_marks (task, deployment) VALUES (${task}, ${deployment.value})
      ON CONFLICT (task) DO UPDATE SET deployment = excluded.deployment
    `
  })
