import { assert, describe, it } from '@effect/vitest'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'

import { Imports } from '../imports/Imports.ts'
import { Accounts, CardTerms } from '../ledger/Accounts.ts'
import { drain, openFinanceTest } from '../testing/FakePluggy.ts'
import { Cards } from './Cards.ts'

const ofx = (tag: 'STMTRS' | 'CCSTMTRS', lines: string, ledger = '') =>
  new TextEncoder().encode(`OFXHEADER:100
CHARSET:UTF-8

<OFX><MSGS><${tag}><CURDEF>BRL<BANKTRANLIST>${lines}</BANKTRANLIST>${ledger}</${tag}></MSGS></OFX>`)

const line = (fitid: string, date: string, amount: string, memo: string) =>
  `<STMTTRN><DTPOSTED>${date}<TRNAMT>${amount}<FITID>${fitid}<MEMO>${memo}</STMTTRN>`

// A card closing on the 3rd, due on the 10th, and the bank account that pays it.
const setup = Effect.gen(function* () {
  yield* TestClock.setTime(
    DateTime.toEpochMillis(DateTime.makeUnsafe('2026-08-20T15:00:00Z')),
  )
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
  return { cards: yield* Cards, bank, card }
})

describe('Cards', () => {
  it.effect(
    'settles each closed cycle and proves it against its statement',
    () =>
      Effect.gen(function* () {
        const { cards, card } = yield* setup
        const cycles = yield* cards.cycles(card.id)
        assert.deepStrictEqual(
          cycles.map((cycle) => [
            cycle.closingOn,
            cycle.totalCents,
            cycle.paidCents,
            cycle.status,
            cycle.payments.map((payment) => payment.via),
            cycle.statement?.differenceCents ?? null,
          ]),
          [
            ['2026-07-03', -15000, 15000, 'paid', ['card'], 0],
            ['2026-08-03', -20000, 20000, 'paid', ['bank'], null],
            ['2026-09-03', 0, 0, 'open', [], null],
          ],
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
