import { assert, describe, it } from '@effect/vitest'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import type * as Schema from 'effect/Schema'
import * as TestClock from 'effect/testing/TestClock'

import { Imports } from '../imports/Imports.ts'
import { Accounts, CardTerms } from '../ledger/Accounts.ts'
import { Observations } from '../ledger/Observations.ts'
import { syntheticPdf } from '../testing/SyntheticPdf.ts'
import {
  card as pluggyCard,
  connect,
  drain,
  openFinanceTest,
  tx,
} from '../testing/FakePluggy.ts'
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
// and bank OFX lines, on 20 August 2026 unless another day is set.
const history = (cardLines: string, bankLines: string, day = august20) =>
  Effect.gen(function* () {
    yield* day
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
    // A statement with no lines is refused, so only histories are imported.
    if (cardLines)
      yield* imports.importFile({
        accountId: card.id,
        fileName: 'cartao.ofx',
        bytes: ofx('CCSTMTRS', cardLines),
      })
    if (bankLines)
      yield* imports.importFile({
        accountId: bank.id,
        fileName: 'conta.ofx',
        bytes: ofx('STMTRS', bankLines),
      })
    yield* drain
    return { cards: yield* Cards, bank, card, owner }
  })

// What a lone Nubank card ending in 1234 that owes R$ 100,00 on 3 August
// gets paid by one R$ 100,00 debit from an Itaú account with this memo.
const paidByDebit = (memo: string) =>
  Effect.gen(function* () {
    yield* august20
    const accounts = yield* Accounts
    const owner = yield* accounts.createOwner({ name: 'Eu', kind: 'person' })
    const bank = yield* accounts.open({
      ownerId: owner.id,
      institutionName: 'Itaú',
      purpose: 'operating',
      currency: 'BRL',
      name: 'Conta',
      kind: 'checking',
    })
    const card = yield* addCard(
      owner.id,
      '1234',
      line('n1', '20260715', '-100.00', 'Livraria'),
    )
    yield* payFromBank(bank.id, 'b1', '-100.00', memo)
    const result = yield* (yield* Cards).cycles(card.id)
    return result.cycles[0]?.paidCents
  }).pipe(Effect.provide(openFinanceTest()))

// Records card lines as one open-finance source reports them, with each
// line's raw payload.
const recordCardLines = (
  accountId: string,
  lines: ReadonlyArray<
    readonly [
      bookedOn: string,
      amountCents: number,
      description: string,
      raw: Schema.Json,
    ]
  >,
) =>
  Effect.gen(function* () {
    const observations = yield* Observations
    const source = yield* observations.registerSource({
      kind: 'open_finance',
      externalRef: 'card-feed',
      label: 'card-feed',
    })
    yield* observations.recordTransactions({
      sourceId: source.id,
      accountId,
      transactions: lines.map(
        ([bookedOn, amountCents, description, raw], index) => ({
          externalId: `line-${index}`,
          bookedOn,
          amountCents,
          currency: 'BRL',
          description,
          status: 'posted' as const,
          raw,
        }),
      ),
    })
    yield* drain
  })

