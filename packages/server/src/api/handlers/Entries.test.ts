import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

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

const september = ofx(
  `<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260905<TRNAMT>1000.00<FITID>a1<MEMO>Salário</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260910<TRNAMT>-100.00<FITID>a2<MEMO>Padaria 50%</STMTTRN>`,
  '20260901',
  '20260930',
  '900.00',
)
const october = ofx(
  `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261002<TRNAMT>-50.00<FITID>b1<MEMO>Farmácia</STMTTRN>`,
  '20261001',
  '20261003',
  '850.00',
)

const upload = (accountId: string, content: string, name: string) => {
  const data = new FormData()
  data.append('accountId', accountId)
  data.append('file', new Blob([content]), name)
  return data
}

// A checking account with September and October statements imported.
const imported = Effect.gen(function* () {
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
  yield* client.imports.upload({
    payload: upload(account.id, september, 'set.ofx'),
  })
  yield* client.imports.upload({
    payload: upload(account.id, october, 'out.ofx'),
  })
  yield* drain
  return { client, owner, account }
})

describe('entries API', () => {
  it.effect('pages through entries, latest first', () =>
    Effect.gen(function* () {
      const { client, account } = yield* imported
      const first = yield* client.entries.list({
        query: { accountId: account.id, limit: 2 },
      })
      const second = yield* client.entries.list({
        query: {
          accountId: account.id,
          limit: 2,
          cursor: first.nextCursor ?? undefined,
        },
      })
      assert.deepStrictEqual(
        {
          first: first.entries.map((entry) => entry.amountCents),
          second: second.entries.map((entry) => entry.amountCents),
          totals: [first.total, second.total],
          last: second.nextCursor,
        },
        {
          first: [-5000, -10000],
          second: [100000],
          totals: [3, 3],
          last: null,
        },
      )
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect('serves a numbered page by offset, in list order', () =>
    Effect.gen(function* () {
      const { client, account } = yield* imported
      const at = (offset: number) =>
        client.entries
          .list({ query: { accountId: account.id, limit: 2, offset } })
          .pipe(
            Effect.map((page) => ({
              amounts: page.entries.map((entry) => entry.amountCents),
              total: page.total,
              more: page.nextCursor !== null,
            })),
          )
      assert.deepStrictEqual(
        { first: yield* at(0), second: yield* at(2), beyond: yield* at(3) },
        {
          first: { amounts: [-5000, -10000], total: 3, more: true },
          second: { amounts: [100000], total: 3, more: false },
          beyond: { amounts: [], total: 3, more: false },
        },
      )
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect('counts entries as the category filters list them', () =>
    Effect.gen(function* () {
      const { client, owner, account } = yield* imported
      // A credit in another own account the day after the bakery debit:
      // a transfer suggestion the person still has to review.
      const savings = yield* client.accounts.open({
        payload: {
          ownerId: owner.id,
          institutionName: 'Itaú',
          name: 'Poupança',
          kind: 'savings',
          purpose: 'reserve',
          currency: 'BRL',
        },
      })
      yield* client.imports.upload({
        payload: upload(
          savings.id,
          ofx(
            `<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260911<TRNAMT>100.00<FITID>c1<MEMO>Transferência</STMTTRN>`,
            '20260901',
            '20260930',
            '100.00',
          ),
          'poupanca.ofx',
        ),
      })
      yield* drain
      const [salary] = (yield* client.entries.list({
        query: { accountId: account.id, direction: 'inflow' },
      })).entries
      yield* client.categoryDecisions.decide({
        params: { entryId: salary!.id },
        payload: { categoryId: 'salary' },
      })
      yield* drain
      const total = (query: Parameters<typeof client.entries.list>[0]) =>
        client.entries.list(query).pipe(Effect.map((page) => page.total))
      const counts = yield* client.entries.counts()
      assert.deepStrictEqual(counts, {
        total: yield* total({ query: {} }),
        review: yield* total({ query: { categoryStatus: 'review' } }),
        uncategorized: yield* total({ query: { categoryStatus: 'none' } }),
      })
      assert.deepStrictEqual(counts, { total: 4, review: 2, uncategorized: 1 })
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect('filters by period, status and words', () =>
    Effect.gen(function* () {
      const { client } = yield* imported
      const amounts = (query: Parameters<typeof client.entries.list>[0]) =>
        client.entries
          .list(query)
          .pipe(
            Effect.map((page) =>
              page.entries.map((entry) => entry.amountCents),
            ),
          )
      assert.deepStrictEqual(
        {
          september: yield* amounts({
            query: { from: '2026-09-01', to: '2026-09-30' },
          }),
          words: yield* amounts({ query: { text: 'padaria' } }),
          literalPercent: yield* amounts({ query: { text: '50%' } }),
          wildcard: yield* amounts({ query: { text: '_' } }),
          pending: yield* amounts({ query: { status: 'pending' } }),
        },
        {
          september: [-10000, 100000],
          words: [-10000],
          literalPercent: [-10000],
          wildcard: [],
          pending: [],
        },
      )
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect(
    'filters by direction and absolute amount, counting across pages',
    () =>
      Effect.gen(function* () {
        const { client } = yield* imported
        const page = (query: Parameters<typeof client.entries.list>[0]) =>
          client.entries.list(query).pipe(
            Effect.map((found) => ({
              amounts: found.entries.map((entry) => entry.amountCents),
              total: found.total,
            })),
          )
        assert.deepStrictEqual(
          {
            inflow: yield* page({ query: { direction: 'inflow' } }),
            outflow: yield* page({ query: { direction: 'outflow', limit: 1 } }),
            between: yield* page({
              query: { minAmountCents: 5000, maxAmountCents: 10000 },
            }),
            large: yield* page({ query: { minAmountCents: 10001 } }),
          },
          {
            inflow: { amounts: [100000], total: 1 },
            outflow: { amounts: [-5000], total: 2 },
            between: { amounts: [-5000, -10000], total: 2 },
            large: { amounts: [100000], total: 1 },
          },
        )
      }).pipe(Effect.provide(apiTest())),
  )

  it.effect('shows an entry with its evidence and category', () =>
    Effect.gen(function* () {
      const { client } = yield* imported
      const [bakery] = (yield* client.entries.list({
        query: { text: 'padaria' },
      })).entries
      const detail = yield* client.entries.get({
        params: { entryId: bakery!.id },
      })
      const missing = yield* client.entries
        .get({ params: { entryId: 'nope' } })
        .pipe(Effect.flip)
      const badCursor = yield* client.entries
        .list({ query: { cursor: 'nope' } })
        .pipe(Effect.flip)
      assert.deepStrictEqual(
        {
          evidence: detail.evidence.map((evidence) => [
            evidence.sourceKind,
            evidence.sourceLabel,
            evidence.description,
          ]),
          category: detail.category?.entryId,
          errors: [missing, badCursor].map((error) => [
            error._tag,
            'reason' in error ? error.reason : null,
          ]),
        },
        {
          evidence: [['file', 'set.ofx', 'Padaria 50%']],
          category: bakery!.id,
          errors: [
            ['NotFound', 'entry_not_found'],
            ['InvalidRequest', 'invalid_cursor'],
          ],
        },
      )
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect('proves the balance between statement closings', () =>
    Effect.gen(function* () {
      const { client, owner, account } = yield* imported
      const proof = yield* client.entries.balanceProof({
        params: { accountId: account.id },
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
      const cardProof = yield* client.entries.balanceProof({
        params: { accountId: card.id },
      })
      assert.isTrue(proof.supported)
      const { checkpoints, ...rest } = proof as Extract<
        typeof proof,
        { supported: true }
      >
      assert.deepStrictEqual(
        checkpoints.map((checkpoint) => [
          checkpoint.asOf,
          checkpoint.sourceKind,
        ]),
        [
          ['2026-09-30', 'file'],
          ['2026-10-03', 'file'],
        ],
      )
      assert.deepStrictEqual(rest, {
        supported: true,
        intervals: [
          {
            from: '2026-09-30',
            to: '2026-10-03',
            expectedChangeCents: -5000,
            postedChangeCents: -5000,
            differenceCents: 0,
          },
        ],
        conflicts: [],
      })
      assert.deepStrictEqual(cardProof, {
        supported: false,
        reason: 'credit_card',
      })
    }).pipe(Effect.provide(apiTest())),
  )
})
