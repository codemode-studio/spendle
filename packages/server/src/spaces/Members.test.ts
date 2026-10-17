import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import * as HttpApiClient from 'effect/http-api/HttpApiClient'

import { memberHeader } from '../api/definition/Security.ts'
import { SpaceApi } from '../api/definition/Space.ts'
import { clientFor, spacesTest } from '../testing/SpacesTest.ts'

// The space client the web server uses, naming `email` as the member.
const spaceClientFor = (email: string) =>
  HttpApiClient.make(SpaceApi, {
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.setHeader(memberHeader, email),
    ),
  })

const ownerNames = (email: string) =>
  Effect.gen(function* () {
    const owners = yield* (yield* clientFor(email)).owners.list()
    return owners.map((owner) => owner.name)
  })

// Ana's space with one owner recorded in it.
const anasSpace = Effect.gen(function* () {
  yield* (yield* clientFor('ana@example.com')).owners.create({
    payload: { name: 'Família', kind: 'household' },
  })
  return (yield* spaceClientFor('ana@example.com')).space
})

const failureReason = (error: { readonly _tag: string }) =>
  'reason' in error ? error.reason : error._tag

describe('family space members', () => {
  it.effect(
    "lets the owner add a member who then shares the space's data",
    () =>
      Effect.gen(function* () {
        const ana = yield* anasSpace
        const added = yield* ana.addMember({
          payload: { email: 'Beto@Example.com' },
        })
        const betoAdding = yield* (yield* spaceClientFor(
          'beto@example.com',
        )).space
          .addMember({ payload: { email: 'carla@example.com' } })
          .pipe(Effect.flip)

        assert.deepStrictEqual(added.members, [
          { email: 'ana@example.com', role: 'owner' },
          { email: 'beto@example.com', role: 'member' },
        ])
        assert.deepStrictEqual(yield* ownerNames('beto@example.com'), [
          'Família',
        ])
        assert.strictEqual(failureReason(betoAdding), 'not_owner')
      }).pipe(Effect.provide(spacesTest())),
  )

  it.effect('moves in someone whose own space was never written to', () =>
    Effect.gen(function* () {
      const ana = yield* anasSpace
      // Beto signed in and only looked around: a space of his own, unwritten.
      yield* ownerNames('beto@example.com')
      const anas = yield* ana.get()
      yield* ana.addMember({ payload: { email: 'beto@example.com' } })

      const betos = yield* (yield* spaceClientFor(
        'beto@example.com',
      )).space.get()
      assert.strictEqual(betos.id, anas.id)
      assert.deepStrictEqual(yield* ownerNames('beto@example.com'), ['Família'])
    }).pipe(Effect.provide(spacesTest())),
  )

  it.effect('refuses someone who recorded anything in their own space', () =>
    Effect.gen(function* () {
      const ana = yield* anasSpace
      // A goal alone, without owners or accounts, is still Beto's data.
      yield* (yield* clientFor('beto@example.com')).planning.saveGoal({
        payload: {
          name: 'Reserva',
          type: 'emergency_reserve',
          targetCents: 100_000,
          currentCents: 0,
        },
      })
      const refused = yield* ana
        .addMember({ payload: { email: 'beto@example.com' } })
        .pipe(Effect.flip)

      assert.strictEqual(failureReason(refused), 'member_elsewhere')
      assert.deepStrictEqual(yield* ownerNames('beto@example.com'), [])
    }).pipe(Effect.provide(spacesTest())),
  )

  it.effect('removes a member, but never the owner', () =>
    Effect.gen(function* () {
      const ana = yield* anasSpace
      yield* ana.addMember({ payload: { email: 'beto@example.com' } })
      const removed = yield* ana.removeMember({
        payload: { email: 'beto@example.com' },
      })
      const ownerRemoval = yield* ana
        .removeMember({ payload: { email: 'ana@example.com' } })
        .pipe(Effect.flip)

      assert.deepStrictEqual(
        removed.members.map((member) => member.email),
        ['ana@example.com'],
      )
      // Back to a space of his own, without Ana's data; owning it gives him
      // no say over Ana's space.
      assert.deepStrictEqual(yield* ownerNames('beto@example.com'), [])
      const betoRemovingAna = yield* (yield* spaceClientFor(
        'beto@example.com',
      )).space
        .removeMember({ payload: { email: 'ana@example.com' } })
        .pipe(Effect.flip)
      assert.strictEqual(failureReason(ownerRemoval), 'owner_stays')
      assert.strictEqual(failureReason(betoRemovingAna), 'member_not_found')
    }).pipe(Effect.provide(spacesTest())),
  )
})
