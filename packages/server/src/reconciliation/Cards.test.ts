import { assert, describe, it } from '@effect/vitest'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'

import { Imports } from '../imports/Imports.ts'
import { Accounts, CardTerms } from '../ledger/Accounts.ts'
import { drain, openFinanceTest } from '../testing/FakePluggy.ts'
import { Cards } from './Cards.ts'
import type { CardCycle } from './Cards.ts'
import { Reconciliation } from './Reconciliation.ts'

const ofx = (
  tag: 'STMTRS' | 'CCSTMTRS',
  lines: string,
  ledger = '',
  currency = 'BRL',
) =>
  new TextEncoder().encode(`OFXHEADER:100
CHARSET:UTF-8

<OFX><MSGS><${tag}><CURDEF>${currency}<BANKTRANLIST>${lines}</BANKTRANLIST>${ledger}</${tag}></MSGS></OFX>`)

const line = (fitid: string, date: string, amount: string, memo: string) =>
  `<STMTTRN><DTPOSTED>${date}<TRNAMT>${amount}<FITID>${fitid}<MEMO>${memo}</STMTTRN>`

// A card closing on the 3rd, due on the 10th, and the bank account that pays it.
const august20 = TestClock.setTime(
  DateTime.toEpochMillis(DateTime.makeUnsafe('2026-08-20T15:00:00Z')),
)

const setup = Effect.gen(function* () {
  yield* august20
  const accounts = yield* Accounts
  const imports = yield* Imports
  const owner = yield* accounts.createOwner({
    name: 'Família',
    kind: 'household',
  })
  const base = {
    ownerId: owner.id,
    institutionName: 'Nubank',
    purpose: 'operating',
    currency: 'BRL',
  } as const
  const bank = yield* accounts.open({
    ...base,
    name: 'Conta',
    kind: 'checking',
  })
  const card = yield* accounts.open({
    ...base,
    name: 'Cartão',
    kind: 'credit_card',
    card: new CardTerms({
      closingDay: 3,
      dueDay: 10,
      limitCents: null,
      lastFour: null,
    }),
  })

  // June's bill (R$ 150,00) is paid and lands on the card; July's (R$ 200,00)
  // is paid from the bank only, as when the card statement is a PDF.
  yield* imports.importFile({
    accountId: card.id,
    fileName: 'cartao.ofx',
    bytes: ofx(
      'CCSTMTRS',
      line('c1', '20260610', '-100.00', 'Mercado') +
        line('c2', '20260620', '-50.00', 'Posto') +
        line('c3', '20260709', '150.00', 'Pagamento recebido') +
        line('c4', '20260715', '-200.00', 'Hotel'),
      '<LEDGERBAL><BALAMT>-150.00<DTASOF>20260703</LEDGERBAL>',
    ),
  })
  yield* imports.importFile({
    accountId: bank.id,
    fileName: 'conta.ofx',
    bytes: ofx(
      'STMTRS',
      line('b1', '20260708', '-150.00', 'Pagamento fatura') +
        line('b2', '20260808', '-200.00', 'PAGAMENTO FATURA NUBANK'),
    ),
  })
  yield* drain
  return { cards: yield* Cards, bank, card, owner }
})

const summary = (cycles: ReadonlyArray<CardCycle>) =>
  cycles.map((cycle) => [
    cycle.closingOn,
    cycle.totalCents,
    cycle.paidCents,
    cycle.status,
    cycle.payments.map((payment) => payment.via),
  ])

// A second card and a bank debit, to test which card a bill payment names.
const addCard = (ownerId: string, lastFour: string | null, lines: string) =>
  Effect.gen(function* () {
    const accounts = yield* Accounts
    const imports = yield* Imports
    const card = yield* accounts.open({
      ownerId,
      institutionName: 'Nubank',
      purpose: 'operating',
      currency: 'BRL',
      name: `Cartão ${lastFour ?? 'extra'}`,
      kind: 'credit_card',
      card: new CardTerms({
        closingDay: 3,
        dueDay: 10,
        limitCents: null,
        lastFour,
      }),
    })
    yield* imports.importFile({
      accountId: card.id,
      fileName: `${card.id}.ofx`,
      bytes: ofx('CCSTMTRS', lines),
    })
    return card
  })

const payFromBank = (
  accountId: string,
  fitid: string,
  amount: string,
  memo: string,
  date = '20260807',
  currency = 'BRL',
) =>
  Effect.gen(function* () {
    const imports = yield* Imports
    yield* imports.importFile({
      accountId,
      fileName: `${fitid}.ofx`,
      bytes: ofx('STMTRS', line(fitid, date, amount, memo), '', currency),
    })
    yield* drain
  })