describe('Cards', () => {
  it.effect(
    'infers a bank-only payment only from bill wording that names this card',
    () =>
      Effect.gen(function* () {
        const pays = [
          'PAGAMENTO FATURA NUBANK',
          'PAGTO CARTAO DE CREDITO NUBANK',
          'PAGAMENTO FATURA FINAL: 1234',
          'PAGAMENTO FATURA CARTAO-1234',
          'PAGAMENTO FATURA NUBANK NSU 8765.1234 FINAL 1234',
        ]
        const ignores = [
          // A debit-card purchase is not a bill payment.
          'COMPRA CARTAO DEBITO',
          'COMPRA CARTAO DEBITO NUBANK FINAL 1234',
          'SAQUE CARTAO NUBANK',
          // Bill wording without naming the card: no single-card fallback.
          'PAGAMENTO FATURA CARTAO',
          'PAGAMENTO CARTAO DE CREDITO',
          // Another issuer or ending named.
          'PAGAMENTO FATURA CARTAO INTER',
          'PAGAMENTO FATURA INTER FINAL 1234',
          'PAGAMENTO FATURA NUBANK FINAL: 9999 COMPETENCIA 08/2026',
          'PAGAMENTO FATURA NUBANK FINAL-9999',
          'PAGAMENTO FATURA FINAL 1234 FINAL 5678',
          // An issuer no card has, even beside this card's ending.
          'PAGAMENTO FATURA BANCO BRB FINAL 1234',
          'PAGAMENTO FATURA BRB FINAL 1234',
          'PAGAMENTO FATURA CARTAO BRB FINAL 1234',
          // A reference number, however formatted, is not an ending.
          'PAGAMENTO FATURA BOLETO REF 8765-1234',
          'PAGAMENTO FATURA DOC 8765.1234',
          // Payment wording without a card bill.
          'PAGAMENTO NUBANK FINAL 1234',
        ]
        const results = yield* Effect.forEach([...pays, ...ignores], (memo) =>
          Effect.map(paidByDebit(memo), (paid) => [memo, paid]),
        )
        assert.deepStrictEqual(results, [
          ...pays.map((memo) => [memo, 10000]),
          ...ignores.map((memo) => [memo, 0]),
        ])
      }),
  )

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
          'PAGAMENTO FATURA NUBANK FINAL 1234',
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
  it.effect('projects what instalment purchases still owe', () =>
    Effect.gen(function* () {
      const { cards, card } = yield* setup
      yield* (yield* Imports).importFile({
        accountId: card.id,
        fileName: 'cartao-parcelas.ofx',
        bytes: ofx(
          'CCSTMTRS',
          line('p1', '20260715', '-300.00', 'Magazine Luiza PARC 01/03') +
            line('p2', '20260815', '-300.00', 'Magazine Luiza PARC 02/03'),
        ),
      })
      yield* drain
      const plans = yield* cards.installments(card.id)
      assert.deepStrictEqual(
        plans.map((plan) => [plan.total, plan.seen, plan.remainingCents]),
        [[3, [1, 2], -30000]],
      )
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'reads instalments and the purchase total from Pluggy card metadata',
    () =>
      Effect.gen(function* () {
        const { openFinance } = yield* connect({
          accounts: [pluggyCard],
          transactions: {
            'provider-card': [1, 2].map((number) =>
              tx(`apple-${number}`, `2026-0${7 + number}-20`, {
                accountId: 'provider-card',
                amount: 33.33,
                description: 'Apple Store',
                creditCardMetadata: {
                  installmentNumber: number,
                  totalInstallments: 3,
                  totalAmount: 100,
                  purchaseDate: '2026-07-20T12:00:00.000Z',
                },
              }),
            ),
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
        const plans = yield* (yield* Cards).installments(account.id)
        assert.deepStrictEqual(
          plans.map((plan) => [
            plan.total,
            plan.remaining,
            plan.remainingCents,
          ]),
          [[3, 1, -3334]],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    "bills each cycle as the provider's bills say, and keeps a payment of a bill before the history apart",
    () =>
      Effect.gen(function* () {
        const bill = (
          id: string,
          closing: string,
          due: string,
          total: number,
        ) => ({
          id,
          billClosingDate: `${closing}T00:00:00.000Z`,
          dueDate: `${due}T00:00:00.000Z`,
          totalAmount: total,
        })
        const line = (
          id: string,
          date: string,
          amount: number,
          billId: string | null,
          fields: Parameters<typeof tx>[2] = {},
        ) =>
          tx(id, date, {
            accountId: 'provider-card',
            amount,
            description: id,
            creditCardMetadata: { billId },
            ...fields,
          })
        const payment = (
          id: string,
          date: string,
          amount: number,
          billId: string | null,
        ) =>
          line(id, date, -amount, billId, {
            type: 'CREDIT',
            description: 'PAGAMENTO RECEBIDO',
          })
        const { openFinance } = yield* connect({
          accounts: [pluggyCard],
          // The history starts on 26 June. June's bill was paid in it, on
          // 2 July; July's also bills fuel bought on 24 June.
          bills: {
            'provider-card': [
              bill('june', '2026-06-25', '2026-07-02', 400),
              bill('july', '2026-07-25', '2026-08-03', 250),
              bill('august', '2026-08-25', '2026-09-02', 300),
              bill('september', '2026-09-25', '2026-10-02', 200),
            ],
          },
          transactions: {
            'provider-card': [
              line('fuel', '2026-06-24', 150, 'july'),
              payment('pay-june', '2026-07-02', 400, 'july'),
              line('market', '2026-07-10', 100, 'july'),
              payment('pay-july', '2026-08-03', 250, 'august'),
              line('hotel', '2026-08-05', 300, 'august'),
              payment('pay-august', '2026-09-02', 300, 'september'),
              line('books', '2026-09-10', 200, 'september'),
              payment('pay-september', '2026-10-02', 200, null),
              line('dinner', '2026-10-03', 80, null, { status: 'PENDING' }),
            ],
          },
        })
        const account = yield* openFinance.linkAccount({
          providerAccountId: 'provider-card',
          target: {
            kind: 'credit_card',
            purpose: 'operating',
            card: new CardTerms({
              closingDay: 25,
              dueDay: 2,
              limitCents: null,
              lastFour: '1889',
            }),
          },
          historyMonths: 3,
        })
        yield* drain
        const result = yield* (yield* Cards).cycles(account.id)
        assert.deepStrictEqual(
          {
            cycles: result.cycles.map((cycle) => [
              cycle.closingOn,
              cycle.projectedCents,
              cycle.paidCents,
              cycle.status,
              cycle.statement?.differenceCents ?? null,
            ]),
            unapplied: result.unappliedCents,
            beforeHistory: result.beforeHistoryCents,
          },
          {
            cycles: [
              // The fuel was not copied, which is no gap.
              ['2026-07-25', 25000, 25000, 'paid', 0],
              ['2026-08-25', 30000, 30000, 'paid', 0],
              ['2026-09-25', 20000, 20000, 'paid', 0],
              ['2026-10-25', 8000, 0, 'open', null],
            ],
            unapplied: 0,
            beforeHistory: 40000,
          },
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('combines instalment details different sources report', () =>
    Effect.gen(function* () {
      const { cards, card } = yield* setup
      const observations = yield* Observations
      const record = (
        ref: string,
        installment: (number: number) => Record<string, number>,
      ) =>
        Effect.gen(function* () {
          const source = yield* observations.registerSource({
            kind: 'open_finance',
            externalRef: ref,
            label: ref,
          })
          yield* observations.recordTransactions({
            sourceId: source.id,
            accountId: card.id,
            transactions: [1, 2].map((number) => ({
              externalId: `${ref}-${number}`,
              bookedOn: `2026-0${6 + number}-20`,
              amountCents: -3333,
              currency: 'BRL',
              description: 'Apple Store',
              status: 'posted' as const,
              raw: { installment: installment(number) },
            })),
          })
        })
      yield* record('numbers', (number) => ({ number, total: 3 }))
      yield* record('totals', (number) => ({
        number,
        total: 3,
        totalAmount: 100,
      }))
      yield* drain
      const plans = yield* cards.installments(card.id)
      assert.deepStrictEqual(
        plans.map((plan) => [plan.seen, plan.remainingCents]),
        [[[1, 2], -3334]],
      )
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('gives two same-day purchases at one store their own plans', () =>
    Effect.gen(function* () {
      const { cards, card } = yield* setup
      const observations = yield* Observations
      const source = yield* observations.registerSource({
        kind: 'open_finance',
        externalRef: 'feed',
        label: 'feed',
      })
      yield* observations.recordTransactions({
        sourceId: source.id,
        accountId: card.id,
        transactions: [-3000, -9000].map((amountCents) => ({
          externalId: `apple${amountCents}`,
          bookedOn: '2026-08-15',
          amountCents,
          currency: 'BRL',
          description: 'Apple Store',
          status: 'posted' as const,
          raw: { installment: { number: 1, total: 3 } },
        })),
      })
      yield* drain
      const plans = yield* cards.installments(card.id)
      assert.deepStrictEqual(
        [
          plans.map((plan) => plan.remainingCents).sort((a, b) => a - b),
          new Set(plans.map((plan) => plan.key)).size,
        ],
        [[-18000, -6000], 2],
      )
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'leaves a purchase total unknown once any two sources disagree on it',
    () =>
      Effect.gen(function* () {
        const { cards, card } = yield* setup
        const observations = yield* Observations
        for (const [ref, totalAmount] of [
          ['first', 100],
          ['second', 120],
          ['third', 120],
        ] as const) {
          const source = yield* observations.registerSource({
            kind: 'open_finance',
            externalRef: ref,
            label: ref,
          })
          yield* observations.recordTransactions({
            sourceId: source.id,
            accountId: card.id,
            transactions: [1, 2].map((number) => ({
              externalId: `${ref}-${number}`,
              bookedOn: `2026-0${6 + number}-20`,
              amountCents: -3333,
              currency: 'BRL',
              description: 'Apple Store',
              status: 'posted' as const,
              raw: { installment: { number, total: 3, totalAmount } },
            })),
          })
          yield* drain
        }
        const plans = yield* cards.installments(card.id)
        assert.deepStrictEqual(
          plans.map((plan) => [plan.seen, plan.remainingCents]),
          [[[1, 2], -3333]],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'keeps a purchase total unknown when sources disagree on one instalment and another reports one of them',
    () =>
      Effect.gen(function* () {
        const { cards, card } = yield* setup
        const observations = yield* Observations
        const record = (
          ref: string,
          reports: ReadonlyArray<readonly [number, number]>,
        ) =>
          Effect.gen(function* () {
            const source = yield* observations.registerSource({
              kind: 'open_finance',
              externalRef: ref,
              label: ref,
            })
            yield* observations.recordTransactions({
              sourceId: source.id,
              accountId: card.id,
              transactions: reports.map(([number, totalAmount]) => ({
                externalId: `${ref}-${number}`,
                bookedOn: `2026-0${6 + number}-20`,
                amountCents: -3333,
                currency: 'BRL',
                description: 'Apple Store',
                status: 'posted' as const,
                raw: { installment: { number, total: 3, totalAmount } },
              })),
            })
            yield* drain
          })
        yield* record('first', [[1, 100]])
        yield* record('second', [
          [1, 120],
          [2, 120],
        ])
        const plans = yield* cards.installments(card.id)
        assert.deepStrictEqual(
          plans.map((plan) => [plan.seen, plan.remainingCents]),
          [[[1, 2], -3333]],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'projects the open bill from pending charges, and bills them once they post',
    () =>
      Effect.gen(function* () {
        const { cards, card } = yield* setup
        const observations = yield* Observations
        const source = yield* observations.registerSource({
          kind: 'open_finance',
          externalRef: 'card-feed',
          label: 'card-feed',
        })
        const report = (status: 'pending' | 'posted') =>
          Effect.andThen(
            observations.recordTransactions({
              sourceId: source.id,
              accountId: card.id,
              transactions: [
                {
                  externalId: 'dinner',
                  bookedOn: '2026-08-15',
                  amountCents: -12000,
                  currency: 'BRL',
                  description: 'Restaurante',
                  status,
                  raw: {},
                },
              ],
            }),
            drain,
          )
        const open = Effect.map(cards.cycles(card.id), ({ cycles }) => {
          const cycle = cycles.at(-1)!
          return [
            cycle.closingOn,
            cycle.billedCents,
            cycle.pendingCents,
            cycle.projectedCents,
            cycle.entryIds.length,
          ]
        })
        yield* report('pending')
        const pending = yield* open
        yield* report('posted')
        assert.deepStrictEqual(
          [pending, yield* open],
          [
            ['2026-09-03', 0, 12000, 12000, 1],
            ['2026-09-03', 12000, 0, 12000, 1],
          ],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'projects a pending instalment purchase, and counts it once after it posts',
    () =>
      Effect.gen(function* () {
        const { cards, card } = yield* setup
        const observations = yield* Observations
        const source = yield* observations.registerSource({
          kind: 'open_finance',
          externalRef: 'card-feed',
          label: 'card-feed',
        })
        const report = (status: 'pending' | 'posted') =>
          Effect.andThen(
            observations.recordTransactions({
              sourceId: source.id,
              accountId: card.id,
              transactions: [
                {
                  externalId: 'tv',
                  bookedOn: '2026-08-15',
                  amountCents: -10000,
                  currency: 'BRL',
                  description: 'Fast Shop',
                  status,
                  raw: { installment: { number: 1, total: 12 } },
                },
              ],
            }),
            drain,
          )
        const projection = Effect.map(cards.installments(card.id), (plans) =>
          plans.map((plan) => [
            plan.seen,
            plan.pending,
            plan.entryIds.length,
            plan.remainingCents,
          ]),
        )
        yield* report('pending')
        const pending = yield* projection
        yield* report('posted')
        assert.deepStrictEqual(
          [pending, yield* projection],
          [[[[1], [1], 1, -110000]], [[[1], [], 1, -110000]]],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  // Two R$ 300,00 purchases in three instalments on 4 October, one with the
  // purchase total and one without, on a card closing on the 3rd: each
  // report gives the instalments' numbers, dates and statuses. What
  // `Cards.installments` projects on `now` after each report.
  const instalmentsReported = (
    now: string,
    reports: ReadonlyArray<
      ReadonlyArray<readonly [number, string, 'pending' | 'posted']>
    >,
  ) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe(`${now}T15:00:00Z`)),
      )
      const accounts = yield* Accounts
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
      const observations = yield* Observations
      const source = yield* observations.registerSource({
        kind: 'open_finance',
        externalRef: 'card-feed',
        label: 'card-feed',
      })
      const purchases = [
        ['apple', 'Apple Store', { totalAmount: 300 }],
        ['fast', 'Fast Shop', {}],
      ] as const
      const projections = []
      for (const lines of reports) {
        yield* observations.recordTransactions({
          sourceId: source.id,
          accountId: card.id,
          transactions: purchases.flatMap(([id, description, extra]) =>
            lines.map(([number, bookedOn, status]) => ({
              externalId: `${id}-${number}`,
              bookedOn,
              amountCents: -10000,
              currency: 'BRL',
              description,
              status,
              raw: {
                installment: {
                  number,
                  total: 3,
                  purchaseDate: '2026-10-04',
                  ...extra,
                },
              },
            })),
          ),
        })
        yield* drain
        const plans = yield* (yield* Cards).installments(card.id)
        projections.push(
          plans.map((plan) => [
            plan.description,
            plan.seen,
            plan.pending,
            plan.scheduled,
            plan.entryIds.length,
            plan.remaining,
            plan.remainingCents,
          ]),
        )
      }
      return projections
    })

  it.effect(
    'keeps future-dated instalments in what remains, not in what was billed',
    () =>
      Effect.gen(function* () {
        // On 4 October the open bill closes on 3 November; a refresh brings
        // the later instalments, dated on their own bills.
        assert.deepStrictEqual(
          yield* instalmentsReported('2026-10-04', [
            [[1, '2026-10-04', 'pending']],
            [
              [1, '2026-10-04', 'pending'],
              [2, '2026-11-04', 'pending'],
              [3, '2026-12-04', 'pending'],
            ],
          ]),
          [
            [
              ['Apple Store', [1], [1], [], 1, 2, -20000],
              ['Fast Shop', [1], [1], [], 1, 2, -20000],
            ],
            [
              ['Apple Store', [1], [1], [2, 3], 3, 2, -20000],
              ['Fast Shop', [1], [1], [2, 3], 3, 2, -20000],
            ],
          ],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'bills a future-dated instalment once its own bill is open, counting it once',
    () =>
      Effect.gen(function* () {
        // On 10 November the open bill closes on 3 December and holds the
        // second instalment.
        const pending = [
          [1, '2026-10-04', 'posted'],
          [2, '2026-11-04', 'pending'],
          [3, '2026-12-04', 'pending'],
        ] as const
        const posted = [
          [1, '2026-10-04', 'posted'],
          [2, '2026-11-04', 'posted'],
          [3, '2026-12-04', 'pending'],
        ] as const
        assert.deepStrictEqual(
          yield* instalmentsReported('2026-11-10', [pending, posted]),
          [
            [
              ['Apple Store', [1, 2], [2], [3], 3, 1, -10000],
              ['Fast Shop', [1, 2], [2], [3], 3, 1, -10000],
            ],
            [
              ['Apple Store', [1, 2], [], [3], 3, 1, -10000],
              ['Fast Shop', [1, 2], [], [3], 3, 1, -10000],
            ],
          ],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'takes a purchase total from a source that reports nothing else, and doubts it when another disagrees',
    () =>
      Effect.gen(function* () {
        const { cards, card } = yield* setup
        const observations = yield* Observations
        const record = (
          ref: string,
          description: string,
          installment: (number: number) => Record<string, number>,
        ) =>
          Effect.gen(function* () {
            const source = yield* observations.registerSource({
              kind: 'open_finance',
              externalRef: ref,
              label: ref,
            })
            yield* observations.recordTransactions({
              sourceId: source.id,
              accountId: card.id,
              transactions: [1, 2].map((number) => ({
                externalId: `${ref}-${number}`,
                bookedOn: `2026-0${6 + number}-20`,
                amountCents: -3333,
                currency: 'BRL',
                description,
                status: 'posted' as const,
                raw: { installment: installment(number) },
              })),
            })
          })
        yield* record('apple-numbers', 'Apple Store', (number) => ({
          number,
          total: 3,
        }))
        yield* record('apple-total', 'Apple Store', () => ({
          totalAmount: 100,
        }))
        yield* record('dell-numbers', 'Dell Online', (number) => ({
          number,
          total: 3,
          totalAmount: 100,
        }))
        yield* record('dell-total', 'Dell Online', () => ({
          totalAmount: 120,
        }))
        yield* drain
        const plans = yield* cards.installments(card.id)
        assert.deepStrictEqual(
          plans.map((plan) => [plan.description, plan.remainingCents]),
          [
            ['Apple Store', -3334],
            ['Dell Online', -3333],
          ],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'joins description-only instalments to the first one Pluggy dated on the purchase',
    () =>
      Effect.gen(function* () {
        const { cards, card } = yield* setup
        yield* recordCardLines(card.id, [
          [
            '2026-05-04',
            -10000,
            'Apple Store PARC 01/04',
            { installment: { number: 1, total: 4 } },
          ],
          ['2026-07-10', -10000, 'Apple Store PARC 02/04', null],
          ['2026-08-10', -10000, 'Apple Store PARC 03/04', null],
        ])
        const plans = yield* cards.installments(card.id)
        assert.deepStrictEqual(
          plans.map((plan) => [plan.seen, plan.remainingCents]),
          [[[1, 2, 3], -10000]],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'leaves a purchase total unknown when its instalments disagree on it',
    () =>
      Effect.gen(function* () {
        const { cards, card } = yield* setup
        const metadata = (number: number, totalAmount: number) => ({
          installment: {
            number,
            total: 3,
            totalAmount,
            purchaseDate: '2026-06-15T12:00:00.000Z',
          },
        })
        yield* recordCardLines(card.id, [
          ['2026-06-20', -3333, 'Apple Store', metadata(1, 100)],
          ['2026-07-20', -3333, 'Apple Store', metadata(2, 120)],
          ['2026-06-20', -3333, 'Dell Online', metadata(1, 120)],
          ['2026-07-20', -3333, 'Dell Online', metadata(2, 100)],
        ])
        const plans = yield* cards.installments(card.id)
        assert.deepStrictEqual(
          plans.map((plan) => [plan.description, plan.remainingCents]),
          [
            ['Apple Store', -3333],
            ['Dell Online', -3333],
          ],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'takes the purchase total from metadata when only the description numbers the instalments',
    () =>
      Effect.gen(function* () {
        const { cards, card } = yield* setup
        const metadata = {
          installment: {
            totalAmount: 100,
            purchaseDate: '2026-07-01T12:00:00.000Z',
          },
        }
        yield* recordCardLines(card.id, [
          ['2026-06-15', -3333, 'Loja PARC 01/03', metadata],
          ['2026-07-15', -3333, 'Loja PARC 02/03', metadata],
          // Date-like suffixes on nearby days stay ordinary purchases.
          ['2026-08-03', -10000, 'Padaria 03/10', metadata],
          ['2026-08-04', -10000, 'Padaria 04/10', metadata],
        ])
        const plans = yield* cards.installments(card.id)
        assert.deepStrictEqual(
          plans.map((plan) => [plan.description, plan.remainingCents]),
          [['Loja PARC 02/03', -3334]],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'reads instalments from the description when a payload has no metadata',
    () =>
      Effect.gen(function* () {
        const { cards, card } = yield* setup
        const observations = yield* Observations
        const source = yield* observations.registerSource({
          kind: 'open_finance',
          externalRef: 'bare',
          label: 'bare',
        })
        yield* observations.recordTransactions({
          sourceId: source.id,
          accountId: card.id,
          transactions: [
            [1, null],
            [2, 'not an object'],
            [3, { installment: { number: 'two' } }],
          ].map(([number, raw]) => ({
            externalId: `bare-${number}`,
            bookedOn: `2026-0${5 + (number as number)}-15`,
            amountCents: -30000,
            currency: 'BRL',
            description: `Magazine Luiza PARC 0${number}/04`,
            status: 'posted' as const,
            raw: raw as Schema.Json,
          })),
        })
        yield* drain
        const plans = yield* cards.installments(card.id)
        assert.deepStrictEqual(
          plans.map((plan) => [plan.total, plan.seen, plan.remainingCents]),
          [[4, [1, 2, 3], -30000]],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('never pairs a credit Pluggy calls cashback as a refund', () =>
    Effect.gen(function* () {
      const { card } = yield* setup
      const observations = yield* Observations
      const source = yield* observations.registerSource({
        kind: 'open_finance',
        externalRef: 'cashback',
        label: 'cashback',
      })
      yield* observations.recordTransactions({
        sourceId: source.id,
        accountId: card.id,
        transactions: [
          ['order', '2026-08-01', -1000, {}],
          ['credit', '2026-08-05', 1000, { operationType: 'CASHBACK' }],
        ].map(([externalId, bookedOn, amountCents, raw]) => ({
          externalId: externalId as string,
          bookedOn: bookedOn as string,
          amountCents: amountCents as number,
          currency: 'BRL',
          description: 'Amazon Marketplace',
          status: 'posted' as const,
          raw: raw as Record<string, string>,
        })),
      })
      yield* drain
      const refunds = (yield* (yield* Reconciliation).relations).filter(
        (relation) => relation.kind === 'refund',
      )
      assert.deepStrictEqual(refunds, [])
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

  it.effect(
    'does not count a bank debit as a second payment when its card credit is on this card',
    () =>
      Effect.gen(function* () {
        // Card 1234 owes R$ 100,00 on 3 August and 3 September. Its payment
        // leaves the bank on 5 August and lands on the card on the 6th, while
        // card 5678 receives its own payment on the 5th (R$ 100,00, or
        // R$ 120,00 in the control).
        const paidCycles = (otherCredit: string) =>
          Effect.gen(function* () {
            yield* TestClock.setTime(
              DateTime.toEpochMillis(
                DateTime.makeUnsafe('2026-09-20T15:00:00Z'),
              ),
            )
            const accounts = yield* Accounts
            const owner = yield* accounts.createOwner({
              name: 'Eu',
              kind: 'person',
            })
            const bank = yield* accounts.open({
              ownerId: owner.id,
              institutionName: 'Nubank',
              purpose: 'operating',
              currency: 'BRL',
              name: 'Conta',
              kind: 'checking',
            })
            const card = yield* addCard(
              owner.id,
              '1234',
              line('n1', '20260715', '-100.00', 'Livraria') +
                line('n2', '20260806', '100.00', 'Pagamento recebido') +
                line('n3', '20260815', '-100.00', 'Mercado'),
            )
            yield* addCard(
              owner.id,
              '5678',
              line('m1', '20260705', '-100.00', 'Posto') +
                line('m2', '20260805', otherCredit, 'Pagamento recebido'),
            )
            yield* payFromBank(
              bank.id,
              'b1',
              '-100.00',
              'PAGAMENTO FATURA NUBANK FINAL 1234',
              '20260805',
            )
            const result = yield* (yield* Cards).cycles(card.id)
            return summary(result.cycles).slice(0, 2)
          }).pipe(Effect.provide(openFinanceTest()))
        const expected = [
          ['2026-08-03', -10000, 10000, 'paid', ['card']],
          ['2026-09-03', -10000, 0, 'overdue', []],
        ]
        assert.deepStrictEqual(
          [yield* paidCycles('100.00'), yield* paidCycles('120.00')],
          [expected, expected],
        )
      }),
  )

  it.effect(
    'does not count a bank debit as a second payment when suggestions cross the cards',
    () =>
      Effect.gen(function* () {
        // Card 1234's payment leaves the bank on 5 August and lands on the 7th;
        // card 5678's leaves on the 6th and lands the same day, so
        // reconciliation suggests the crossed pairs.
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-20T15:00:00Z')),
        )
        const accounts = yield* Accounts
        const owner = yield* accounts.createOwner({
          name: 'Eu',
          kind: 'person',
        })
        const bank = yield* accounts.open({
          ownerId: owner.id,
          institutionName: 'Nubank',
          purpose: 'operating',
          currency: 'BRL',
          name: 'Conta',
          kind: 'checking',
        })
        const card = yield* addCard(
          owner.id,
          '1234',
          line('n1', '20260715', '-100.00', 'Livraria') +
            line('n2', '20260807', '100.00', 'Pagamento recebido') +
            line('n3', '20260815', '-100.00', 'Mercado'),
        )
        yield* addCard(
          owner.id,
          '5678',
          line('m1', '20260705', '-100.00', 'Posto') +
            line('m2', '20260806', '100.00', 'Pagamento recebido'),
        )
        yield* payFromBank(
          bank.id,
          'b1',
          '-100.00',
          'PAGAMENTO FATURA NUBANK FINAL 1234',
          '20260805',
        )
        yield* payFromBank(
          bank.id,
          'b2',
          '-100.00',
          'PAGAMENTO FATURA NUBANK FINAL 5678',
          '20260806',
        )
        const result = yield* (yield* Cards).cycles(card.id)
        assert.deepStrictEqual(summary(result.cycles).slice(0, 2), [
          ['2026-08-03', -10000, 10000, 'paid', ['card']],
          ['2026-09-03', -10000, 0, 'overdue', []],
        ])
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('reads a PAGTO credit as a payment of the earlier bill', () =>
    Effect.gen(function* () {
      const pagto = yield* history(
        line('c1', '20260615', '-100.00', 'Mercado') +
          line('c2', '20260708', '100.00', 'PAGTO RECEBIDO') +
          line('c3', '20260715', '-100.00', 'Hotel'),
        '',
      )
      assert.deepStrictEqual(
        summary((yield* pagto.cards.cycles(pagto.card.id)).cycles).slice(0, 2),
        [
          ['2026-07-03', -10000, 10000, 'paid', ['card']],
          ['2026-08-03', -10000, 0, 'overdue', []],
        ],
      )
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('keeps a refund under a PAG* descriptor off the earlier bill', () =>
    Effect.gen(function* () {
      const refund = yield* history(
        line('c1', '20260615', '-100.00', 'Mercado') +
          line('c2', '20260710', '-6.00', 'PAG*123') +
          line('c3', '20260712', '6.00', 'PAG*123') +
          line('c4', '20260715', '-200.00', 'Hotel'),
        '',
      )
      assert.deepStrictEqual(
        summary((yield* refund.cards.cycles(refund.card.id)).cycles).slice(
          0,
          2,
        ),
        [
          ['2026-07-03', -10000, 0, 'overdue', []],
          ['2026-08-03', -20000, 0, 'overdue', []],
        ],
      )
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
    'never pays a card from a reference number or an ending no card has',
    () =>
      Effect.gen(function* () {
        yield* august20
        const accounts = yield* Accounts
        const owner = yield* accounts.createOwner({
          name: 'Eu',
          kind: 'person',
        })
        const bank = yield* accounts.open({
          ownerId: owner.id,
          institutionName: 'Itaú',
          purpose: 'operating',
          currency: 'BRL',
          name: 'Conta',
          kind: 'checking',
        })
        const nubank = yield* addCard(
          owner.id,
          '1234',
          line('n1', '20260715', '-100.00', 'Livraria'),
        )
        yield* addCard(
          owner.id,
          '5678',
          line('i1', '20260715', '-100.00', 'Mercado'),
          'Banco Inter',
        )
        const cards = yield* Cards
        const paid = Effect.map(
          cards.cycles(nubank.id),
          (result) => result.cycles[0]?.paidCents,
        )
        yield* payFromBank(
          bank.id,
          'b1',
          '-100.00',
          'PAGAMENTO FATURA BOLETO REF 1234',
          '20260805',
        )
        const reference = yield* paid
        yield* payFromBank(
          bank.id,
          'b2',
          '-100.00',
          'PAGAMENTO FATURA NUBANK FINAL 9999',
          '20260812',
        )
        const unknownEnding = yield* paid
        yield* payFromBank(
          bank.id,
          'b3',
          '-100.00',
          'PAGAMENTO FATURA NUBANK FINAL 1234',
          '20260819',
        )
        assert.deepStrictEqual(
          [reference, unknownEnding, yield* paid],
          [0, 0, 10000],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'pays an Inter balance with a payment the card received after the cut',
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
        const base = {
          ownerId: owner.id,
          institutionName: 'Banco Inter',
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
          name: 'Cartão Inter',
          kind: 'credit_card',
          card: new CardTerms({
            closingDay: 3,
            dueDay: 10,
            limitCents: null,
            lastFour: null,
          }),
        })
        // The statement closing on 3 August leaves R$ 100,00 due.
        yield* imports.importFile({
          accountId: card.id,
          fileName: 'fatura-inter.pdf',
          bytes: syntheticPdf([
            'Banco Inter S/A',
            'Resumo da fatura',
            'Este e o valor que voce precisa pagar nesse mes 15/08/2026',
            'Fatura atual R$ 100,00',
            'Despesas do mes R$ 100,00',
            'Despesas da fatura',
            'CARTAO 1234****5678',
            '10 de jul. 2026 Mercado - R$ 100,00',
            'Data de corte: 03/09/2026',
          ]),
        })
        // Paid from the bank on the cut day; the card receives it the next
        // day. The card's feed also has a purchase the statement leaves out.
        yield* imports.importFile({
          accountId: card.id,
          fileName: 'cartao.ofx',
          bytes: ofx(
            'CCSTMTRS',
            line('c1', '20260720', '-50.00', 'Padaria') +
              line('c2', '20260804', '100.00', 'Pagamento recebido'),
          ),
        })
        yield* payFromBank(
          bank.id,
          'b1',
          '-100.00',
          'PAGAMENTO FATURA INTER',
          '20260803',
        )
        const reconciliation = yield* Reconciliation
        const relation = (yield* reconciliation.relations).find(
          (found) => found.kind === 'card_payment',
        )
        assert.isDefined(relation)
        if (relation!.status !== 'confirmed')
          yield* reconciliation.decide(relation!.key, 'confirmed')
        const result = yield* (yield* Cards).cycles(card.id)
        const cycle = result.cycles[0]
        assert.deepStrictEqual(
          [
            cycle?.closingOn,
            cycle?.paidCents,
            cycle?.status,
            cycle?.payments.map((payment) => payment.paidOn),
            cycle?.statement,
          ],
          [
            '2026-08-03',
            10000,
            'paid',
            ['2026-08-03'],
            { observedCents: -10000, deductedCents: 0, differenceCents: 5000 },
          ],
        )
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
              ['2026-08-03', -10500],
              ['2026-09-03', 0],
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
    'bills a purchase captured after the cut on the statement that prints it',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe('2026-08-05T15:00:00Z')),
        )
        const accounts = yield* Accounts
        const imports = yield* Imports
        const observations = yield* Observations
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
        // Bought on 2 July, before the 3 July cut, but captured after it:
        // Open Finance reports the purchase date and the August bill.
        const source = yield* observations.registerSource({
          kind: 'open_finance',
          externalRef: 'provider-card',
          label: 'Cartão Inter',
        })
        yield* observations.recordTransactions({
          sourceId: source.id,
          accountId: card.id,
          transactions: [
            {
              externalId: 'purchase',
              bookedOn: '2026-07-02',
              amountCents: -10000,
              currency: 'BRL',
              description: 'Loja',
              status: 'posted' as const,
              raw: { installment: { billId: 'bill-aug' } },
            },
          ],
        })
        yield* drain
        // The statement of 4 July to 3 August prints it, due on the 10th.
        yield* imports.importFile({
          accountId: card.id,
          fileName: 'fatura-inter.pdf',
          bytes: syntheticPdf([
            'Banco Inter S/A',
            'Resumo da fatura',
            'Este e o valor que voce precisa pagar nesse mes 10/08/2026',
            'Fatura atual R$ 100,00',
            'Despesas do mes R$ 100,00',
            'Despesas da fatura',
            'CARTAO 1234****5678',
            '02 de jul. 2026 Loja - R$ 100,00',
            'Data de corte: 03/09/2026',
          ]),
        })
        yield* drain
        const result = yield* (yield* Cards).cycles(card.id)
        assert.deepStrictEqual(
          result.cycles.map((cycle) => [
            cycle.closingOn,
            cycle.totalCents,
            cycle.entryIds.length,
            cycle.status,
            cycle.statement?.differenceCents ?? null,
          ]),
          [
            ['2026-08-03', -10000, 1, 'due', 0],
            ['2026-09-03', 0, 0, 'open', null],
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

  it.effect(
    'keeps the refund credit an Inter statement prints as nothing due',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-20T15:00:00Z')),
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
        // R$ 100,00 of purchases and a R$ 200,00 refund: R$ 100,00 in the
        // holder's favour, printed as R$ 0,00 due.
        yield* imports.importFile({
          accountId: card.id,
          fileName: 'fatura-inter.pdf',
          bytes: syntheticPdf([
            'Banco Inter S/A',
            'Resumo da fatura',
            'Este e o valor que voce precisa pagar nesse mes 15/08/2026',
            'Fatura atual R$ 0,00',
            'Valor antecipado R$ 200,00',
            'Despesas do mes R$ 100,00',
            'Despesas da fatura',
            'CARTAO 1234****5678',
            '10 de jul. 2026 Mercado - R$ 100,00',
            '15 de jul. 2026 Estorno loja - + R$ 200,00',
            'Data de corte: 03/09/2026',
          ]),
        })
        // September's purchase is paid by that credit.
        yield* imports.importFile({
          accountId: card.id,
          fileName: 'cartao.ofx',
          bytes: ofx('CCSTMTRS', line('c1', '20260810', '-100.00', 'Hotel')),
        })
        yield* drain
        const result = yield* (yield* Cards).cycles(card.id)
        assert.deepStrictEqual(
          [
            result.cycles
              .slice(0, 2)
              .map((cycle) => [
                cycle.closingOn,
                cycle.paidCents,
                cycle.status,
                cycle.payments.map((payment) => payment.via),
                cycle.statement?.differenceCents ?? null,
              ]),
            result.unappliedCents,
          ],
          [
            [
              ['2026-08-03', 0, 'paid', [], 0],
              ['2026-09-03', 10000, 'paid', ['credit'], null],
            ],
            0,
          ],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'does not let the first imported Nubank statement spend the payment of an earlier bill',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe('2026-08-05T15:00:00Z')),
        )
        const accounts = yield* Accounts
        const imports = yield* Imports
        const owner = yield* accounts.createOwner({
          name: 'Eu',
          kind: 'person',
        })
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
        const bill = (
          fileName: string,
          period: string,
          due: string,
          total: string,
          rows: ReadonlyArray<string>,
        ) =>
          imports.importFile({
            accountId: card.id,
            fileName,
            bytes: syntheticPdf([
              'Nu Pagamentos S.A.',
              'RESUMO DA FATURA ATUAL',
              `Data de vencimento: ${due}`,
              `Periodo vigente: ${period}`,
              `Total de compras de todos os cartoes R$ ${total}`,
              `Total a pagar R$ ${total}`,
              `TRANSACOES DE ${period.toUpperCase()}`,
              ...rows,
            ]),
          })
        const outcome = Effect.gen(function* () {
          const result = yield* (yield* Cards).cycles(card.id)
          return [
            result.cycles.map((cycle) => [
              cycle.closingOn,
              cycle.paidCents,
              cycle.status,
              cycle.statement?.differenceCents ?? null,
            ]),
            result.unappliedCents,
            result.beforeHistoryCents,
          ]
        })
        // August's bill prints the 8 July payment of July's bill.
        yield* bill('agosto.pdf', '04 JUL a 03 AGO', '10 AGO 2026', '200,00', [
          '15 JUL Hotel R$ 200,00',
          '08 JUL Pagamento em 08 JUL -R$ 200,00',
        ])
        yield* drain
        const alone = yield* outcome
        yield* bill('julho.pdf', '04 JUN a 03 JUL', '10 JUL 2026', '200,00', [
          '10 JUN Mercado R$ 200,00',
        ])
        yield* drain
        assert.deepStrictEqual(
          [alone, yield* outcome],
          [
            [
              [
                ['2026-08-03', 0, 'due', 0],
                ['2026-09-03', 0, 'open', null],
              ],
              0,
              20000,
            ],
            [
              [
                ['2026-07-03', 20000, 'paid', 0],
                ['2026-08-03', 0, 'due', 0],
                ['2026-09-03', 0, 'open', null],
              ],
              0,
              0,
            ],
          ],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'does not let the first imported Inter statement spend the payment of an earlier bill',
    () =>
      Effect.gen(function* () {
        yield* august20
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
        const bill = (
          fileName: string,
          due: string,
          nextCut: string,
          rows: ReadonlyArray<string>,
        ) =>
          imports.importFile({
            accountId: card.id,
            fileName,
            bytes: syntheticPdf([
              'Banco Inter S/A',
              'Resumo da fatura',
              `Este e o valor que voce precisa pagar nesse mes ${due}`,
              'Fatura atual R$ 200,00',
              'Despesas do mes R$ 200,00',
              'Despesas da fatura',
              'CARTAO 1234****5678',
              ...rows,
              `Data de corte: ${nextCut}`,
            ]),
          })
        const outcome = Effect.gen(function* () {
          const result = yield* (yield* Cards).cycles(card.id)
          return [
            result.cycles.map((cycle) => [
              cycle.closingOn,
              cycle.paidCents,
              cycle.status,
              cycle.statement?.differenceCents ?? null,
            ]),
            result.unappliedCents,
            result.beforeHistoryCents,
          ]
        })
        // August's bill prints the 8 July payment of July's bill and still
        // asks R$ 200,00 for August's purchases.
        yield* bill('agosto.pdf', '10/08/2026', '03/09/2026', [
          '15 de jul. 2026 Hotel - R$ 200,00',
          '08 de jul. 2026 PAGAMENTO ON LINE - + R$ 200,00',
        ])
        yield* drain
        const alone = yield* outcome
        yield* bill('julho.pdf', '10/07/2026', '03/08/2026', [
          '10 de jun. 2026 Mercado - R$ 200,00',
        ])
        yield* drain
        assert.deepStrictEqual(
          [alone, yield* outcome],
          [
            [
              [
                ['2026-08-03', 0, 'overdue', 0],
                ['2026-09-03', 0, 'open', null],
              ],
              0,
              20000,
            ],
            [
              [
                ['2026-07-03', 20000, 'paid', 0],
                ['2026-08-03', 0, 'overdue', 0],
                ['2026-09-03', 0, 'open', null],
              ],
              0,
              0,
            ],
          ],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'separates the payment of an earlier bill from the advance an Inter statement prints as nothing due',
    () =>
      Effect.gen(function* () {
        yield* august20
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
        const outcome = Effect.gen(function* () {
          const result = yield* (yield* Cards).cycles(card.id)
          return [
            result.cycles.map((cycle) => [
              cycle.closingOn,
              cycle.paidCents,
              cycle.status,
              cycle.statement?.differenceCents ?? null,
            ]),
            result.unappliedCents,
            result.beforeHistoryCents,
          ]
        })
        // August's bill prints the 8 July payment of July's bill and a
        // R$ 250,00 advance on R$ 200,00 of purchases: nothing due, and the
        // printed "Valor antecipado" is only the advance.
        yield* imports.importFile({
          accountId: card.id,
          fileName: 'agosto.pdf',
          bytes: syntheticPdf([
            'Banco Inter S/A',
            'Resumo da fatura',
            'Este e o valor que voce precisa pagar nesse mes 10/08/2026',
            'Fatura atual R$ 0,00',
            'Valor antecipado R$ 250,00',
            'Despesas do mes R$ 200,00',
            'Despesas da fatura',
            'CARTAO 1234****5678',
            '15 de jul. 2026 Hotel - R$ 200,00',
            '08 de jul. 2026 PAGAMENTO ON LINE - + R$ 200,00',
            '25 de jul. 2026 PAGAMENTO ON LINE - + R$ 250,00',
            'Data de corte: 03/09/2026',
          ]),
        })
        yield* drain
        const alone = yield* outcome
        yield* imports.importFile({
          accountId: card.id,
          fileName: 'julho.pdf',
          bytes: syntheticPdf([
            'Banco Inter S/A',
            'Resumo da fatura',
            'Este e o valor que voce precisa pagar nesse mes 10/07/2026',
            'Fatura atual R$ 200,00',
            'Despesas do mes R$ 200,00',
            'Despesas da fatura',
            'CARTAO 1234****5678',
            '10 de jun. 2026 Mercado - R$ 200,00',
            'Data de corte: 03/08/2026',
          ]),
        })
        yield* drain
        assert.deepStrictEqual(
          [alone, yield* outcome],
          [
            [
              [
                ['2026-08-03', 0, 'paid', 0],
                ['2026-09-03', 0, 'open', null],
              ],
              5000,
              20000,
            ],
            [
              [
                ['2026-07-03', 20000, 'paid', 0],
                ['2026-08-03', 0, 'paid', 0],
                ['2026-09-03', 0, 'open', null],
              ],
              5000,
              0,
            ],
          ],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'keeps a bank payment of a bill that a later refund could also have paid',
    () =>
      Effect.gen(function* () {
        const { cards, card } = yield* history(
          line('c1', '20260610', '-100.00', 'Mercado') +
            line('c2', '20260720', '150.00', 'Estorno loja') +
            line('c3', '20260810', '-100.00', 'Hotel'),
          line('b1', '20260708', '-100.00', 'PAGAMENTO FATURA NUBANK'),
          TestClock.setTime(
            DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-20T15:00:00Z')),
          ),
        )
        const result = yield* cards.cycles(card.id)
        assert.deepStrictEqual(
          [summary(result.cycles), result.unappliedCents],
          [
            [
              ['2026-07-03', -10000, 10000, 'paid', ['bank']],
              ['2026-08-03', 15000, 0, 'paid', []],
              ['2026-09-03', -10000, 10000, 'paid', ['credit']],
              ['2026-10-03', 0, 0, 'open', []],
            ],
            5000,
          ],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'is not overdue on the business day after a due day that falls on a national holiday',
    () =>
      Effect.gen(function* () {
        // Due on Monday 12 October 2026, a national holiday: still payable on the 13th.
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe('2026-10-13T15:00:00Z')),
        )
        const accounts = yield* Accounts
        const imports = yield* Imports
        const owner = yield* accounts.createOwner({
          name: 'Eu',
          kind: 'person',
        })
        const card = yield* accounts.open({
          ownerId: owner.id,
          institutionName: 'Nubank',
          purpose: 'operating',
          currency: 'BRL',
          name: 'Cartão',
          kind: 'credit_card',
          card: new CardTerms({
            closingDay: 5,
            dueDay: 12,
            limitCents: null,
            lastFour: null,
          }),
        })
        yield* imports.importFile({
          accountId: card.id,
          fileName: 'cartao.ofx',
          bytes: ofx('CCSTMTRS', line('c1', '20260920', '-100.00', 'Mercado')),
        })
        yield* drain
        const result = yield* (yield* Cards).cycles(card.id)
        const cycle = result.cycles[0]
        assert.deepStrictEqual(
          [
            cycle?.closingOn,
            cycle?.totalCents,
            cycle?.payableUntil,
            cycle?.status,
          ],
          ['2026-10-05', -10000, '2026-10-13', 'due'],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )
})
