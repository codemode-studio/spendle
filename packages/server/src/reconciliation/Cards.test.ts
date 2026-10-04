import { assert, describe, it } from '@effect/vitest'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'

import { Imports } from '../imports/Imports.ts'
import { Accounts, CardTerms } from '../ledger/Accounts.ts'
import { Observations } from '../ledger/Observations.ts'
import { syntheticPdf } from '../testing/SyntheticPdf.ts'
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
const addCard = (
  ownerId: string,
  lastFour: string | null,
  lines: string,
  institutionName = 'Nubank',
) =>
  Effect.gen(function* () {
    const accounts = yield* Accounts
    const imports = yield* Imports
    const card = yield* accounts.open({
      ownerId,
      institutionName,
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

// A Nubank card closing on the 3rd and a bank account, with the given card
// and bank OFX lines, on 20 August 2026.
const history = (cardLines: string, bankLines: string) =>
  Effect.gen(function* () {
    yield* august20
    const accounts = yield* Accounts
    const imports = yield* Imports
    const owner = yield* accounts.createOwner({ name: 'Eu', kind: 'person' })
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
    yield* imports.importFile({
      accountId: card.id,
      fileName: 'cartao.ofx',
      bytes: ofx('CCSTMTRS', cardLines),
    })
    yield* imports.importFile({
      accountId: bank.id,
      fileName: 'conta.ofx',
      bytes: ofx('STMTRS', bankLines),
    })
    yield* drain
    return { cards: yield* Cards, bank, card, owner }
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
      assert.deepStrictEqual(summary(result.cycles)[0], [
        '2026-08-03',
        -20000,
        0,
        'overdue',
        [],
      ])
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
  it.effect(
    'counts a bank-only payment by what was owed on its date, not after later payments',
    () =>
      Effect.gen(function* () {
        const { cards, card } = yield* history(
          line('c1', '20260610', '-100.00', 'Mercado') +
            line('c2', '20260715', '-200.00', 'Hotel') +
            line('c3', '20260808', '200.00', 'Pagamento recebido'),
          line('b1', '20260708', '-100.00', 'PAGAMENTO FATURA NUBANK'),
        )
        const result = yield* cards.cycles(card.id)
        assert.deepStrictEqual(summary(result.cycles).slice(0, 2), [
          ['2026-07-03', -10000, 10000, 'paid', ['bank']],
          ['2026-08-03', -20000, 20000, 'paid', ['card']],
        ])
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('pays the bill a bank debit matched, not the oldest one', () =>
    Effect.gen(function* () {
      const { cards, card } = yield* history(
        line('c1', '20260610', '-100.00', 'Mercado') +
          line('c2', '20260715', '-200.00', 'Hotel'),
        line('b1', '20260805', '-200.00', 'PAGAMENTO FATURA NUBANK'),
      )
      const result = yield* cards.cycles(card.id)
      assert.deepStrictEqual(summary(result.cycles).slice(0, 2), [
        ['2026-07-03', -10000, 0, 'overdue', []],
        ['2026-08-03', -20000, 20000, 'paid', ['bank']],
      ])
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'takes a bank debit that is only suggested as another pairing',
    () =>
      Effect.gen(function* () {
        const { cards, card } = yield* setup
        const imports = yield* Imports
        // A cashback of the same amount on the day of August's payment is
        // suggested as its card side; it is a credit, not the payment.
        yield* imports.importFile({
          accountId: card.id,
          fileName: 'cashback.ofx',
          bytes: ofx('CCSTMTRS', line('c5', '20260808', '200.00', 'Cashback')),
        })
        yield* drain
        const relations = yield* (yield* Reconciliation).relations
        const result = yield* cards.cycles(card.id)
        assert.deepStrictEqual(
          [
            relations.some(
              (relation) =>
                relation.kind === 'card_payment' &&
                relation.status === 'suggested',
            ),
            summary(result.cycles)[1],
          ],
          [true, ['2026-08-03', -20000, 20000, 'paid', ['bank']]],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('does not take a reference number for a contradicting card', () =>
    Effect.gen(function* () {
      const { cards, bank, owner } = yield* setup
      const inter = yield* addCard(
        owner.id,
        '1234',
        line('o1', '20260715', '-90.00', 'Livraria'),
        'Banco Inter',
      )
      yield* payFromBank(
        bank.id,
        'b3',
        '-90.00',
        'PAGAMENTO FATURA NUBANK BOLETO REF 1234',
      )
      const result = yield* cards.cycles(inter.id)
      assert.deepStrictEqual(summary(result.cycles)[0], [
        '2026-08-03',
        -9000,
        0,
        'overdue',
        [],
      ])
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'follows the provider when it moves a purchase to another bill',
    () =>
      Effect.gen(function* () {
        const { cards, card } = yield* history('', '')
        const observations = yield* Observations
        const source = yield* observations.registerSource({
          kind: 'open_finance',
          externalRef: 'provider-card',
          label: 'Cartão',
        })
        const report = (billOfPurchase: string) =>
          observations.recordTransactions({
            sourceId: source.id,
            accountId: card.id,
            transactions: [
              {
                id: 'purchase',
                on: '2026-07-02',
                cents: -10000,
                bill: billOfPurchase,
              },
              { id: 'fee', on: '2026-07-09', cents: -500, bill: 'bill-b' },
            ].map((item) => ({
              externalId: item.id,
              bookedOn: item.on,
              amountCents: item.cents,
              currency: 'BRL',
              description: item.id,
              status: 'posted' as const,
              raw: { installment: { billId: item.bill } },
            })),
          })
        yield* report('bill-b')
        yield* drain
        const before = yield* cards.cycles(card.id)
        // The corrected report puts the purchase on the earlier bill.
        yield* report('bill-a')
        yield* drain
        const after = yield* cards.cycles(card.id)
        const placed = (cycles: ReadonlyArray<CardCycle>) =>
          cycles.slice(0, 2).map((cycle) => [cycle.closingOn, cycle.totalCents])
        assert.deepStrictEqual(
          [placed(before.cycles), placed(after.cycles)],
          [
            [
              ['2026-07-03', 0],
              ['2026-08-03', -10500],
            ],
            [
              ['2026-07-03', -10000],
              ['2026-08-03', -500],
            ],
          ],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'bills what an Inter statement leaves due after a payment before the cut, by its printed deadline',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe('2026-08-12T15:00:00Z')),
        )
        const accounts = yield* Accounts
        const imports = yield* Imports
        const owner = yield* accounts.createOwner({
          name: 'Eu',
          kind: 'person',
        })
        const card = yield* accounts.open({
          ownerId: owner.id,
          institutionName: 'Banco Inter',
          purpose: 'operating',
          currency: 'BRL',
          name: 'Cartão Inter',
          kind: 'credit_card',
          card: new CardTerms({
            closingDay: 3,
            dueDay: 10,
            limitCents: null,
            lastFour: null,
          }),
        })
        yield* imports.importFile({
          accountId: card.id,
          fileName: 'fatura-inter.pdf',
          bytes: syntheticPdf([
            'Banco Inter S/A',
            'Resumo da fatura',
            'Este e o valor que voce precisa pagar nesse mes 15/08/2026',
            'Fatura atual R$ 50,00',
            'Valor antecipado R$ 100,00',
            'Despesas do mes R$ 150,00',
            'Despesas da fatura',
            'CARTAO 1234****5678',
            '10 de jul. 2026 Mercado - R$ 150,00',
            '20 de jul. 2026 PAGAMENTO ON LINE - + R$ 100,00',
            'Data de corte: 04/09/2026',
          ]),
        })
        yield* drain
        const result = yield* (yield* Cards).cycles(card.id)
        const cycle = result.cycles[0]
        assert.deepStrictEqual(
          [
            cycle?.closingOn,
            cycle?.billedCents,
            cycle?.paidCents,
            cycle?.dueOn,
            cycle?.due,
            cycle?.status,
            cycle?.statement,
            result.unappliedCents,
          ],
          [
            '2026-08-04',
            5000,
            0,
            '2026-08-15',
            'statement',
            'due',
            { observedCents: -5000, deductedCents: 10000, differenceCents: 0 },
            0,
          ],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )
})
