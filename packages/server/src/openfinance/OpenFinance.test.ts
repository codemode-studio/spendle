import { assert, describe, it } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import * as TestClock from 'effect/testing/TestClock'

import { EventLog } from '../events/EventLog.ts'
import * as Reactor from '../events/Reactor.ts'
import { Accounts, CardTerms } from '../ledger/Accounts.ts'
import { Observations } from '../ledger/Observations.ts'
import { LedgerTest } from '../testing/layers.ts'
import { OpenFinance } from './OpenFinance.ts'
import type { PluggyAccount, PluggyTransaction } from './PluggyApi.ts'
import { PluggyClient } from './PluggyClient.ts'
import * as SyncReactor from './SyncReactor.ts'

interface FakeState {
  readonly clientUserId: string
  readonly accounts: ReadonlyArray<PluggyAccount>
  readonly transactions: Readonly<
    Record<string, ReadonlyArray<PluggyTransaction>>
  >
  readonly deleted: ReadonlyArray<string>
}

class FakePluggyState extends Context.Service<
  FakePluggyState,
  Ref.Ref<FakeState>
>()('@spendle/server/openfinance/OpenFinance.test/FakePluggyState') {}

const bank: PluggyAccount = {
  id: 'provider-bank',
  type: 'BANK',
  name: 'Conta Corrente',
  number: '0001/12345-6',
  balance: 1000,
  currencyCode: 'BRL',
}
const card: PluggyAccount = {
  id: 'provider-card',
  type: 'CREDIT',
  name: 'Ultravioleta',
  number: '5555 **** **** 1889',
  balance: 250,
  currencyCode: 'BRL',
}
const tx = (
  id: string,
  date: string,
  fields: Partial<PluggyTransaction> = {},
): PluggyTransaction => ({
  id,
  accountId: 'provider-bank',
  date: `${date}T15:00:00.000Z`,
  description: id,
  type: 'DEBIT',
  amount: 10,
  currencyCode: 'BRL',
  ...fields,
})

// Pluggy as seen through PluggyClient, backed by a mutable state the test edits.
const makeFake = (state: Ref.Ref<FakeState>) =>
  PluggyClient.of({
    createConnectToken: () => Effect.succeed('connect-token'),
    getItem: (itemId) =>
      Effect.map(Ref.get(state), (current) => ({
        id: itemId,
        status: 'UPDATED',
        clientUserId: current.clientUserId,
        connector: { id: 1, name: 'Nubank' },
      })),
    deleteItem: (itemId) =>
      Ref.update(state, (current) => ({
        ...current,
        deleted: [...current.deleted, itemId],
      })),
    listAccounts: () =>
      Effect.map(Ref.get(state), (current) => current.accounts),
    listTransactions: ({ accountId, dateFrom, dateTo }) =>
      Effect.map(Ref.get(state), (current) =>
        (current.transactions[accountId] ?? []).filter(
          (transaction) =>
            transaction.date.slice(0, 10) >= dateFrom &&
            transaction.date.slice(0, 10) <= dateTo,
        ),
      ),
  })

const TestLayer = Layer.unwrap(
  Effect.gen(function* () {
    const state = yield* Ref.make<FakeState>({
      clientUserId: '',
      accounts: [],
      transactions: {},
      deleted: [],
    })
    return SyncReactor.layer.pipe(
      Layer.provideMerge(OpenFinance.layer),
      Layer.provideMerge(Reactor.Reactors.layer),
      Layer.provideMerge(Layer.succeed(PluggyClient, makeFake(state))),
      Layer.provideMerge(Layer.succeed(FakePluggyState, state)),
      Layer.provideMerge(LedgerTest),
    )
  }),
)

// Connects an item with the given Pluggy data, as the widget flow would.
const connect = (data: Omit<FakeState, 'clientUserId' | 'deleted'>) =>
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
    const state = yield* FakePluggyState
    yield* Ref.set(state, { ...data, clientUserId: connectionId, deleted: [] })
    yield* openFinance.registerItem({ connectionId, itemId: 'item-1' })
    return { openFinance, connectionId, state }
  })

const drain = Effect.gen(function* () {
  yield* (yield* Reactor.Reactors).drain
})

describe('OpenFinance', () => {
  it.effect('refuses an item created for another connection', () =>
    Effect.gen(function* () {
      const { openFinance, connectionId, state } = yield* connect({
        accounts: [bank],
        transactions: {},
      })
      yield* Ref.update(state, (current) => ({
        ...current,
        clientUserId: 'someone-else',
      }))
      const error = yield* openFinance
        .registerItem({ connectionId, itemId: 'item-2' })
        .pipe(Effect.flip)
      assert.strictEqual(
        error._tag === 'OpenFinanceError' && error.reason,
        'item_belongs_elsewhere',
      )
    }).pipe(Effect.provide(TestLayer)),
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
      }).pipe(Effect.provide(TestLayer)),
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
        })
      }).pipe(Effect.provide(TestLayer)),
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
      }).pipe(Effect.provide(TestLayer)),
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
    }).pipe(Effect.provide(TestLayer)),
  )
})
