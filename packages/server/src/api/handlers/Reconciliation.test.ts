import { assert, describe, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Statement from 'effect/sql/Statement'
import * as Tracer from 'effect/Tracer'

import { apiClient, apiTest } from '../../testing/ApiTest.ts'
import { drain } from '../../testing/FakePluggy.ts'

const ofx = (lines: string, tag = 'STMTRS') => `OFXHEADER:100
CHARSET:UTF-8

<OFX><MSGS><${tag}><CURDEF>BRL<BANKTRANLIST>${lines}</BANKTRANLIST></${tag}></MSGS></OFX>`

const line = (fitid: string, date: string, amount: string, memo: string) =>
  `<STMTTRN><DTPOSTED>${date}<TRNAMT>${amount}<FITID>${fitid}<MEMO>${memo}</STMTTRN>`

const upload = (accountId: string, content: string) => {
  const data = new FormData()
  data.append('accountId', accountId)
  data.append('file', new Blob([content]), `${accountId}.ofx`)
  return data
}

// Nubank sends R$ 500 to Inter and pays the card's R$ 1.500 bill.
const setup = Effect.gen(function* () {
  const client = yield* apiClient()
  const owner = yield* client.owners.create({
    payload: { name: 'Donald Silveira', kind: 'person' },
  })
  const open = (name: string, card?: { closingDay: number; dueDay: number }) =>
    client.accounts.open({
      payload: {
        ownerId: owner.id,
        institutionName: name,
        name,
        kind: card ? 'credit_card' : 'checking',
        purpose: 'operating',
        currency: 'BRL',
        ...(card
          ? { card: { ...card, limitCents: null, lastFour: null } }
          : {}),
      },
    })
  const nubank = yield* open('Nubank')
  const inter = yield* open('Inter')
  const card = yield* open('Nubank Cartão', { closingDay: 3, dueDay: 10 })
  for (const [account, content] of [
    [
      nubank,
      ofx(
        line('n1', '20260910', '-500.00', 'Pix enviado Donald') +
          line('n2', '20260912', '-1500.00', 'Pagamento fatura') +
          line('n3', '20260915', '-80.00', 'Mercado'),
      ),
    ],
    [inter, ofx(line('i1', '20260910', '500.00', 'Pix recebido Donald'))],
    [
      card,
      ofx(line('c1', '20260914', '1500.00', 'Pagamento recebido'), 'CCSTMTRS'),
    ],
  ] as const)
    yield* client.imports.upload({ payload: upload(account.id, content) })
  yield* drain
  return { client, nubank, inter, card }
})

describe('reconciliation API', () => {
  it.effect('lists relations with both entries and records decisions', () =>
    Effect.gen(function* () {
      const { client, inter } = yield* setup
      const before = yield* client.reconciliation.relations({ query: {} })
      const transfer = before.find(
        (relation) => relation.kind === 'internal_transfer',
      )!
      yield* client.reconciliation.decide({
        payload: { key: transfer.key, decision: 'rejected' },
      })
      const after = yield* client.reconciliation.relations({ query: {} })
      const ofInter = yield* client.reconciliation.relations({
        query: { accountId: inter.id },
      })
      assert.deepStrictEqual(
        {
          before: before.map((relation) => [
            relation.kind,
            relation.outflow?.amountCents,
            relation.inflow?.amountCents,
          ]),
          after: after.map((relation) => relation.kind),
          ofInter: ofInter.length,
        },
        {
          before: [
            ['card_payment', -150000, 150000],
            ['internal_transfer', -50000, 50000],
          ],
          after: ['card_payment'],
          ofInter: 0,
        },
      )
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect('links a pair the person knows and refuses one that is not', () =>
    Effect.gen(function* () {
      const { client, nubank, inter } = yield* setup
      const transfer = (yield* client.reconciliation.relations({
        query: { kind: 'internal_transfer' },
      }))[0]!
      yield* client.reconciliation.decide({
        payload: { key: transfer.key, decision: 'rejected' },
      })
      const linked = yield* client.reconciliation.link({
        payload: {
          outflowEntryId: transfer.outflowEntryId,
          inflowEntryId: transfer.inflowEntryId,
        },
      })
      const relations = yield* client.reconciliation.relations({
        query: { accountId: nubank.id, status: 'confirmed' },
      })
      const market = (yield* client.entries.list({
        query: { text: 'Mercado' },
      })).entries[0]!
      const received = (yield* client.entries.list({
        query: { accountId: inter.id },
      })).entries[0]!
      const refused = yield* client.reconciliation
        .link({
          payload: { outflowEntryId: market.id, inflowEntryId: received.id },
        })
        .pipe(Effect.flip)
      const unknown = yield* client.reconciliation
        .decide({ payload: { key: 'nope', decision: 'confirmed' } })
        .pipe(Effect.flip)

      assert.deepStrictEqual(
        {
          linked: relations.find((relation) => relation.key === linked.key)
            ?.origin,
          errors: [refused, unknown].map((error) => [
            error._tag,
            'reason' in error ? error.reason : null,
          ]),
          orphaned: yield* client.reconciliation.orphanedDecisions(),
        },
        {
          linked: 'person',
          errors: [
            ['Rejected', 'not_a_pair'],
            ['NotFound', 'relation_not_found'],
          ],
          orphaned: [],
        },
      )
    }).pipe(Effect.provide(apiTest())),
  )

  it.effect(
    'answers a decision once the categories it changes are rebuilt',
    () =>
      Effect.gen(function* () {
        // Signalled when a request starts waiting for the projections.
        const settling = yield* Deferred.make<void>()
        const base = yield* Effect.tracer
        const observe = Tracer.make({
          ...(base.context ? { context: base.context } : {}),
          span: (options) => {
            if (options.name === 'Reactors.settle')
              Deferred.doneUnsafe(settling, Effect.void)
            return base.span(options)
          },
        })
        yield* Effect.gen(function* () {
          const { client, nubank } = yield* setup
          const transfer = (yield* client.reconciliation.relations({
            query: { kind: 'internal_transfer' },
          }))[0]!
          // What the transactions screen reads right after the response.
          const sentCategory = Effect.map(
            client.entries.list({
              query: { accountId: nubank.id, text: 'Pix' },
            }),
            (page) => page.entries[0]?.category?.categoryId ?? null,
          )
          const before = yield* sentCategory

          // A catch-up holds the categorizer at its cursor until a request
          // settles, so no background pass rebuilds categories before then.
          const reached = yield* Deferred.make<void>()
          const hold: Statement.Transformer = (statement) => {
            const [text, params] = statement.compile()
            return text.includes('FROM reactor_cursors') &&
              params.includes('categorizer') &&
              !Deferred.isDoneUnsafe(reached)
              ? Deferred.succeed(reached, undefined).pipe(
                  Effect.andThen(Deferred.await(settling)),
                  Effect.as(statement),
                )
              : Effect.succeed(statement)
          }
          const held = yield* drain.pipe(
            Effect.provideService(Statement.CurrentTransformer, hold),
            Effect.forkChild,
          )
          yield* Deferred.await(reached)

          yield* client.reconciliation.decide({
            payload: { key: transfer.key, decision: 'rejected' },
          })
          const rejected = yield* sentCategory
          yield* Deferred.succeed(settling, undefined)
          yield* Fiber.join(held)

          assert.deepStrictEqual(
            { status: transfer.status, before, rejected },
            { status: 'confirmed', before: 'transfer', rejected: null },
          )
        }).pipe(Effect.provide(apiTest()), Effect.withTracer(observe))
      }),
  )
})
