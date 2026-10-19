import { assert, describe, it } from '@effect/vitest'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'

import { apiClient, apiTest } from '../../testing/ApiTest.ts'
import { drain } from '../../testing/FakePluggy.ts'

const ofx = (lines: string, start: string, end: string, closing: string) =>
  `OFXHEADER:100
CHARSET:UTF-8

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL
<BANKTRANLIST><DTSTART>${start}<DTEND>${end}
${lines}
</BANKTRANLIST><LEDGERBAL><BALAMT>${closing}<DTASOF>${end}</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`

const upload = (accountId: string, content: string, name: string) => {
  const data = new FormData()
  data.append('accountId', accountId)
  data.append('file', new Blob([content]), name)
  return data
}

// A brokerage and a checking account, on 2026-10-04 in São Paulo.
const setup = Effect.gen(function* () {
  yield* TestClock.setTime(
    DateTime.toEpochMillis(DateTime.makeUnsafe('2026-10-04T15:00:00Z')),
  )
  const client = yield* apiClient()
  const owner = yield* client.owners.create({
    payload: { name: 'Donald', kind: 'person' },
  })
  const open = (
    name: string,
    kind: 'checking' | 'investment',
    currency = 'BRL',
  ) =>
    client.accounts.open({
      payload: {
        ownerId: owner.id,
        institutionName: kind === 'investment' ? 'XP' : 'Itaú',
        name,
        kind,
        purpose: kind === 'investment' ? 'investment' : 'operating',
        currency,
      },
    })
  const brokerage = yield* open('Corretora', 'investment')
  const checking = yield* open('Conta', 'checking')
  const typed = (
    accountId: string,
    bookedOn: string,
    amountCents: number,
    description: string,
  ) =>
    client.manual.createTransaction({
      payload: { accountId, bookedOn, amountCents, description },
    })
  return { client, owner, brokerage, checking, open, typed }
})

