import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Predicate from 'effect/Predicate'

import { EventLog } from '../events/EventLog.ts'
import { CategoriesTest } from '../testing/layers.ts'
import { Categories, CategoriesError, categoryChanged } from './Categories.ts'

// The domain reason a call fails with; other failures fail the test.
const failure = <A, E, R>(effect: Effect.Effect<A, E | CategoriesError, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.flatMap((error) =>
      Predicate.isTagged(error, 'CategoriesError')
        ? Effect.succeed((error as CategoriesError).reason)
        : Effect.die(error),
    ),
  )

describe('Categories', () => {
  it.effect('seeds V1 categories with reconciliation owning two of them', () =>
    Effect.gen(function* () {
      const all = yield* (yield* Categories).list
      const byId = new Map(all.map((category) => [category.id, category]))
      assert.strictEqual(byId.get('groceries')?.name, 'Mercado')
      assert.deepStrictEqual(
        all
          .filter((category) => category.system)
          .map((category) => category.id)
          .sort(),
        ['card_payment', 'transfer'],
      )
      assert.isFalse(byId.get('food')!.active)
      assert.isFalse(byId.get('uncategorized')!.system)
    }).pipe(Effect.provide(CategoriesTest)),
  )

  it.effect('creates, edits and archives the person’s categories', () =>
    Effect.gen(function* () {
      const categories = yield* Categories
      const pets = yield* categories.create({
        name: ' Ração ',
        bucket: 'lifestyle',
        parentId: 'pets',
      })
      assert.deepInclude(pets, {
        name: 'Ração',
        parentId: 'pets',
        active: true,
        system: false,
      })
      const renamed = yield* categories.update(pets.id, {
        name: 'Ração e petiscos',
        color: '#ca8a04',
      })
      assert.deepInclude(renamed, {
        name: 'Ração e petiscos',
        color: '#ca8a04',
      })
      assert.isFalse((yield* categories.archive(pets.id)).active)
      const events = yield* (yield* EventLog).readAfter(0, 100)
      assert.strictEqual(
        events.filter((event) => event.type === categoryChanged).length,
        3,
      )
    }).pipe(Effect.provide(CategoriesTest)),
  )

  it.effect('refuses to change system categories or lose uncategorized', () =>
    Effect.gen(function* () {
      const categories = yield* Categories
      assert.strictEqual(
        yield* failure(categories.update('transfer', { name: 'Outra' })),
        'system_category',
      )
      assert.strictEqual(
        yield* failure(categories.archive('card_payment')),
        'system_category',
      )
      assert.strictEqual(
        yield* failure(categories.archive('uncategorized')),
        'protected_category',
      )
      assert.strictEqual(
        yield* failure(categories.update('housing', { parentId: 'transfer' })),
        'invalid_parent',
      )
      const child = yield* categories.create({
        name: 'Aluguel',
        bucket: 'essential',
        parentId: 'housing',
      })
      assert.strictEqual(
        yield* failure(categories.update('housing', { parentId: child.id })),
        'invalid_parent',
      )
      assert.strictEqual(
        yield* failure(categories.create({ name: '  ', bucket: 'tax' })),
        'invalid_input',
      )
    }).pipe(Effect.provide(CategoriesTest)),
  )
  it.effect('brings V1 categories over under their ids, once', () =>
    Effect.gen(function* () {
      const categories = yield* Categories
      const log = yield* EventLog
      const v1 = {
        parentId: null,
        icon: null,
        active: true,
        color: '#111111',
      } as const

      assert.deepStrictEqual(
        [
          yield* categories.importV1({
            ...v1,
            id: 'groceries',
            name: 'Supermercado',
            bucket: 'essential',
          }),
          yield* categories.importV1({
            ...v1,
            id: 'vet',
            name: 'Veterinário',
            bucket: 'lifestyle',
            parentId: 'pets',
          }),
          yield* categories.importV1({
            ...v1,
            id: 'transfer',
            name: 'Transf.',
            bucket: 'lifestyle',
          }),
        ],
        ['updated', 'created', 'kept'],
      )
      const vet = yield* categories.get('vet')
      assert.deepStrictEqual(
        [vet.name, vet.parentId, vet.color, vet.system],
        ['Veterinário', 'pets', '#111111', false],
      )
      assert.strictEqual(
        (yield* categories.get('transfer')).name,
        'Transferência interna',
      )

      const sequence = yield* log.latestSequence
      assert.strictEqual(
        yield* categories.importV1({
          ...v1,
          id: 'groceries',
          name: 'Supermercado',
          bucket: 'essential',
        }),
        'unchanged',
      )
      assert.strictEqual(yield* log.latestSequence, sequence)
    }).pipe(Effect.provide(CategoriesTest)),
  )
})
