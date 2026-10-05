import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Command from 'effect/cli/Command'
import * as Flag from 'effect/cli/Flag'

import { ServerConfig } from './config.ts'
import { migrateV1 } from './v1import/Migrate.ts'
import { formatSummary } from './v1import/Report.ts'

// `pnpm --filter @spendle/server migrate-v1 --from <v1.sqlite> [--dry-run]`
const command = Command.make(
  'migrate-v1',
  {
    from: Flag.File('from', { mustExist: true }).pipe(
      Flag.withDescription('The V1 SQLite database; it is opened read-only'),
    ),
    dryRun: Flag.Boolean('dry-run').pipe(
      Flag.withDescription('Print what would change and write nothing'),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ from, dryRun }) {
    const { databasePath } = yield* ServerConfig
    yield* Console.log(`V1: ${from}\nV2: ${databasePath}\n`)
    const summary = yield* migrateV1({ from, databasePath, dryRun })
    yield* Console.log(formatSummary(summary, { dryRun }))
  }),
).pipe(
  Command.withDescription(
    "Moves V1's accounts, categories, knowledge base and decisions into the V2 database",
  ),
  Command.provide(ServerConfig.layer),
)

command.pipe(
  Command.run({ version: '1.0.0' }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