describe('investments API', () => {
  it.effect(
    'values a position from its posted movements and the values the person enters',
    () =>
      Effect.gen(function* () {
        const { client, brokerage, checking, typed } = yield* setup
        const first = yield* typed(
          brokerage.id,
          '2026-09-01',
          100_000,
          'Aporte Tesouro',
        )
        const scheduled = yield* typed(
          brokerage.id,
          '2026-10-20',
          20_000,
          'Aporte agendado',
        )
        const rent = yield* typed(
          checking.id,
          '2026-09-05',
          -150_000,
          'Aluguel',
        )
        yield* drain
        const before = yield* client.investments.snapshot({ query: {} })
        const { positionId } = yield* client.investments.classify({
          payload: {
            entryId: first.entryId!,
            newPosition: {
              name: 'Tesouro Selic 2029',
              assetClassId: 'fixed-income',
              reserve: true,
            },
          },
        })
        yield* client.investments.classify({
          payload: { entryId: scheduled.entryId!, positionId },
        })
        const classified = yield* client.investments.snapshot({ query: {} })
        yield* client.investments.recordValuation({
          params: { positionId },
          payload: { asOf: '2026-09-30', amountCents: 103_500 },
        })
        const valued = yield* client.investments.snapshot({ query: {} })
        const later = yield* client.investments.snapshot({
          query: { on: '2026-10-31' },
        })
        const notBrokerage = yield* client.investments
          .classify({ payload: { entryId: rent.entryId!, positionId } })
          .pipe(Effect.flip)
        const position = (snapshot: typeof classified) => {
          const found = snapshot.positions[0]!
          return [
            found.contributedCents,
            found.currentCents,
            found.valueKind,
            found.currentBrlCents,
          ]
        }
        assert.deepStrictEqual(
          {
            available: before.available.map((entry) => entry.description),
            accounts: before.accounts.map((account) => account.name),
            referenceDate: classified.referenceDate,
            movements: classified.positions[0]!.movements.map((movement) => [
              movement.description,
              movement.counted,
            ]),
            classified: position(classified),
            left: classified.available.length,
            summary: [
              classified.summary.totalBrlCents,
              classified.summary.reserveBrlCents,
              classified.summary.positionCount,
            ],
            valued: position(valued),
            later: position(later),
            notBrokerage:
              'reason' in notBrokerage
                ? notBrokerage.reason
                : notBrokerage._tag,
          },
          {
            available: ['Aporte agendado', 'Aporte Tesouro'],
            accounts: ['Corretora'],
            referenceDate: '2026-10-04',
            movements: [
              ['Aporte agendado', false],
              ['Aporte Tesouro', true],
            ],
            classified: [100_000, 100_000, 'contributions', 100_000],
            left: 0,
            summary: [100_000, 100_000, 1],
            valued: [100_000, 103_500, 'valuation', 103_500],
            // Once the scheduled contribution is due, it adds to the valuation.
            later: [120_000, 123_500, 'valuation', 123_500],
            notBrokerage: 'not_an_investment_account',
          },
        )
      }).pipe(Effect.provide(apiTest())),
  )

  it.effect(
    'keeps a classification with the movement when the bank reports it, and drops an emptied position',
    () =>
      Effect.gen(function* () {
        const { client, brokerage, typed } = yield* setup
        const aporte = yield* typed(
          brokerage.id,
          '2026-09-01',
          100_000,
          'Aporte CDB',
        )
        const { positionId } = yield* client.investments.classify({
          payload: {
            entryId: aporte.entryId!,
            newPosition: {
              name: 'CDB Banco',
              assetClassId: 'fixed-income',
              reserve: false,
            },
          },
        })
        yield* client.imports.upload({
          payload: upload(
            brokerage.id,
            ofx(
              `<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260901<TRNAMT>1000.00<FITID>x1<MEMO>Aporte CDB</STMTTRN>`,
              '20260901',
              '20260930',
              '1000.00',
            ),
            'xp.ofx',
          ),
        })
        yield* client.manual.removeTransaction({
          params: { externalId: aporte.externalId },
        })
        yield* drain
        const followed = yield* client.investments.snapshot({ query: {} })
        const [bankEntry] = (yield* client.entries.list({
          query: { accountId: brokerage.id },
        })).entries
        const removed = yield* client.investments.unclassify({
          params: { entryId: bankEntry!.id },
        })
        const after = yield* client.investments.snapshot({ query: {} })
        const notClassified = yield* client.investments
          .unclassify({ params: { entryId: bankEntry!.id } })
          .pipe(Effect.flip)
        assert.deepStrictEqual(
          {
            followed: followed.positions.map((position) => [
              position.id === positionId,
              position.movements.map((movement) => [
                movement.entryId === bankEntry!.id,
                movement.amountCents,
              ]),
            ]),
            removed: removed.positionDeleted,
            after: [after.positions.length, after.available.length],
            notClassified:
              'reason' in notClassified ? notClassified.reason : null,
          },
          {
            followed: [[true, [[true, 100_000]]]],
            removed: true,
            after: [0, 1],
            notClassified: 'not_classified',
          },
        )
      }).pipe(Effect.provide(apiTest())),
  )

  it.effect(
    'gives the plan the reserve the positions marked as reserve hold',
    () =>
      Effect.gen(function* () {
        const { client, brokerage, typed } = yield* setup
        const before = (yield* client.dashboard.month({ query: {} })).reserve
        const aporte = yield* typed(
          brokerage.id,
          '2026-09-01',
          250_000,
          'Aporte',
        )
        yield* client.investments.classify({
          payload: {
            entryId: aporte.entryId!,
            newPosition: {
              name: 'Tesouro Selic',
              assetClassId: 'fixed-income',
              reserve: true,
            },
          },
        })
        const after = (yield* client.dashboard.month({ query: {} })).reserve
        assert.deepStrictEqual(
          [before.currentCents, after.currentCents],
          [0, 250_000],
        )
      }).pipe(Effect.provide(apiTest())),
  )

  it.effect('leaves a position without a quote out of the total in reais', () =>
    Effect.gen(function* () {
      const { client, open, typed } = yield* setup
      const usd = yield* open('Corretora EUA', 'investment', 'USD')
      const deposit = yield* typed(usd.id, '2026-09-01', 50_000, 'Wire')
      yield* client.investments.classify({
        payload: {
          entryId: deposit.entryId!,
          newPosition: { name: 'VT', assetClassId: 'stocks', reserve: false },
        },
      })
      const snapshot = yield* client.investments.snapshot({ query: {} })
      assert.deepStrictEqual(
        {
          position: [
            snapshot.positions[0]!.currency,
            snapshot.positions[0]!.currentCents,
            snapshot.positions[0]!.currentBrlCents,
          ],
          summary: [
            snapshot.summary.totalBrlCents,
            snapshot.summary.missingQuoteCount,
            snapshot.summary.byCurrency,
          ],
        },
        {
          position: ['USD', 50_000, null],
          summary: [
            0,
            1,
            [
              {
                currency: 'USD',
                currentCents: 50_000,
                contributedCents: 50_000,
              },
            ],
          ],
        },
      )
    }).pipe(Effect.provide(apiTest())),
  )
  it.effect(
    'values a foreign position in reais at the rate of the reference date',
    () =>
      Effect.gen(function* () {
        const { client, open, typed } = yield* setup
        const usd = yield* open('Corretora EUA', 'investment', 'USD')
        const deposit = yield* typed(usd.id, '2026-09-01', 50_000, 'Wire')
        yield* client.investments.classify({
          payload: {
            entryId: deposit.entryId!,
            newPosition: { name: 'VT', assetClassId: 'stocks', reserve: false },
          },
        })
        const snapshot = yield* client.investments.snapshot({ query: {} })
        assert.deepStrictEqual(
          [
            snapshot.positions[0]!.currentBrlCents,
            snapshot.positions[0]!.quote,
            snapshot.summary.totalBrlCents,
            snapshot.summary.missingQuoteCount,
          ],
          [
            // US$ 500.00 at R$ 5.25
            262_500,
            { date: '2026-10-02', rateMicros: 5_250_000, source: 'Fake' },
            262_500,
            0,
          ],
        )
      }).pipe(
        Effect.provide(
          apiTest({
            rates: {
              USD: [
                ['2026-09-30', 5_200_000],
                ['2026-10-02', 5_250_000],
              ],
            },
          }),
        ),
      ),
  )

  it.effect('lists unplaced movements older than a page of placed ones', () =>
    Effect.gen(function* () {
      const { client, brokerage, typed } = yield* setup
      // 202 daily contributions; the newest 201 are placed, more than the
      // 200 movements a page reads, so only the oldest is left.
      const created = yield* Effect.forEach(
        Array.from({ length: 202 }, (_, day) => day),
        (day) =>
          typed(
            brokerage.id,
            DateTime.formatIsoDate(
              DateTime.add(DateTime.makeUnsafe('2026-01-01'), { days: day }),
            ),
            10_000,
            `Aporte ${day}`,
          ),
      )
      yield* drain
      const { positionId } = yield* client.investments.classify({
        payload: {
          entryId: created[201]!.entryId!,
          newPosition: {
            name: 'Tesouro Selic 2029',
            assetClassId: 'fixed-income',
            reserve: false,
          },
        },
      })
      yield* Effect.forEach(created.slice(1, 201), (movement) =>
        client.investments.classify({
          payload: { entryId: movement.entryId!, positionId },
        }),
      )
      const snapshot = yield* client.investments.snapshot({ query: {} })
      assert.deepStrictEqual(
        {
          movements: snapshot.positions[0]!.movements.length,
          available: snapshot.available.map((entry) => entry.description),
        },
        { movements: 201, available: ['Aporte 0'] },
      )
    }).pipe(Effect.provide(apiTest())),
  )
})
