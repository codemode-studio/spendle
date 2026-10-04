import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { EventLog } from '../events/EventLog.ts'
import { LedgerTest } from '../testing/layers.ts'
import { Accounts, CardTerms } from './Accounts.ts'

const terms = new CardTerms({
  closingDay: 3,
  dueDay: 10,
  limitCents: 500_000,
  lastFour: '1889',
})

const setup = Effect.gen(function* () {
  const accounts = yield* Accounts
  const owner = yield* accounts.createOwner({
    name: 'Família',
    kind: 'household',
  })
  return { accounts, owner }
})

describe('Accounts', () => {
  it.effect('keeps every field a person edits', () =>
    Effect.gen(function* () {
      const { accounts, owner } = yield* setup
      const opened = yield* accounts.open({
        ownerId: owner.id,
        institutionName: 'Nubank',
        name: 'Conta',
        kind: 'checking',
        purpose: 'operating',
        currency: 'BRL',
      })

      yield* accounts.update(opened.id, {
        name: 'Reserva da família',
        institutionName: 'Inter',
        kind: 'savings',
        purpose: 'reserve',
      })

      const stored = yield* accounts.get(opened.id)
      assert.deepStrictEqual(
        [stored.name, stored.institutionName, stored.kind, stored.purpose],
        ['Reserva da família', 'Inter', 'savings', 'reserve'],
      )
      const events = yield* (yield* EventLog).readAfter(0, 10)
      assert.deepStrictEqual(
        events.map((event) => [event.type, event.payload]),
        [
          ['AccountOpened', { accountId: opened.id }],
          [
            'AccountUpdated',
            {
              accountId: opened.id,
              changed: ['name', 'institutionName', 'kind', 'purpose'],
            },
          ],
        ],
      )
    }).pipe(Effect.provide(LedgerTest)),
  )

  it.effect('matches institutions by name regardless of case', () =>
    Effect.gen(function* () {
      const { accounts, owner } = yield* setup
      const base = {
        ownerId: owner.id,
        kind: 'checking',
        purpose: 'operating',
        currency: 'BRL',
      } as const
      const first = yield* accounts.open({
        ...base,
        institutionName: 'Nubank',
        name: 'PF',
      })
      const second = yield* accounts.open({
        ...base,
        institutionName: ' nubank ',
        name: 'PJ',
      })
      assert.strictEqual(second.institutionId, first.institutionId)
      assert.strictEqual(second.institutionName, 'Nubank')
    }).pipe(Effect.provide(LedgerTest)),
  )

  it.effect(
    'rejects card and investment combinations that would corrupt balances',
    () =>
      Effect.gen(function* () {
        const { accounts, owner } = yield* setup
        const base = {
          ownerId: owner.id,
          institutionName: 'Nubank',
          name: 'X',
          currency: 'BRL',
        }

        const noTerms = yield* accounts
          .open({ ...base, kind: 'credit_card', purpose: 'operating' })
          .pipe(Effect.flip)
        assert.strictEqual(
          noTerms._tag === 'InvalidAccount' && noTerms.reason,
          'card_terms_required',
        )

        const card = yield* accounts.open({
          ...base,
          kind: 'credit_card',
          purpose: 'operating',
          card: terms,
        })
        assert.deepStrictEqual(card.card, terms)
        const toChecking = yield* accounts
          .update(card.id, { kind: 'checking' })
          .pipe(Effect.flip)
        assert.strictEqual(
          toChecking._tag === 'InvalidAccount' && toChecking.reason,
          'card_terms_forbidden',
        )

        const brokerage = yield* accounts
          .open({ ...base, kind: 'investment', purpose: 'operating' })
          .pipe(Effect.flip)
        assert.strictEqual(
          brokerage._tag === 'InvalidAccount' && brokerage.reason,
          'investment_purpose',
        )
      }).pipe(Effect.provide(LedgerTest)),
  )
})
