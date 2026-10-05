import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { apiClient, apiTest } from '../../testing/ApiTest.ts'
import { drain } from '../../testing/FakePluggy.ts'

const statement = `OFXHEADER:100
CHARSET:UTF-8

<OFX><MSGS><STMTRS><CURDEF>BRL<BANKTRANLIST>
<STMTTRN><DTPOSTED>20260910<TRNAMT>-25.00<FITID>a1<MEMO>Padaria Pão Quente</STMTTRN>
<STMTTRN><DTPOSTED>20260920<TRNAMT>-31.00<FITID>a2<MEMO>Padaria Pão Quente</STMTTRN>
</BANKTRANLIST></STMTRS></MSGS></OFX>`

const reasonOf = (error: { readonly _tag: string }) => [
  error._tag,
  'reason' in error ? error.reason : null,
]

// A checking account with two bakery purchases nobody categorized yet.
const bakery = Effect.gen(function* () {
  const client = yield* apiClient()
  const owner = yield* client.owners.create({
    payload: { name: 'Donald', kind: 'person' },
  })
  const account = yield* client.accounts.open({
    payload: {
      ownerId: owner.id,
      institutionName: 'Itaú',
      name: 'Conta',
      kind: 'checking',
      purpose: 'operating',
      currency: 'BRL',
    },
  })
  const data = new FormData()
  data.append('accountId', account.id)
  data.append('file', new Blob([statement]), 'set.ofx')
  yield* client.imports.upload({ payload: data })
  yield* drain
  const { entries } = yield* client.entries.list({
    query: { accountId: account.id },
  })
  return { client, later: entries[0]!, earlier: entries[1]! }
})

describe('categories API', () => {
  it.effect('creates, edits and archives a category', () =>
    Effect.gen(function* () {
      const client = yield* apiClient()
      const created = yield* client.categories.create({
        payload: { name: 'Café', bucket: 'lifestyle', color: '#7c2d12' },
      })
      const renamed = yield* client.categories.update({
        params: { categoryId: created.id },
        payload: { name: 'Cafés', parentId: 'restaurants' },
      })
      yield* client.categories.archive({ params: { categoryId: created.id } })
      const offered = yield* client.categories.list({ query: {} })
      const all = yield* client.categories.list({
        query: { includeArchived: true },
      })
      const system = yield* client.categories
        .update({ params: { categoryId: 'transfer' }, payload: { name: 'x' } })
        .pipe(Effect.flip)
      const unknownParent = yield* client.categories
        .update({
          params: { categoryId: 'leisure' },
          payload: { parentId: 'nope' },
        })
        .pipe(Effect.flip)

      assert.deepStrictEqual(
        {
          renamed: [renamed.name, renamed.parentId],
          offered: offered.some((category) => category.id === created.id),
          archived: all.find((category) => category.id === created.id)?.active,
          errors: [system, unknownParent].map(reasonOf),
        },
        {
          renamed: ['Cafés', 'restaurants'],
          offered: false,
          archived: false,
          errors: [
            ['Rejected', 'system_category'],
            ['InvalidRequest', 'invalid_parent'],
          ],
        },
      )
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect('decides, corrects and undoes an entry’s category', () =>
    Effect.gen(function* () {
      const { client, later, earlier } = yield* bakery
      const review = yield* client.categoryDecisions.review()
      const nothing = yield* client.categoryDecisions
        .confirm({ params: { entryId: later.id } })
        .pipe(Effect.flip)
      const decided = yield* client.categoryDecisions.decide({
        params: { entryId: later.id },
        payload: { categoryId: 'groceries' },
      })
      yield* drain
      // The store learned the merchant, so the other purchase follows it.
      const learned = yield* client.categoryDecisions.explain({
        params: { entryId: earlier.id },
      })
      const corrected = yield* client.categoryDecisions.correct({
        params: { entryId: earlier.id },
        payload: { categoryId: 'restaurants' },
      })
      const undone = yield* client.categoryDecisions.undo({
        params: { entryId: later.id },
      })
      const refused = yield* client.categoryDecisions
        .decide({
          params: { entryId: later.id },
          payload: { categoryId: 'transfer' },
        })
        .pipe(Effect.flip)

      assert.deepStrictEqual(
        {
          review: review.length,
          nothing: reasonOf(nothing),
          decided: [decided.categoryId, decided.origin],
          learned: [learned.categoryId, learned.origin],
          corrected: [corrected.categoryId, corrected.origin],
          undone: undone.origin,
          refused: reasonOf(refused),
        },
        {
          review: 0,
          nothing: ['Rejected', 'nothing_to_confirm'],
          decided: ['groceries', 'decision'],
          learned: ['groceries', 'pattern'],
          corrected: ['restaurants', 'decision'],
          undone: 'pattern',
          refused: ['Rejected', 'category_not_assignable'],
        },
      )
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect('previews a store edit before applying it to history', () =>
    Effect.gen(function* () {
      const { client, later, earlier } = yield* bakery
      yield* client.categoryDecisions.decide({
        params: { entryId: later.id },
        payload: { categoryId: 'groceries' },
      })
      yield* drain
      const [pattern] = yield* client.categoryStore.patterns()
      const edit = {
        _tag: 'Recategorize' as const,
        id: pattern!.id,
        categoryId: 'restaurants',
      }
      const preview = yield* client.categoryStore.preview({
        payload: { edit },
      })
      const untouched = yield* client.categoryDecisions.explain({
        params: { entryId: earlier.id },
      })
      yield* client.categoryStore.edit({ payload: { edit } })
      yield* drain
      const applied = yield* client.categoryDecisions.explain({
        params: { entryId: earlier.id },
      })
      const taken = yield* client.categoryStore
        .edit({ payload: { edit: { _tag: 'Remove', id: 'nope' } } })
        .pipe(Effect.flip)

      assert.deepStrictEqual(
        {
          pattern: [pattern?.categoryName, pattern?.source],
          preview: preview.map((change) => [
            change.entry?.description,
            change.before.categoryId,
            change.after.categoryId,
          ]),
          untouched: untouched.categoryId,
          applied: applied.categoryId,
          missing: reasonOf(taken),
        },
        {
          pattern: ['Mercado', 'transaction_list'],
          preview: [['Padaria Pão Quente', 'groceries', 'restaurants']],
          untouched: 'groceries',
          applied: 'restaurants',
          missing: ['NotFound', 'pattern_not_found'],
        },
      )
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect('maps a Pluggy category to one of ours', () =>
    Effect.gen(function* () {
      const client = yield* apiClient()
      yield* client.categoryStore.edit({
        payload: {
          edit: {
            _tag: 'SetProviderMapping',
            provider: 'pluggy',
            providerCategory: '05070000',
            categoryId: 'leisure',
          },
        },
      })
      const mappings = yield* client.categoryStore.providerMappings()
      assert.deepStrictEqual(
        mappings.filter((mapping) => mapping.source === 'person'),
        [
          {
            provider: 'pluggy',
            providerCategory: '05070000',
            categoryId: 'leisure',
            source: 'person',
          },
        ],
      )
      assert.isTrue(
        mappings.some(
          (mapping) =>
            mapping.source === 'built_in' &&
            mapping.providerCategory === 'Groceries',
        ),
      )
    }).pipe(Effect.provide(apiTest())),
  )
})