describe('Cards', () => {
  it.effect(
    'settles each closed cycle from the card credit or only the bank debit',
    () =>
      Effect.gen(function* () {
        const { cards, card } = yield* setup
        const result = yield* cards.cycles(card.id)
        assert.deepStrictEqual(summary(result.cycles), [
          ['2026-07-03', -15000, 15000, 'paid', ['card']],
          ['2026-08-03', -20000, 20000, 'paid', ['bank']],
          ['2026-09-03', 0, 0, 'open', []],
        ])
        // A card OFX ledger balance is not an issued statement.
        assert.isTrue(result.cycles.every((cycle) => cycle.statement === null))
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'pays only the card a bank debit names, by its last four digits',
    () =>
      Effect.gen(function* () {
        const { cards, bank, owner } = yield* setup
        const other = yield* addCard(
          owner.id,
          '1234',
          line('o1', '20260715', '-90.00', 'Livraria'),
        )
        yield* payFromBank(bank.id, 'b3', '-90.00', 'PAGAMENTO FATURA NUBANK')
        const unnamed = yield* cards.cycles(other.id)
        yield* payFromBank(
          bank.id,
          'b4',
          '-90.00',
          'PAGAMENTO FATURA NUBANK 1234',
          '20260815',
        )
        const named = yield* cards.cycles(other.id)
        assert.deepStrictEqual(
          [unnamed.cycles[0]?.paidCents, named.cycles[0]?.paidCents],
          [0, 9000],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('never lets one debit pay two cards of the same bank', () =>
    Effect.gen(function* () {
      const { cards, card, owner } = yield* setup
      yield* addCard(owner.id, null, line('o1', '20260715', '-200.00', 'Hotel'))
      const result = yield* cards.cycles(card.id)
      assert.deepStrictEqual(summary(result.cycles)[1], [
        '2026-08-03',
        -20000,
        0,
        'overdue',
        [],
      ])
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('ignores other bills and other currencies', () =>
    Effect.gen(function* () {
      yield* august20
      const accounts = yield* Accounts
      const imports = yield* Imports
      const owner = yield* accounts.createOwner({ name: 'Eu', kind: 'person' })
      const card = yield* accounts.open({
        ownerId: owner.id,
        institutionName: 'Nubank',
        purpose: 'operating',
        currency: 'BRL',
        name: 'Cartão',
        kind: 'credit_card',
        card: new CardTerms({
          closingDay: 3,
          dueDay: 10,
          limitCents: null,
          lastFour: null,
        }),
      })
      const bank = yield* accounts.open({
        ownerId: owner.id,
        institutionName: 'Inter',
        purpose: 'operating',
        currency: 'BRL',
        name: 'Conta',
        kind: 'checking',
      })
      const dollars = yield* accounts.open({
        ownerId: owner.id,
        institutionName: 'Nubank',
        purpose: 'operating',
        currency: 'USD',
        name: 'Conta global',
        kind: 'checking',
      })
      yield* imports.importFile({
        accountId: card.id,
        fileName: 'cartao.ofx',
        bytes: ofx('CCSTMTRS', line('c1', '20260715', '-200.00', 'Hotel')),
      })
      yield* payFromBank(bank.id, 'b1', '-200.00', 'PAGAMENTO FATURA VIVO')
      yield* payFromBank(
        dollars.id,
        'd1',
        '-200.00',
        'PAGAMENTO FATURA NUBANK',
        '20260807',
        'USD',
      )
      const result = yield* (yield* Cards).cycles(card.id)
      assert.strictEqual(result.cycles[1]?.paidCents, 0)
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('does not take a suggested pairing as a bill payment', () =>
    Effect.gen(function* () {
      const { cards, card, bank } = yield* setup
      const imports = yield* Imports
      yield* imports.importFile({
        accountId: card.id,
        fileName: 'cashback.ofx',
        bytes: ofx('CCSTMTRS', line('c5', '20260720', '30.00', 'Cashback')),
      })
      yield* payFromBank(bank.id, 'b5', '-30.00', 'Conta de luz', '20260720')
      const relations = yield* (yield* Reconciliation).relations
      const result = yield* cards.cycles(card.id)
      // The cashback stays a credit on the bill instead of paying it.
      assert.deepStrictEqual(
        [
          relations.some(
            (relation) =>
              relation.kind === 'card_payment' &&
              relation.status === 'suggested',
          ),
          summary(result.cycles)[1],
        ],
        [true, ['2026-08-03', -17000, 0, 'overdue', []]],
      )
    }).pipe(Effect.provide(openFinanceTest())),
  )
  it.effect('refuses an account that is not a card', () =>
    Effect.gen(function* () {
      const { cards, bank } = yield* setup
      const error = yield* cards.cycles(bank.id).pipe(Effect.flip)
      assert.strictEqual(error._tag, 'CardsError')
    }).pipe(Effect.provide(openFinanceTest())),
  )
})
