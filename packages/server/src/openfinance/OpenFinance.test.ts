import { assert, describe, it } from '@effect/vitest'
import * as DateTime from 'effect/DateTime'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Ref from 'effect/Ref'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as TestClock from 'effect/testing/TestClock'

import { EventLog } from '../events/EventLog.ts'
import { Accounts, CardTerms } from '../ledger/Accounts.ts'
import { Observations } from '../ledger/Observations.ts'
import {
  bank,
  card,
  connect,
  drain,
  FakePluggyState,
  openFinanceManualTest,
  openFinanceTest,
  tx,
} from '../testing/FakePluggy.ts'
import { OpenFinance, OpenFinanceError } from './OpenFinance.ts'
import type { PluggyAccount, PluggyTransaction } from './PluggyApi.ts'

const balancesOf = (accountId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<{ kind: string; asOf: string; balanceCents: number }>`
      SELECT kind, as_of AS asOf, balance_cents AS balanceCents FROM balance_observations
      WHERE account_id = ${accountId} ORDER BY kind, as_of
    `
  })

describe('OpenFinance', () => {
  it.effect('refuses an item created for another connection', () =>
    Effect.gen(function* () {
      const { openFinance, connectionId, state } = yield* connect({
        accounts: [bank],
        transactions: {},
      })
      // A second connection receives an item created for the first one.
      const owner = (yield* openFinance.connection(connectionId)).ownerId
      const other = yield* openFinance.createConnectToken({ ownerId: owner })
      const stolen = yield* openFinance
        .registerItem({ connectionId: other.connectionId, itemId: 'item-1' })
        .pipe(Effect.flip)
      // The first connection cannot swap its item for another one.
      yield* Ref.update(state, (current) => ({
        ...current,
        clientUserId: connectionId,
      }))
      const swapped = yield* openFinance
        .registerItem({ connectionId, itemId: 'item-2' })
        .pipe(Effect.flip)
      assert.deepStrictEqual(
        [stolen, swapped].map(
          (error) => error._tag === 'OpenFinanceError' && error.reason,
        ),
        ['item_belongs_elsewhere', 'item_already_registered'],
      )
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'opens the account the person described and copies the chosen window',
    () =>
      Effect.gen(function* () {
        const { openFinance, connectionId, state } = yield* connect({
          accounts: [bank],
          transactions: {
            'provider-bank': [
              tx('too-old', '2026-06-30'),
              tx('first-day', '2026-07-01', { type: 'CREDIT', amount: 300.25 }),
              tx('pending', '2026-10-03', { status: 'PENDING' }),
            ],
          },
        })

        const account = yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank',
          target: {
            name: 'Conta da casa',
            kind: 'checking',
            purpose: 'operating',
          },
          historyMonths: 3,
        })
        yield* drain

        const current = yield* (yield* Observations).current(account.id)
        assert.deepStrictEqual(
          current.map((observation) => [
            observation.externalId,
            observation.amountCents,
            observation.status,
          ]),
          [
            ['first-day', 30025, 'posted'],
            ['pending', -1000, 'pending'],
          ],
        )

        // Pluggy renaming its product does not rename the person's account.
        yield* Ref.update(state, (current) => ({
          ...current,
          accounts: [{ ...bank, marketingName: 'NuConta' }],
        }))
        yield* openFinance.requestSync({ connectionId })
        yield* drain
        const accounts = yield* Accounts
        assert.strictEqual(
          (yield* accounts.get(account.id)).name,
          'Conta da casa',
        )
        assert.strictEqual(
          (yield* openFinance.providerAccounts(connectionId))[0]?.name,
          'NuConta',
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'versions changed reports and removes pending transactions Pluggy dropped',
    () =>
      Effect.gen(function* () {
        const { openFinance, connectionId, state } = yield* connect({
          accounts: [bank],
          transactions: {
            'provider-bank': [
              tx('market', '2026-09-28'),
              tx('hold', '2026-10-02', { status: 'PENDING' }),
            ],
          },
        })
        const account = yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank',
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        })
        yield* drain

        yield* Ref.update(state, (current) => ({
          ...current,
          transactions: {
            'provider-bank': [
              tx('market', '2026-09-28', { amount: 12.5 }),
              tx('hold-posted', '2026-10-03'),
            ],
          },
        }))
        yield* openFinance.requestSync({ connectionId })
        yield* drain

        const current = yield* (yield* Observations).current(account.id)
        assert.deepStrictEqual(
          current.map((observation) => [
            observation.externalId,
            observation.version,
            observation.amountCents,
          ]),
          [
            ['market', 2, -1250],
            ['hold-posted', 1, -1000],
          ],
        )
        const synced = (yield* (yield* EventLog).readAfter(0, 100)).filter(
          (event) => event.type === 'OpenFinanceAccountSynced',
        )
        assert.deepStrictEqual(synced.at(-1)?.payload, {
          providerAccountId: 'provider-bank',
          recorded: 2,
          unchanged: 0,
          removed: 1,
          skipped: 0,
          providerReady: true,
        })
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'starts a card on its statement cycle and records purchases as outflows',
    () =>
      Effect.gen(function* () {
        const { openFinance } = yield* connect({
          accounts: [card],
          transactions: {
            'provider-card': [
              tx('before-cycle', '2026-06-03', { accountId: 'provider-card' }),
              tx('cycle-start', '2026-06-04', {
                accountId: 'provider-card',
                amount: 89.9,
              }),
            ],
          },
        })
        const account = yield* openFinance.linkAccount({
          providerAccountId: 'provider-card',
          target: {
            kind: 'credit_card',
            purpose: 'operating',
            card: new CardTerms({
              closingDay: 3,
              dueDay: 10,
              limitCents: null,
              lastFour: '1889',
            }),
          },
          historyMonths: 3,
        })
        yield* drain

        const current = yield* (yield* Observations).current(account.id)
        assert.deepStrictEqual(
          current.map((observation) => [
            observation.externalId,
            observation.amountCents,
          ]),
          [['cycle-start', -8990]],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('revokes consent at Pluggy on disconnect and stops syncing', () =>
    Effect.gen(function* () {
      const { openFinance, connectionId, state } = yield* connect({
        accounts: [bank],
        transactions: { 'provider-bank': [tx('market', '2026-09-28')] },
      })
      yield* openFinance.disconnect(connectionId)
      yield* openFinance.requestSync({ connectionId })
      yield* drain

      assert.deepStrictEqual((yield* Ref.get(state)).deleted, ['item-1'])
      assert.strictEqual(
        (yield* openFinance.connection(connectionId)).status,
        'disconnected',
      )
      const error = yield* openFinance
        .linkAccount({
          providerAccountId: 'provider-bank',
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        })
        .pipe(Effect.flip)
      assert.strictEqual(
        error._tag === 'OpenFinanceError' && error.reason,
        'connection_disconnected',
      )
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'keeps the available balance apart and takes booked balances from complete days',
    () =>
      Effect.gen(function* () {
        const { openFinance } = yield* connect({
          accounts: [{ ...bank, balance: 830 }],
          transactions: {
            'provider-bank': [
              tx('salary', '2026-10-01', {
                type: 'CREDIT',
                amount: 1000,
                balance: 1000,
              }),
              tx('market', '2026-10-02', { amount: 150, balance: 850 }),
              tx('coffee', '2026-10-04', { amount: 20, balance: 830 }),
            ],
          },
        })
        const account = yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank',
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        })
        yield* drain
        const sql = yield* SqlClient.SqlClient
        const balances = yield* sql<{
          kind: string
          asOf: string
          balanceCents: number
        }>`
        SELECT kind, as_of AS asOf, balance_cents AS balanceCents FROM balance_observations
        WHERE account_id = ${account.id} ORDER BY kind, as_of
      `
        // Today (4 October) may still change, so it gives no booked checkpoint.
        assert.deepStrictEqual(balances, [
          { kind: 'available', asOf: '2026-10-04', balanceCents: 83000 },
          { kind: 'booked', asOf: '2026-10-01', balanceCents: 100000 },
          { kind: 'booked', asOf: '2026-10-02', balanceCents: 85000 },
        ])
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'follows a pending transaction older than the overlap until it settles',
    () =>
      Effect.gen(function* () {
        const { openFinance, connectionId, state } = yield* connect({
          accounts: [bank],
          transactions: {
            'provider-bank': [
              tx('hold', '2026-09-10', { status: 'PENDING' }),
              tx('recent', '2026-10-03'),
            ],
          },
        })
        const account = yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank',
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        })
        yield* drain
        // The hold settles under a new id; 10 September is outside the 7-day overlap.
        yield* Ref.update(state, (current) => ({
          ...current,
          transactions: {
            'provider-bank': [
              tx('settled', '2026-09-10'),
              tx('recent', '2026-10-03'),
            ],
          },
        }))
        yield* openFinance.requestSync({ connectionId })
        yield* drain
        const current = yield* (yield* Observations).current(account.id)
        assert.deepStrictEqual(
          current.map((observation) => [
            observation.externalId,
            observation.status,
          ]),
          [
            ['settled', 'posted'],
            ['recent', 'posted'],
          ],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'records a pending purchase that left one response when it returns posted',
    () =>
      Effect.gen(function* () {
        const { openFinance, connectionId, state } = yield* connect({
          accounts: [bank],
          transactions: {
            'provider-bank': [
              tx('purchase', '2026-09-10', {
                status: 'PENDING',
                amount: 55.3,
              }),
              tx('recent', '2026-10-03'),
            ],
          },
        })
        const account = yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank',
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        })
        yield* drain
        const respond = (transactions: ReadonlyArray<PluggyTransaction>) =>
          Effect.gen(function* () {
            yield* Ref.update(state, (current) => ({
              ...current,
              transactions: { 'provider-bank': transactions },
            }))
            yield* openFinance.requestSync({ connectionId })
            yield* drain
          })
        // One response omits the purchase; the next returns it posted.
        yield* respond([tx('recent', '2026-10-03')])
        yield* respond([
          tx('purchase', '2026-09-10', { amount: 55.3 }),
          tx('recent', '2026-10-03'),
        ])
        const current = yield* (yield* Observations).current(account.id)
        assert.deepStrictEqual(
          current.map((observation) => [
            observation.externalId,
            observation.status,
            observation.amountCents,
          ]),
          [
            ['purchase', 'posted', -5530],
            ['recent', 'posted', -1000],
          ],
        )
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    'stops revisiting a vanished pending purchase after the retention period',
    () =>
      Effect.gen(function* () {
        const { openFinance, state } = yield* connect({
          accounts: [bank],
          transactions: {
            'provider-bank': [
              tx('purchase', '2026-09-10', {
                status: 'PENDING',
                amount: 55.3,
              }),
              tx('recent', '2026-10-03'),
            ],
          },
        })
        const account = yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank',
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        })
        yield* openFinance.syncAccount('provider-bank')
        const respond = (transactions: ReadonlyArray<PluggyTransaction>) =>
          Effect.gen(function* () {
            yield* Ref.update(state, (current) => ({
              ...current,
              transactions: { 'provider-bank': transactions },
            }))
            yield* openFinance.syncAccount('provider-bank')
          })
        yield* respond([tx('recent', '2026-10-03')])
        // 31 days after its removal, the purchase's day is no longer re-read.
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe('2026-11-04T15:00:00Z')),
        )
        yield* respond([tx('recent', '2026-10-03')])
        yield* respond([
          tx('purchase', '2026-09-10', { amount: 55.3 }),
          tx('recent', '2026-10-03'),
        ])
        const current = yield* (yield* Observations).current(account.id)
        assert.deepStrictEqual(
          current.map((observation) => observation.externalId),
          ['recent'],
        )
      }).pipe(Effect.provide(ManualLayer)),
  )

  it.effect('does not take a skipped foreign purchase for a removed one', () =>
    Effect.gen(function* () {
      const { openFinance, connectionId, state } = yield* connect({
        accounts: [bank],
        transactions: {
          'provider-bank': [tx('abroad', '2026-10-02', { status: 'PENDING' })],
        },
      })
      const account = yield* openFinance.linkAccount({
        providerAccountId: 'provider-bank',
        target: { kind: 'checking', purpose: 'operating' },
        historyMonths: 3,
      })
      yield* drain
      // Still reported, but now without an amount in the account currency.
      yield* Ref.update(state, (current) => ({
        ...current,
        transactions: {
          'provider-bank': [
            tx('abroad', '2026-10-02', {
              status: 'PENDING',
              currencyCode: 'USD',
              amountInAccountCurrency: null,
            }),
          ],
        },
      }))
      yield* openFinance.requestSync({ connectionId })
      yield* drain
      assert.deepStrictEqual(
        (yield* (yield* Observations).current(account.id)).map(
          (observation) => observation.externalId,
        ),
        ['abroad'],
      )
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'reads nothing while Pluggy has not finished refreshing the item',
    () =>
      Effect.gen(function* () {
        const { openFinance, state } = yield* connect({
          accounts: [bank],
          transactions: { 'provider-bank': [tx('market', '2026-10-02')] },
        })
        yield* Ref.update(state, (current) => ({
          ...current,
          itemStatus: 'OUTDATED',
        }))
        const account = yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank',
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        })
        const result = yield* openFinance.syncAccount('provider-bank')
        assert.strictEqual(result.providerReady, false)
        assert.strictEqual(
          (yield* (yield* Observations).current(account.id)).length,
          0,
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'disconnects a connection whose item Pluggy deleted without blocking later syncs',
    () =>
      Effect.gen(function* () {
        const { openFinance, connectionId, state } = yield* connect({
          accounts: [bank],
          transactions: { 'provider-bank': [tx('market', '2026-10-02')] },
        })
        yield* Ref.update(state, (current) => ({
          ...current,
          deleted: ['item-1'],
        }))
        yield* openFinance.requestSync({ connectionId })
        yield* drain
        assert.strictEqual(
          (yield* openFinance.connection(connectionId)).status,
          'disconnected',
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('keeps the item that wins two concurrent registrations', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe('2026-10-04T15:00:00Z')),
      )
      const openFinance = yield* OpenFinance
      const owner = yield* (yield* Accounts).createOwner({
        name: 'Donald',
        kind: 'person',
      })
      const { connectionId } = yield* openFinance.createConnectToken({
        ownerId: owner.id,
      })
      // Pluggy answers neither registration until both have asked.
      const arrived = yield* Ref.make(0)
      const bothAsked = yield* Deferred.make<void>()
      const state = yield* FakePluggyState
      yield* Ref.update(state, (current) => ({
        ...current,
        clientUserId: connectionId,
        itemAccounts: { 'item-a': [bank], 'item-b': [card] },
        beforeGetItem: Effect.gen(function* () {
          if ((yield* Ref.updateAndGet(arrived, (n) => n + 1)) >= 2)
            yield* Deferred.succeed(bothAsked, undefined)
          yield* Deferred.await(bothAsked)
        }),
      }))

      const results = yield* Effect.all(
        ['item-a', 'item-b'].map((itemId) =>
          Effect.result(openFinance.registerItem({ connectionId, itemId })),
        ),
        { concurrency: 'unbounded' },
      )
      const failures = results.flatMap((result) =>
        Result.isFailure(result) && result.failure._tag === 'OpenFinanceError'
          ? [result.failure.reason]
          : [],
      )
      assert.deepStrictEqual(failures, ['item_already_registered'])
      const winner = (yield* openFinance.connection(connectionId)).itemId
      const sql = yield* SqlClient.SqlClient
      const sources = yield* sql<{ externalRef: string }>`
        SELECT external_ref AS externalRef FROM sources WHERE kind = 'open_finance'
      `
      assert.deepStrictEqual(
        {
          sources: sources.map((source) => source.externalRef),
          accounts: (yield* openFinance.providerAccounts(connectionId)).map(
            (account) => account.providerAccountId,
          ),
        },
        {
          sources: [winner!],
          accounts: [winner === 'item-a' ? 'provider-bank' : 'provider-card'],
        },
      )
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'gives no booked checkpoint for a day missing a running balance',
    () =>
      Effect.gen(function* () {
        const { openFinance } = yield* connect({
          accounts: [{ ...bank, balance: 850 }],
          transactions: {
            'provider-bank': [
              tx('salary', '2026-10-01', {
                type: 'CREDIT',
                amount: 1000,
                balance: 1000,
              }),
              tx('market', '2026-10-02', { amount: 100, balance: 900 }),
              // The day's latest line, without the balance after it (R$850).
              tx('fee', '2026-10-02', { amount: 50, balance: null }),
            ],
          },
        })
        const account = yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank',
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        })
        yield* drain
        assert.deepStrictEqual(
          (yield* balancesOf(account.id)).filter(
            (balance) => balance.kind === 'booked',
          ),
          [{ kind: 'booked', asOf: '2026-10-01', balanceCents: 100000 }],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'skips an account Pluggy stopped listing and syncs the others, keeping its history',
    () =>
      Effect.gen(function* () {
        const savings: PluggyAccount = {
          ...bank,
          id: 'provider-savings',
          name: 'Poupança',
          subtype: 'SAVINGS_ACCOUNT',
        }
        const { openFinance, connectionId, state } = yield* connect({
          accounts: [bank, savings],
          transactions: {
            'provider-bank': [tx('market', '2026-10-02')],
            'provider-savings': [
              tx('deposit', '2026-10-01', { accountId: 'provider-savings' }),
            ],
          },
        })
        const checking = yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank',
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        })
        const reserve = yield* openFinance.linkAccount({
          providerAccountId: 'provider-savings',
          target: { kind: 'savings', purpose: 'reserve' },
          historyMonths: 3,
        })
        yield* drain

        // Pluggy no longer lists the checking account; savings keeps moving.
        yield* Ref.update(state, (current) => ({
          ...current,
          accounts: [savings],
          transactions: {
            ...current.transactions,
            'provider-savings': [
              tx('deposit', '2026-10-01', { accountId: 'provider-savings' }),
              tx('interest', '2026-10-03', {
                accountId: 'provider-savings',
                type: 'CREDIT',
              }),
            ],
          },
        }))
        yield* openFinance.requestSync({ connectionId })
        yield* drain

        const observations = yield* Observations
        const ids = (accountId: string) =>
          Effect.map(observations.current(accountId), (current) =>
            current.map((observation) => observation.externalId),
          )
        assert.deepStrictEqual(
          {
            checking: yield* ids(checking.id),
            reserve: yield* ids(reserve.id),
            status: (yield* openFinance.connection(connectionId)).status,
            deleted: (yield* Ref.get(state)).deleted,
          },
          {
            checking: ['market'],
            reserve: ['deposit', 'interest'],
            status: 'active',
            deleted: [],
          },
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'records a foreign purchase once it gains an amount, however old',
    () =>
      Effect.gen(function* () {
        const { openFinance, connectionId, state } = yield* connect({
          accounts: [bank],
          transactions: {
            'provider-bank': [
              tx('abroad', '2026-09-10', {
                status: 'PENDING',
                currencyCode: 'USD',
                amountInAccountCurrency: null,
              }),
              tx('recent', '2026-10-03'),
            ],
          },
        })
        const account = yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank',
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        })
        yield* drain
        // 10 September is outside the 7-day overlap of the next sync.
        yield* Ref.update(state, (current) => ({
          ...current,
          transactions: {
            'provider-bank': [
              tx('abroad', '2026-09-10', {
                currencyCode: 'USD',
                amount: 10,
                amountInAccountCurrency: 55.3,
              }),
              tx('recent', '2026-10-03'),
            ],
          },
        }))
        yield* openFinance.requestSync({ connectionId })
        yield* drain
        assert.deepStrictEqual(
          (yield* (yield* Observations).current(account.id)).map(
            (observation) => [observation.externalId, observation.amountCents],
          ),
          [
            ['abroad', -5530],
            ['recent', -1000],
          ],
        )
        const sql = yield* SqlClient.SqlClient
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM open_finance_unresolved`,
          [],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'dates the available balance by when Pluggy last collected accounts',
    () =>
      Effect.gen(function* () {
        const { openFinance, connectionId, state } = yield* connect({
          accounts: [{ ...bank, balance: 700 }],
          transactions: { 'provider-bank': [tx('market', '2026-10-02')] },
          // This execution refreshed transactions but not accounts.
          statusDetail: {
            transactions: { isUpdated: true },
            accounts: {
              isUpdated: false,
              lastUpdatedAt: '2026-09-20T12:00:00.000Z',
            },
          },
        })
        const account = yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank',
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        })
        yield* drain
        const stale = yield* balancesOf(account.id)

        // 02:30 UTC on 3 October is still 2 October in São Paulo.
        yield* Ref.update(state, (current) => ({
          ...current,
          statusDetail: {
            transactions: { isUpdated: true },
            accounts: {
              isUpdated: true,
              lastUpdatedAt: '2026-10-03T02:30:00.000Z',
            },
          },
        }))
        yield* openFinance.requestSync({ connectionId })
        yield* drain
        assert.deepStrictEqual(
          { stale, fresh: yield* balancesOf(account.id) },
          {
            stale: [],
            fresh: [
              { kind: 'available', asOf: '2026-10-02', balanceCents: 70000 },
            ],
          },
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'withdraws a booked checkpoint once its day gains a line without a running balance',
    () =>
      Effect.gen(function* () {
        const { openFinance, connectionId, state } = yield* connect({
          accounts: [{ ...bank, balance: 900 }],
          transactions: {
            'provider-bank': [
              tx('salary', '2026-10-01', {
                type: 'CREDIT',
                amount: 1000,
                balance: 1000,
              }),
              tx('market', '2026-10-02', { amount: 100, balance: 900 }),
            ],
          },
        })
        const account = yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank',
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        })
        yield* drain
        // Pluggy now also reports a 2 October fee, without a running balance:
        // the day no longer closes on R$900.
        yield* Ref.update(state, (current) => ({
          ...current,
          transactions: {
            'provider-bank': [
              ...current.transactions['provider-bank']!,
              tx('fee', '2026-10-02', { amount: 50, balance: null }),
            ],
          },
        }))
        yield* openFinance.requestSync({ connectionId })
        yield* drain
        // A repeated read withdraws it only once.
        yield* openFinance.requestSync({ connectionId })
        yield* drain

        assert.deepStrictEqual(
          {
            booked: (yield* balancesOf(account.id)).filter(
              (balance) => balance.kind === 'booked',
            ),
            invalidated: (yield* openFinance.invalidatedCheckpoints(
              account.id,
            )).map((checkpoint) => checkpoint.asOf),
          },
          {
            booked: [
              { kind: 'booked', asOf: '2026-10-01', balanceCents: 100000 },
              { kind: 'booked', asOf: '2026-10-02', balanceCents: 90000 },
            ],
            invalidated: ['2026-10-02'],
          },
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'keeps re-reading a foreign purchase Pluggy omitted from one response',
    () =>
      Effect.gen(function* () {
        const abroad = tx('abroad', '2026-09-10', {
          currencyCode: 'USD',
          amount: 10,
          amountInAccountCurrency: null,
        })
        const { openFinance, connectionId, state } = yield* connect({
          accounts: [bank],
          transactions: {
            'provider-bank': [abroad, tx('recent', '2026-10-03')],
          },
        })
        const account = yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank',
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        })
        yield* drain
        const setTransactions = (
          transactions: ReadonlyArray<PluggyTransaction>,
        ) =>
          Ref.update(state, (current) => ({
            ...current,
            transactions: { 'provider-bank': transactions },
          }))
        // One response leaves it out; the next returns it converted.
        yield* setTransactions([tx('recent', '2026-10-03')])
        yield* openFinance.requestSync({ connectionId })
        yield* drain
        yield* setTransactions([
          { ...abroad, amountInAccountCurrency: 55.3 },
          tx('recent', '2026-10-03'),
        ])
        yield* openFinance.requestSync({ connectionId })
        yield* drain
        assert.deepStrictEqual(
          (yield* (yield* Observations).current(account.id)).map(
            (observation) => [observation.externalId, observation.amountCents],
          ),
          [
            ['abroad', -5530],
            ['recent', -1000],
          ],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  // Without the sync reactor: its 5-second sweep would replay every tick of
  // the month the clock jumps.
  it.effect(
    'stops re-reading an unresolved purchase absent for over 30 days',
    () =>
      Effect.gen(function* () {
        const { openFinance, state } = yield* connect({
          accounts: [bank],
          transactions: {
            'provider-bank': [
              tx('abroad', '2026-09-10', {
                currencyCode: 'USD',
                amountInAccountCurrency: null,
              }),
              tx('recent', '2026-10-03'),
            ],
          },
        })
        yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank',
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        })
        yield* openFinance.syncAccount('provider-bank')
        yield* Ref.update(state, (current) => ({
          ...current,
          transactions: { 'provider-bank': [] },
        }))
        const sql = yield* SqlClient.SqlClient
        const unresolvedAfterSyncOn = (instant: string) =>
          Effect.gen(function* () {
            yield* TestClock.setTime(
              DateTime.toEpochMillis(DateTime.makeUnsafe(instant)),
            )
            yield* openFinance.syncAccount('provider-bank')
            return (yield* sql<{ id: string }>`
              SELECT provider_transaction_id AS id FROM open_finance_unresolved
            `).map((row) => row.id)
          })
        assert.deepStrictEqual(
          {
            // Last seen 4 October.
            thirtyDays: yield* unresolvedAfterSyncOn('2026-11-03T15:00:00Z'),
            thirtyOneDays: yield* unresolvedAfterSyncOn('2026-11-04T15:00:00Z'),
          },
          { thirtyDays: ['abroad'], thirtyOneDays: [] },
        )
      }).pipe(Effect.provide(openFinanceManualTest())),
  )

  it.effect(
    'dates the available balance of a fully successful execution by the item update',
    () =>
      Effect.gen(function* () {
        // Pluggy reports no statusDetail when every product succeeded.
        const { openFinance } = yield* connect({
          accounts: [{ ...bank, balance: 700 }],
          transactions: { 'provider-bank': [tx('market', '2026-10-02')] },
          statusDetail: null,
          // 02:30 UTC on 3 October is still 2 October in São Paulo.
          itemLastUpdatedAt: '2026-10-03T02:30:00.000Z',
        })
        const account = yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank',
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        })
        yield* drain
        assert.deepStrictEqual(yield* balancesOf(account.id), [
          { kind: 'available', asOf: '2026-10-02', balanceCents: 70000 },
        ])
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'keeps a connection disconnected while a refresh and a sync were waiting on Pluggy',
    () =>
      Effect.gen(function* () {
        const { openFinance, connectionId, state } = yield* connect({
          accounts: [bank],
          transactions: { 'provider-bank': [tx('market', '2026-10-02')] },
        })
        yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank',
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        })
        yield* drain
        // Pluggy has produced both answers but neither arrives until the
        // disconnect completed.
        const arrived = yield* Ref.make(0)
        const bothWaiting = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* Ref.update(state, (current) => ({
          ...current,
          afterGetItem: Effect.gen(function* () {
            if ((yield* Ref.updateAndGet(arrived, (n) => n + 1)) >= 2)
              yield* Deferred.succeed(bothWaiting, undefined)
            yield* Deferred.await(release)
          }),
        }))
        const [refreshed, synced] = yield* Effect.all(
          [
            Effect.result(openFinance.refreshConnection(connectionId)),
            Effect.result(openFinance.syncAccount('provider-bank')),
            Effect.gen(function* () {
              yield* Deferred.await(bothWaiting)
              yield* openFinance.disconnect(connectionId)
              yield* Deferred.succeed(release, undefined)
            }),
          ],
          { concurrency: 'unbounded' },
        )
        const reason = (
          result: Result.Result<unknown, { readonly _tag: string }>,
        ) =>
          Result.isFailure(result) &&
          Schema.is(OpenFinanceError)(result.failure)
            ? result.failure.reason
            : null
        assert.deepStrictEqual(
          {
            refreshed: reason(refreshed),
            synced: reason(synced),
            status: (yield* openFinance.connection(connectionId)).status,
          },
          {
            refreshed: 'connection_disconnected',
            synced: 'connection_disconnected',
            status: 'disconnected',
          },
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )
  // Syncs a 1 October salary and the given lines, then the lines Pluggy
  // reports next; returns the booked checkpoints and the withdrawn days.
  const checkpointsAcross = (
    first: ReadonlyArray<PluggyTransaction>,
    ...later: ReadonlyArray<ReadonlyArray<PluggyTransaction>>
  ) =>
    Effect.gen(function* () {
      const salary = tx('salary', '2026-10-01', {
        type: 'CREDIT',
        amount: 1000,
        balance: 1000,
      })
      const { openFinance, connectionId, state } = yield* connect({
        accounts: [{ ...bank, balance: 900 }],
        transactions: { 'provider-bank': [salary, ...first] },
      })
      const account = yield* openFinance.linkAccount({
        providerAccountId: 'provider-bank',
        target: { kind: 'checking', purpose: 'operating' },
        historyMonths: 3,
      })
      yield* drain
      for (const next of later) {
        yield* Ref.update(state, (current) => ({
          ...current,
          transactions: { 'provider-bank': [salary, ...next] },
        }))
        yield* openFinance.requestSync({ connectionId })
        yield* drain
      }
      return {
        booked: (yield* balancesOf(account.id))
          .filter((balance) => balance.kind === 'booked')
          .map((balance) => [balance.asOf, balance.balanceCents]),
        invalidated: (yield* openFinance.invalidatedCheckpoints(
          account.id,
        )).map((checkpoint) => checkpoint.asOf),
      }
    })

  it.effect(
    'withdraws the checkpoint of the day a purchase was moved away from',
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* checkpointsAcross(
            [tx('market', '2026-10-02', { amount: 100, balance: 900 })],
            [tx('market', '2026-10-03', { amount: 100, balance: 900 })],
          ),
          {
            booked: [
              ['2026-10-01', 100000],
              ['2026-10-02', 90000],
              ['2026-10-03', 90000],
            ],
            invalidated: ['2026-10-02'],
          },
        )
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    'gives no checkpoint to a day whose foreign purchase is still unresolved',
    () =>
      Effect.gen(function* () {
        const market = tx('market', '2026-10-02', { amount: 100, balance: 900 })
        // The next response leaves the unconverted purchase out.
        assert.deepStrictEqual(
          yield* checkpointsAcross(
            [
              market,
              tx('abroad', '2026-10-02', {
                currencyCode: 'USD',
                amountInAccountCurrency: null,
                balance: null,
              }),
            ],
            [market],
          ),
          { booked: [['2026-10-01', 100000]], invalidated: [] },
        )
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    'withdraws the checkpoint of a day whose posted fee a response left out',
    () =>
      Effect.gen(function* () {
        const market = tx('market', '2026-10-02', { amount: 100, balance: 900 })
        assert.deepStrictEqual(
          yield* checkpointsAcross(
            [market, tx('fee', '2026-10-02', { amount: 50, balance: 850 })],
            [market],
          ),
          {
            booked: [
              ['2026-10-01', 100000],
              ['2026-10-02', 85000],
            ],
            invalidated: ['2026-10-02'],
          },
        )
      }).pipe(Effect.provide(TestLayer)),
  )

  it.effect(
    'reinstates a withdrawn checkpoint once a complete read confirms it',
    () =>
      Effect.gen(function* () {
        const market = tx('market', '2026-10-02', { amount: 100, balance: 900 })
        const fee = tx('fee', '2026-10-02', { amount: 50, balance: 850 })
        assert.deepStrictEqual(
          yield* checkpointsAcross([market, fee], [market], [market, fee]),
          {
            booked: [
              ['2026-10-01', 100000],
              ['2026-10-02', 85000],
            ],
            invalidated: [],
          },
        )
      }).pipe(Effect.provide(TestLayer)),
  )

  // A 10 September debit closes its day at R$900; Pluggy later dates it 2
  // October, outside the next read's overlap.
  const rent = tx('rent', '2026-09-10', { amount: 100, balance: 900 })
  const recent = tx('recent', '2026-10-03')
  const bookedAndWithdrawn = (accountId: string) =>
    Effect.gen(function* () {
      return {
        booked: (yield* balancesOf(accountId))
          .filter((balance) => balance.kind === 'booked')
          .map((balance) => [balance.asOf, balance.balanceCents]),
        invalidated: (yield* (yield* OpenFinance).invalidatedCheckpoints(
          accountId,
        )).map((checkpoint) => checkpoint.asOf),
      }
    })

  it.effect(
    'still withdraws the old day of a moved debit when a retry follows a failed write',
    () =>
      Effect.gen(function* () {
        const { openFinance, state } = yield* connect({
          accounts: [bank],
          transactions: { 'provider-bank': [rent, recent] },
        })
        const account = yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank',
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        })
        yield* openFinance.syncAccount('provider-bank')
        yield* Ref.update(state, (current) => ({
          ...current,
          transactions: {
            'provider-bank': [
              { ...rent, date: '2026-10-02T15:00:00.000Z' },
              recent,
            ],
          },
        }))
        // The database refuses one write after the facts were recorded.
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          CREATE TRIGGER fail_once BEFORE INSERT ON open_finance_checkpoint_invalidations
          BEGIN SELECT RAISE(ABORT, 'disk full'); END
        `
        const failed = yield* Effect.result(
          openFinance.syncAccount('provider-bank'),
        )
        yield* sql`DROP TRIGGER fail_once`
        yield* openFinance.syncAccount('provider-bank')
        assert.deepStrictEqual(
          {
            failed: Result.isFailure(failed),
            ...(yield* bookedAndWithdrawn(account.id)),
          },
          {
            failed: true,
            booked: [
              ['2026-09-10', 90000],
              ['2026-10-02', 90000],
            ],
            invalidated: ['2026-09-10'],
          },
        )
      }).pipe(Effect.provide(ManualLayer)),
  )

  it.effect(
    'withdraws the old day of a debit Pluggy moved without a convertible amount',
    () =>
      Effect.gen(function* () {
        const { openFinance, state } = yield* connect({
          accounts: [bank],
          transactions: { 'provider-bank': [rent, recent] },
        })
        const account = yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank',
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        })
        yield* openFinance.syncAccount('provider-bank')
        yield* Ref.update(state, (current) => ({
          ...current,
          transactions: {
            'provider-bank': [
              {
                ...rent,
                date: '2026-10-02T15:00:00.000Z',
                currencyCode: 'USD',
                amount: 20,
                amountInAccountCurrency: null,
                balance: null,
              },
              recent,
            ],
          },
        }))
        yield* openFinance.syncAccount('provider-bank')
        assert.deepStrictEqual(
          {
            facts: (yield* (yield* Observations).current(account.id)).map(
              (observation) => [observation.externalId, observation.bookedOn],
            ),
            ...(yield* bookedAndWithdrawn(account.id)),
          },
          {
            facts: [
              ['rent', '2026-09-10'],
              ['recent', '2026-10-03'],
            ],
            booked: [['2026-09-10', 90000]],
            invalidated: ['2026-09-10'],
          },
        )
      }).pipe(Effect.provide(ManualLayer)),
  )

  it.effect(
    'links a ledger account again through a new connection after a disconnect',
    () =>
      Effect.gen(function* () {
        const { openFinance, connectionId, state } = yield* connect({
          accounts: [bank],
          transactions: { 'provider-bank': [tx('market', '2026-09-28')] },
        })
        const account = yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank',
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        })
        yield* drain
        yield* openFinance.disconnect(connectionId)

        const reconnected = yield* openFinance.createConnectToken({
          ownerId: account.ownerId,
        })
        const bankAgain: PluggyAccount = { ...bank, id: 'provider-bank-2' }
        yield* Ref.update(state, (current) => ({
          ...current,
          clientUserId: reconnected.connectionId,
          itemAccounts: { 'item-2': [bankAgain] },
          transactions: {
            'provider-bank-2': [
              tx('pharmacy', '2026-10-02', { accountId: 'provider-bank-2' }),
            ],
          },
        }))
        yield* openFinance.registerItem({
          connectionId: reconnected.connectionId,
          itemId: 'item-2',
        })
        yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank-2',
          target: { accountId: account.id },
          historyMonths: 3,
        })
        yield* drain

        assert.deepStrictEqual(
          (yield* (yield* Observations).current(account.id)).map(
            (observation) => observation.externalId,
          ),
          ['market', 'pharmacy'],
        )
      }).pipe(Effect.provide(TestLayer)),
  )
})
