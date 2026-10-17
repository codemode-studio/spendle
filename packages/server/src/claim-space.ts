import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Command from 'effect/cli/Command'
import * as Flag from 'effect/cli/Flag'

import { ServerConfig } from './config.ts'
import { SpaceDirectory } from './spaces/SpaceDirectory.ts'

// `vp run --filter @spendle/server claim-space --email <email>`
const command = Command.make(
  'claim-space',
  {
    email: Flag.String('email').pipe(
      Flag.withDescription('The Google account that owns the data'),
    ),
  },
  Effect.fn(function* ({ email }) {
    const { databasePath } = yield* ServerConfig
    // Claiming a missing file would give the account an empty space.
    if (!(yield* (yield* FileSystem.FileSystem).exists(databasePath))) {
      return yield* Effect.fail(`No database at ${databasePath}`)
    }
    const directory = yield* SpaceDirectory
    const space = yield* directory.claim({ email, databasePath })
    yield* Console.log(
      `${databasePath} is now the space ${space.id}, owned by ${email.trim().toLowerCase()}.`,
    )
  }),
).pipe(
  Command.withDescription(
    'Makes the database at SPENDLE_DATABASE_PATH the family space of an account, so its data stays reachable after signing in',
  ),
  Command.provide(
    SpaceDirectory.layer.pipe(Layer.provideMerge(ServerConfig.layer)),
  ),
)

command.pipe(
  Command.run({ version: '1.0.0' }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
