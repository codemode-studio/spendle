import { assert, describe, it } from '@effect/vitest'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'

import { apiClient, apiTest } from '../../testing/ApiTest.ts'
import { drain } from '../../testing/FakePluggy.ts'

const statement = `OFXHEADER:100
CHARSET:UTF-8

<OFX><MSGS><CCSTMTRS><CURDEF>BRL<BANKTRANLIST>
<STMTTRN><DTPOSTED>20260805<TRNAMT>-100.00<FITID>c0<MEMO>Loja Parc 01/10</STMTTRN>
<STMTTRN><DTPOSTED>20260905<TRNAMT>-100.00<FITID>c1<MEMO>Loja Parc 02/10</STMTTRN>
<STMTTRN><DTPOSTED>20260920<TRNAMT>-50.00<FITID>c2<MEMO>Mercado</STMTTRN>
</BANKTRANLIST></CCSTMTRS></MSGS></OFX>`

describe('cards API', () => {
  it.effect('shows a card’s cycles and instalment plans', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-25T15:00:00Z')),
      )
      const client = yield* apiClient()
      const owner = yield* client.owners.create({
        payload: { name: 'Donald', kind: 'person' },
      })
      const card = yield* client.accounts.open({
        payload: {
          ownerId: owner.id,
          institutionName: 'Nubank',
          name: 'Cartão',
          kind: 'credit_card',
          purpose: 'operating',
          currency: 'BRL',
          card: { closingDay: 3, dueDay: 10, limitCents: null, lastFour: null },
        },
      })
      const data = new FormData()
      data.append('accountId', card.id)
      data.append('file', new Blob([statement]), 'cartao.ofx')
      yield* client.imports.upload({ payload: data })
      yield* drain

      const { cycles, beforeHistoryCents } = yield* client.cards.cycles({
        params: { accountId: card.id },
      })
      const plans = yield* client.cards.installments({
        params: { accountId: card.id },
      })
      const checking = yield* client.accounts.open({
        payload: {
          ownerId: owner.id,
          institutionName: 'Nubank',
          name: 'Conta',
          kind: 'checking',
          purpose: 'operating',
          currency: 'BRL',
        },
      })
      const notACard = yield* client.cards
        .cycles({ params: { accountId: checking.id } })
        .pipe(Effect.flip)

      assert.deepStrictEqual(
        {
          cycles: cycles.map((cycle) => [
            cycle.startsOn,
            cycle.closingOn,
            cycle.status,
            cycle.totalCents,
          ]),
          beforeHistoryCents,
          plans: plans.map((plan) => [
            plan.total,
            plan.seen,
            plan.remaining,
            plan.remainingCents,
          ]),
          notACard: [
            notACard._tag,
            'reason' in notACard ? notACard.reason : null,
          ],
        },
        {
          cycles: [
            ['2026-08-04', '2026-09-03', 'overdue', -10000],
            ['2026-09-04', '2026-10-03', 'open', -15000],
          ],
          beforeHistoryCents: 0,
          plans: [[10, [1, 2], 8, -80000]],
          notACard: ['Rejected', 'not_a_card'],
        },
      )
    }).pipe(Effect.provide(apiTest())),
  )
})
