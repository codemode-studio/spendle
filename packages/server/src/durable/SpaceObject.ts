import * as Context from 'effect/Context'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import type * as SqlClient from 'effect/sql/SqlClient'

import { Reactors } from '../events/Reactor.ts'
import * as Database from '../persistence/Database.ts'
import { SpaceApp, spaceLive } from '../spaces/Space.ts'
import * as Questions from '../spaces/SpaceGateway.ts'
import * as Platform from './Platform.ts'

/**
 * One family space as a Durable Object runs it: the same services, reactors
 * and API a space has on Node, over the object's own SQLite storage. Built
 * once per object instance and kept until the runtime evicts it; events
 * appended meanwhile are handled in the background, and `drain` finishes
 * whatever is left (the object's alarm calls it).
 */
export const makeSpaceObject = <E>(
  database: Layer.Layer<SqlClient.SqlClient, E>,
) => {
  const runtime = ManagedRuntime.make(
    spaceLive(Database.layerClient(database)).pipe(
      Layer.provideMerge(Platform.layer),
    ),
  )
  const handler = runtime
    .context()
    .then((context) =>
      Platform.webHandler(context, Context.get(context, SpaceApp)),
    )
  return {
    fetch: async (request: Request) => (await handler)(request),
    holdsItem: (itemId: string) =>
      runtime.runPromise(Questions.holdsItem(itemId)),
    hasConnection: (connectionId: string) =>
      runtime.runPromise(Questions.hasConnection(connectionId)),
    storeWebhook: (body: string) =>
      runtime.runPromise(Questions.storeWebhook(body)),
    /** Handles every event appended so far; rejects when a reactor fails. */
    drain: () => runtime.runPromise(Reactors.use((reactors) => reactors.drain)),
    dispose: () => runtime.dispose(),
  }
}

export type SpaceObject = ReturnType<typeof makeSpaceObject>
