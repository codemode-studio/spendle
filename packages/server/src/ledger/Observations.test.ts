import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'

import { EventLog } from '../events/EventLog.ts'
import { LedgerTest } from '../testing/layers.ts'
import { Accounts } from './Accounts.ts'
import { Observations } from './Observations.ts'
import type { ReportedTransaction } from './Observations.ts'

const setup = Effect.gen(function* () {
  const accounts = yield* Accounts
  const observations = yield* Observations
  const owner = yield* accounts.createOwner({ name: 'Donald', kind: 'person' })
  const account = yield* accounts.open({
    ownerId: owner.id,
    institutionName: 'Nubank',
    name: 'Conta',
    kind: 'checking',
    purpose: 'operating',
    currency: 'BRL',
  })
  const source = yield* observations.registerSource({
    kind: 'open_finance',
    externalRef: 'item-1',
    label: 'Nubank via Pluggy',
  })
  return { observations, account, source }
})

const coffee: ReportedTransaction = {
  externalId: 'tx-1',
  bookedOn: '2026-09-30',
  amountCents: -1250,
  currency: 'BRL',
  description: 'Café',
  status: 'pending',
  raw: { id: 'tx-1' },
}

describe('Observations', () => {
  it.effect(
    'records a changed report as a new version and ignores repeats',
    () =>
      Effect.gen(function* () {
        const { observations, account, source } = yield* setup
        const record = (transactions: ReadonlyArray<ReportedTransaction>) =>
          observations.recordTransactions({
            sourceId: source.id,
            accountId: account.id,
            transactions,
          })

        const first = yield* record([coffee])
        const repeat = yield* record([coffee])
        const posted = yield* record([
          {
            ...coffee,
            status: 'posted',
            amountCents: -1300,
            bookedOn: '2026-10-01',
          },
        ])

        assert.deepStrictEqual(
          [
            first.recorded.length,
            repeat.recorded.length,
            repeat.unchanged,
            posted.recorded[0]?.version,
          ],
          [1, 0, 1, 2],
        )
        const current = yield* observations.current(account.id)
        assert.deepStrictEqual(
          current.map((observation) => [
            observation.version,
            observation.status,
            observation.amountCents,
          ]),
          [[2, 'posted', -1300]],
        )
        const events = yield* (yield* EventLog).readAfter(0, 10)
        assert.deepStrictEqual(
          events.filter((event) => event.type === 'TransactionObserved').length,
          2,
        )
      }).pipe(Effect.provide(LedgerTest)),
  )

  it.effect(
    'drops a removed transaction from the current view but keeps its history',
    () =>
      Effect.gen(function* () {
        const { observations, account, source } = yield* setup
        const record = (transactions: ReadonlyArray<ReportedTransaction>) =>
          observations.recordTransactions({
            sourceId: source.id,
            accountId: account.id,
            transactions,
          })
        yield* record([coffee])
        yield* record([{ ...coffee, status: 'removed' }])

        assert.strictEqual((yield* observations.current(account.id)).length, 0)
        const sql = yield* SqlClient.SqlClient
        const versions = yield* sql<{ status: string }>`
        SELECT status FROM transaction_observations ORDER BY version
      `
        assert.deepStrictEqual(
          versions.map((row) => row.status),
          ['pending', 'removed'],
        )
      }).pipe(Effect.provide(LedgerTest)),
  )

  it.effect(
    'rejects a batch with a foreign currency without recording any of it',
    () =>
      Effect.gen(function* () {
        const { observations, account, source } = yield* setup
        const error = yield* observations
          .recordTransactions({
            sourceId: source.id,
            accountId: account.id,
            transactions: [
              coffee,
              { ...coffee, externalId: 'tx-2', currency: 'USD' },
            ],
          })
          .pipe(Effect.flip)

        assert.strictEqual(error._tag, 'CurrencyMismatch')
        assert.strictEqual((yield* observations.current(account.id)).length, 0)
      }).pipe(Effect.provide(LedgerTest)),
  )

  it.effect('refuses to edit a stored observation in place', () =>
    Effect.gen(function* () {
      const { observations, account, source } = yield* setup
      yield* observations.recordTransactions({
        sourceId: source.id,
        accountId: account.id,
        transactions: [coffee],
      })
      const sql = yield* SqlClient.SqlClient
      const error =
        yield* sql`UPDATE transaction_observations SET amount_cents = 0`.pipe(
          Effect.flip,
        )
      assert.strictEqual(error.reason._tag, 'ConstraintError')
      assert.deepStrictEqual(
        (yield* observations.current(account.id)).map(
          (observation) => observation.amountCents,
        ),
        [-1250],
      )
    }).pipe(Effect.provide(LedgerTest)),
  )

  it.effect('records each distinct balance once', () =>
    Effect.gen(function* () {
      const { observations, account, source } = yield* setup
      const balance = {
        kind: 'booked',
        asOf: '2026-09-30',
        balanceCents: 100_000,
        currency: 'BRL',
      } as const
      const record = (balanceCents: number) =>
        observations.recordBalance({
          sourceId: source.id,
          accountId: account.id,
          balance: { ...balance, balanceCents },
        })

      assert.deepStrictEqual(
        [yield* record(100_000), yield* record(100_000), yield* record(98_750)],
        [true, false, true],
      )
    }).pipe(Effect.provide(LedgerTest)),
  )
})
