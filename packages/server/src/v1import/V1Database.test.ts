import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'

import { makeV1Database } from '../testing/V1Fixture.ts'
import { readV1 } from './V1Database.ts'

describe('readV1', () => {
  it.effect('reads a database with the schema V1 migrations create', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const path = yield* makeV1Database(dir, (v1) =>
        Effect.gen(function* () {
          yield* v1.insert('ownership_scopes', {
            id: 'home',
            name: 'Família',
            type: 'household',
          })
          yield* v1.insert('credit_cards', {
            id: 'card',
            ownership_scope_id: 'home',
            name: 'Ultravioleta',
            closing_day: 3,
            due_day: 10,
          })
        }),
      )

      const snapshot = yield* readV1(path)

      assert.deepStrictEqual(
        snapshot.owners.map((owner) => [owner.id, owner.type, owner.active]),
        [['home', 'household', true]],
      )
      assert.deepStrictEqual(
        snapshot.cards.map((card) => [card.name, card.closingDay, card.dueDay]),
        [['Ultravioleta', 3, 10]],
      )
      // V1's migrations seed the categories its food split created.
      assert.includeMembers(
        snapshot.categories.map((category) => category.id),
        ['groceries', 'restaurants'],
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect('fails with the path when there is no database', () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const missing = path.join('/nonexistent', 'financas.db')
      const error = yield* Effect.flip(readV1(missing))
      assert.deepStrictEqual([error.reason, error.path], ['not_found', missing])
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
