import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'

import { Observations } from '../../ledger/Observations.ts'
import { apiClient, apiTest, rawJson } from '../../testing/ApiTest.ts'
import { bank, connect, drain } from '../../testing/FakePluggy.ts'

const card = { closingDay: 3, dueDay: 10, limitCents: 500000, lastFour: '1889' }

const withOwner = Effect.gen(function* () {
  const client = yield* apiClient()
  const owner = yield* client.owners.create({
    payload: { name: 'Donald', kind: 'person' },
  })
  return { client, owner }
})

describe('accounts API', () => {
  it.effect('opens, lists, edits, archives and restores an account', () =>
    Effect.gen(function* () {
      const { client, owner } = yield* withOwner
      const opened = yield* client.accounts.open({
        payload: {
          ownerId: owner.id,
          institutionName: 'Itaú',
          name: 'Conta corrente',
          kind: 'checking',
          purpose: 'operating',
          currency: 'BRL',
        },
      })
      const renamed = yield* client.accounts.update({
        params: { accountId: opened.id },
        payload: { name: 'Conta Itaú' },
      })
      yield* client.accounts.archive({ params: { accountId: opened.id } })
      const visible = yield* client.accounts.list({ query: {} })
      const all = yield* client.accounts.list({
        query: { includeArchived: true },
      })
      const restored = yield* client.accounts.restore({
        params: { accountId: opened.id },
      })

      assert.deepStrictEqual(
        {
          owners: (yield* client.owners.list()).map((found) => found.name),
          institution: opened.institutionName,
          name: renamed.name,
          visible: visible.length,
          all: all.map((account) => account.archived),
          restored: restored.archived,
        },
        {
          owners: ['Donald'],
          institution: 'Itaú',
          name: 'Conta Itaú',
          visible: 0,
          all: [true],
          restored: false,
        },
      )
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect('requires card terms for a card and lets them change', () =>
    Effect.gen(function* () {
      const { client, owner } = yield* withOwner
      const input = {
        ownerId: owner.id,
        institutionName: 'Nubank',
        name: 'Ultravioleta',
        kind: 'credit_card' as const,
        purpose: 'operating' as const,
        currency: 'BRL',
      }
      const refused = yield* client.accounts
        .open({ payload: input })
        .pipe(Effect.flip)
      const opened = yield* client.accounts.open({
        payload: { ...input, card },
      })
      const changed = yield* client.accounts.setCardTerms({
        params: { accountId: opened.id },
        payload: { ...card, closingDay: 5 },
      })
      assert.deepStrictEqual(
        [refused._tag, 'reason' in refused ? refused.reason : null],
        ['InvalidRequest', 'card_terms_required'],
      )
      assert.deepStrictEqual(changed.card, { ...card, closingDay: 5 })
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect('shows the latest balance still standing as the checkpoint', () =>
    Effect.gen(function* () {
      const { client, owner } = yield* withOwner
      const opened = yield* client.accounts.open({
        payload: {
          ownerId: owner.id,
          institutionName: 'Itaú',
          name: 'Conta',
          kind: 'checking',
          purpose: 'operating',
          currency: 'BRL',
        },
      })
      const observations = yield* Observations
      const source = yield* observations.registerSource({
        kind: 'file',
        externalRef: 'statement.ofx',
        label: 'statement.ofx',
      })
      for (const [asOf, balanceCents] of [
        ['2026-09-30', 150_000],
        ['2026-08-31', 90_000],
      ] as const)
        yield* observations.recordBalance({
          sourceId: source.id,
          accountId: opened.id,
          balance: { kind: 'booked', asOf, balanceCents, currency: 'BRL' },
        })

      const found = yield* client.accounts.get({
        params: { accountId: opened.id },
      })
      assert.deepStrictEqual(found.lastCheckpoint, {
        kind: 'booked',
        asOf: '2026-09-30',
        balanceCents: 150_000,
        sourceId: source.id,
        sourceKind: 'file',
      })
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect('refuses to archive an account an Open Finance link feeds', () =>
    Effect.gen(function* () {
      const { openFinance } = yield* connect({
        accounts: [bank],
        transactions: {},
      })
      const account = yield* openFinance.linkAccount({
        providerAccountId: 'provider-bank',
        target: { kind: 'checking', purpose: 'operating' },
        historyMonths: 3,
      })
      yield* drain
      const client = yield* apiClient()
      const refused = yield* client.accounts
        .archive({ params: { accountId: account.id } })
        .pipe(Effect.flip)
      const listed = yield* client.accounts.get({
        params: { accountId: account.id },
      })
      assert.deepStrictEqual(
        [refused._tag, listed.link?.providerAccountId],
        ['Conflict', 'provider-bank'],
      )
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect('answers every failure with the same body', () =>
    Effect.gen(function* () {
      const missing = yield* rawJson(
        HttpClientRequest.get('/api/accounts/nope'),
      )
      const malformed = yield* rawJson(
        HttpClientRequest.post('/api/accounts').pipe(
          HttpClientRequest.bodyJsonUnsafe({ ownerId: 'x', currency: 'brl' }),
        ),
      )
      assert.deepStrictEqual(missing, {
        status: 404,
        body: { _tag: 'NotFound', reason: 'account_not_found', detail: 'nope' },
      })
      assert.strictEqual(malformed.status, 400)
      assert.deepInclude(malformed.body, {
        _tag: 'InvalidRequest',
        reason: 'invalid_payload',
      })
    }).pipe(Effect.provide(apiTest())),
  )
})
