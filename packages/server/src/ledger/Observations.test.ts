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

  it.effect('refuses to delete or replace stored observations', () =>
    Effect.gen(function* () {
      const { observations, account, source } = yield* setup
      yield* observations.recordTransactions({
        sourceId: source.id,
        accountId: account.id,
        transactions: [coffee],
      })
      yield* observations.recordBalance({
        sourceId: source.id,
        accountId: account.id,
        balance: {
          kind: 'booked',
          asOf: '2026-09-30',
          balanceCents: 1000,
          currency: 'BRL',
        },
      })
      const sql = yield* SqlClient.SqlClient
      const attempts = [
        sql`DELETE FROM transaction_observations`,
        sql`DELETE FROM balance_observations`,
        sql`INSERT OR REPLACE INTO transaction_observations
          SELECT id, source_id, account_id, external_id, version, booked_on, 0, currency,
            description, status, raw, observed_at
          FROM transaction_observations`,
      ]
      for (const attempt of attempts) {
        const error = yield* attempt.pipe(Effect.flip)
        assert.strictEqual(error._tag, 'SqlError')
      }
      assert.deepStrictEqual(
        (yield* observations.current(account.id)).map(
          (observation) => observation.amountCents,
        ),
        [-1250],
      )
    }).pipe(Effect.provide(LedgerTest)),
  )

  it.effect('records a change that only touches the raw payload', () =>
    Effect.gen(function* () {
      const { observations, account, source } = yield* setup
      const record = (raw: ReportedTransaction['raw']) =>
        observations.recordTransactions({
          sourceId: source.id,
          accountId: account.id,
          transactions: [{ ...coffee, raw }],
        })
      yield* record({ merchant: { cnpj: '00.000.000/0001-00' } })
      const corrected = yield* record({
        merchant: { cnpj: '11.111.111/0001-11' },
      })
      assert.deepStrictEqual(
        corrected.recorded.map((observation) => observation.version),
        [2],
      )
    }).pipe(Effect.provide(LedgerTest)),
  )

  it.effect(
    'rejects fractional centavos and impossible dates before writing',
    () =>
      Effect.gen(function* () {
        const { observations, account, source } = yield* setup
        const balance = yield* observations
          .recordBalance({
            sourceId: source.id,
            accountId: account.id,
            balance: {
              kind: 'booked',
              asOf: '2026-09-30',
              balanceCents: 0.5,
              currency: 'BRL',
            },
          })
          .pipe(Effect.flip)
        const date = yield* observations
          .recordTransactions({
            sourceId: source.id,
            accountId: account.id,
            transactions: [{ ...coffee, bookedOn: '2026-02-30' }],
          })
          .pipe(Effect.flip)
        assert.deepStrictEqual(
          [balance._tag, date._tag],
          ['InvalidReport', 'InvalidReport'],
        )
        assert.strictEqual((yield* observations.current(account.id)).length, 0)
      }).pipe(Effect.provide(LedgerTest)),
  )

  it.effect(
    'records a balance that returns to an earlier value as a correction',
    () =>
      Effect.gen(function* () {
        const { observations, account, source } = yield* setup
        const record = (balanceCents: number) =>
          observations.recordBalance({
            sourceId: source.id,
            accountId: account.id,
            balance: {
              kind: 'booked',
              asOf: '2026-09-30',
              balanceCents,
              currency: 'BRL',
            },
          })
        assert.deepStrictEqual(
          [yield* record(1000), yield* record(2000), yield* record(1000)],
          [true, true, true],
        )
      }).pipe(Effect.provide(LedgerTest)),
  )

  it.effect('registers a source once when two callers race', () =>
    Effect.gen(function* () {
      const observations = yield* Observations
      const input = {
        kind: 'file',
        externalRef: 'sha-1',
        label: 'set.ofx',
      } as const
      const [a, b] = yield* Effect.all(
        [
          observations.registerSource(input),
          observations.registerSource(input),
        ],
        { concurrency: 'unbounded' },
      )
      assert.strictEqual(a.id, b.id)
    }).pipe(Effect.provide(LedgerTest)),
  )
})
