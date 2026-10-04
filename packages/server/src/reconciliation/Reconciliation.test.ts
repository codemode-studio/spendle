import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { Imports } from '../imports/Imports.ts'
import { Accounts, CardTerms } from '../ledger/Accounts.ts'
import { Entries } from '../ledger/Entries.ts'
import { drain, openFinanceTest } from '../testing/FakePluggy.ts'
import { Reconciliation } from './Reconciliation.ts'

const ofx = (lines: string, tag = 'STMTRS') =>
  new TextEncoder().encode(`OFXHEADER:100
CHARSET:UTF-8

<OFX><MSGS><${tag}><CURDEF>BRL<BANKTRANLIST>${lines}</BANKTRANLIST></${tag}></MSGS></OFX>`)

const line = (fitid: string, date: string, amount: string, memo: string) =>
  `<STMTTRN><DTPOSTED>${date}<TRNAMT>${amount}<FITID>${fitid}<MEMO>${memo}</STMTTRN>`

// Three own accounts with statements already imported.
const setup = Effect.gen(function* () {
  const accounts = yield* Accounts
  const imports = yield* Imports
  const owner = yield* accounts.createOwner({
    name: 'Família',
    kind: 'household',
  })
  const open = (name: string, card?: CardTerms) =>
    accounts.open({
      ownerId: owner.id,
      institutionName: name,
      name,
      kind: card ? 'credit_card' : 'checking',
      purpose: 'operating',
      currency: 'BRL',
      ...(card ? { card } : {}),
    })
  const nubank = yield* open('Nubank')
  const inter = yield* open('Inter')
  const card = yield* open(
    'Nubank Cartão',
    new CardTerms({
      closingDay: 3,
      dueDay: 10,
      limitCents: null,
      lastFour: null,
    }),
  )

  yield* imports.importFile({
    accountId: nubank.id,
    fileName: 'nubank.ofx',
    bytes: ofx(
      line('n1', '20260910', '-500.00', 'Pix enviado Donald') +
        line('n2', '20260912', '-1500.00', 'Pagamento fatura') +
        line('n3', '20260915', '-80.00', 'Mercado'),
    ),
  })
  yield* imports.importFile({
    accountId: inter.id,
    fileName: 'inter.ofx',
    bytes: ofx(line('i1', '20260910', '500.00', 'Pix recebido Donald')),
  })
  yield* imports.importFile({
    accountId: card.id,
    fileName: 'cartao.ofx',
    bytes: ofx(
      line('c1', '20260914', '1500.00', 'Pagamento recebido'),
      'CCSTMTRS',
    ),
  })
  yield* drain

  const entries = yield* Entries
  const entryId = (accountId: string, amountCents: number) =>
    Effect.map(
      entries.entries(accountId),
      (found) => found.find((entry) => entry.amountCents === amountCents)!.id,
    )
  return { reconciliation: yield* Reconciliation, nubank, inter, card, entryId }
})

const shape = (
  relations: ReadonlyArray<{ kind: string; status: string; origin: string }>,
) =>
  relations.map((relation) => [relation.kind, relation.status, relation.origin])

describe('Reconciliation', () => {
  it.effect('confirms a transfer and a card payment between own accounts', () =>
    Effect.gen(function* () {
      const { reconciliation } = yield* setup
      assert.deepStrictEqual(shape(yield* reconciliation.relations), [
        ['card_payment', 'confirmed', 'auto'],
        ['internal_transfer', 'confirmed', 'auto'],
      ])
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'drops a rejected relation for good, even after entries change',
    () =>
      Effect.gen(function* () {
        const { reconciliation, nubank } = yield* setup
        const transfer = (yield* reconciliation.relations).find(
          (relation) => relation.kind === 'internal_transfer',
        )!
        yield* reconciliation.decide(transfer.key, 'rejected')

        // A new statement re-resolves the account and rebuilds relations.
        yield* (yield* Imports).importFile({
          accountId: nubank.id,
          fileName: 'nubank-2.ofx',
          bytes: ofx(line('n4', '20260920', '-10.00', 'Café')),
        })
        yield* drain

        assert.deepStrictEqual(shape(yield* reconciliation.relations), [
          ['card_payment', 'confirmed', 'auto'],
        ])
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'pairs entries the person links by hand and refuses non-pairs',
    () =>
      Effect.gen(function* () {
        const { reconciliation, nubank, inter, entryId } = yield* setup
        // Receive R$ 80,00 on Inter a week after the market purchase: no automatic match.
        yield* (yield* Imports).importFile({
          accountId: inter.id,
          fileName: 'inter-2.ofx',
          bytes: ofx(line('i2', '20260925', '80.00', 'Reembolso')),
        })
        yield* drain
        const market = yield* entryId(nubank.id, -8000)
        const refund = yield* entryId(inter.id, 8000)

        const key = yield* reconciliation.link({
          outflowEntryId: market,
          inflowEntryId: refund,
        })
        const linked = (yield* reconciliation.relations).find(
          (relation) => relation.key === key,
        )
        assert.deepStrictEqual(
          [linked?.status, linked?.origin],
          ['confirmed', 'person'],
        )

        const error = yield* reconciliation
          .link({ outflowEntryId: refund, inflowEntryId: market })
          .pipe(Effect.flip)
        assert.strictEqual(
          error._tag === 'ReconciliationError' && error.reason,
          'not_a_pair',
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )
})
