import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'

import { ServerConfig } from '../config.ts'
import { directory } from './LocalSpaces.ts'
import { SpaceDirectory } from './SpaceDirectory.ts'

// A directory over a fresh data directory on disk.
const withDirectory = <A, E, R>(
  use: (dataDirectory: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dataDirectory = yield* fs.makeTempDirectoryScoped()
    return yield* use(dataDirectory).pipe(
      Effect.provide(
        directory.pipe(
          Layer.provide(ServerConfig.layerTest({ dataDirectory })),
        ),
      ),
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe('SpaceDirectory', () => {
  it.effect('gives each email one space, created on first use', () =>
    withDirectory(() =>
      Effect.gen(function* () {
        const directory = yield* SpaceDirectory
        const first = yield* directory.spaceOf('Ana@Example.com')
        const again = yield* directory.spaceOf('  ana@example.com ')
        const other = yield* directory.spaceOf('beto@example.com')

        assert.strictEqual(again.id, first.id)
        assert.notStrictEqual(other.id, first.id)
        assert.strictEqual(first.databaseFile, `spaces/${first.id}.sqlite`)
        assert.deepStrictEqual(
          (yield* directory.list).map((space) => space.id),
          [first.id, other.id],
        )
      }),
    ),
  )

  it.effect('claims an existing database for its owner, once', () =>
    withDirectory((dataDirectory) =>
      Effect.gen(function* () {
        const directory = yield* SpaceDirectory
        const path = yield* Path.Path
        const databasePath = path.join(dataDirectory, 'spendle.sqlite')

        const claimed = yield* directory.claim({
          email: 'Ana@Example.com',
          databasePath,
        })
        const resolved = yield* directory.spaceOf('ana@example.com')
        const sameOwner = yield* directory
          .claim({
            email: 'ana@example.com',
            databasePath: '/elsewhere.sqlite',
          })
          .pipe(Effect.flip)
        const sameFile = yield* directory
          .claim({ email: 'beto@example.com', databasePath })
          .pipe(Effect.flip)

        // Inside the data directory the file is kept relative to it.
        assert.strictEqual(claimed.databaseFile, 'spendle.sqlite')
        assert.strictEqual(resolved.id, claimed.id)
        assert.strictEqual(directory.databasePath(resolved), databasePath)
        assert.deepStrictEqual(
          [sameOwner.reason, sameFile.reason],
          ['already_member', 'database_claimed'],
        )
      }),
    ),
  )
})
