import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'

import { Imports } from '../imports/Imports.ts'
import {
  bank,
  card,
  connect,
  drain,
  openFinanceTest,
  tx,
} from '../testing/FakePluggy.ts'
import { CardTerms } from './Accounts.ts'
import { Entries } from './Entries.ts'

// A September statement for the account: salary in, bakery out, closing at R$ 900,00.
const septemberOfx = (lines = '') =>
  new TextEncoder().encode(`OFXHEADER:100
CHARSET:UTF-8

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL
<BANKTRANLIST><DTSTART>20260901<DTEND>20260930
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260905<TRNAMT>1000.00<FITID>f1<MEMO>SALARIO EMPRESA</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260910<TRNAMT>-100.00<FITID>f2<MEMO>PADARIA SAO JOAO</STMTTRN>${lines}
</BANKTRANLIST><LEDGERBAL><BALAMT>900.00<DTASOF>20260930</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`)

// Pluggy sees the same two movements a day later, plus October's, with R$ 830,00 now.
const pluggyData = {
  accounts: [{ ...bank, balance: 830 }],
  transactions: {
    'provider-bank': [
      tx('p-salary', '2026-09-06', {
        type: 'CREDIT',
        amount: 1000,
        description: 'Salário Empresa',
      }),
      tx('p-bakery', '2026-09-11', {
        amount: 100,
        description: 'Padaria São João',
      }),
      tx('p-market', '2026-10-02', { amount: 50, description: 'Mercado' }),
      tx('p-coffee', '2026-10-04', { amount: 20, description: 'Café' }),
    ],
  },
}

const linkedWithStatement = (statement = septemberOfx(), data = pluggyData) =>
  Effect.gen(function* () {
    const { openFinance, connectionId, state } = yield* connect(data)
    const account = yield* openFinance.linkAccount({
      providerAccountId: 'provider-bank',
      target: { kind: 'checking', purpose: 'operating' },
      historyMonths: 3,
    })
    yield* drain
    // The statement arrives after the first sync, as it would in practice.
    yield* TestClock.adjust('1 minute')
    yield* (yield* Imports).importFile({
      accountId: account.id,
      fileName: 'set.ofx',
      bytes: statement,
    })
    yield* drain
    return {
      openFinance,
      connectionId,
      state,
      account,
      entries: yield* Entries,
    }
  })

describe('Entries', () => {
  it.effect(
    'merges what Pluggy and a statement both report into one entry each',
    () =>
      Effect.gen(function* () {
        const { account, entries } = yield* linkedWithStatement()
        const resolved = yield* entries.entries(account.id)
        assert.deepStrictEqual(
          resolved.map((entry) => [
            entry.bookedOn,
            entry.amountCents,
            entry.sources,
          ]),
          [
            ['2026-09-06', 100000, 2],
            ['2026-09-11', -10000, 2],
            ['2026-10-02', -5000, 1],
            ['2026-10-04', -2000, 1],
          ],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'proves the balance from the statement close to the latest Pluggy balance',
    () =>
      Effect.gen(function* () {
        const { account, entries } = yield* linkedWithStatement()
        const proof = yield* entries.balanceProof(account.id)
        // Pluggy's R$ 830,00 "now" becomes R$ 850,00 at the end of 3 October,
        // before today's R$ 20,00 coffee.
        assert.deepStrictEqual(proof, {
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
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('shows a gap when a movement is missing from every source', () =>
    Effect.gen(function* () {
      // The bank's balance is R$ 30,00 lower than the movements explain.
      const { account, entries } = yield* linkedWithStatement(septemberOfx(), {
        ...pluggyData,
        accounts: [{ ...bank, balance: 800 }],
      })
      const proof = yield* entries.balanceProof(account.id)
      assert.deepStrictEqual(
        proof.supported
          ? proof.intervals.map((interval) => interval.differenceCents)
          : [],
        [-3000],
      )
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('keeps entry ids when the account is resolved again', () =>
    Effect.gen(function* () {
      const { account, entries } = yield* linkedWithStatement()
      const before = yield* entries.entries(account.id)
      const changed = yield* entries.resolveAccount(account.id)
      assert.isFalse(changed)
      assert.deepStrictEqual(yield* entries.entries(account.id), before)
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('lists sources that disagree about the same day', () =>
    Effect.gen(function* () {
      const { account, entries } = yield* linkedWithStatement()
      const later = new TextEncoder().encode(`OFXHEADER:100
CHARSET:UTF-8

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL<BANKTRANLIST></BANKTRANLIST>
<LEDGERBAL><BALAMT>899.00<DTASOF>20260930</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`)
      yield* (yield* Imports).importFile({
        accountId: account.id,
        fileName: 'outro.ofx',
        bytes: later,
      })
      const proof = yield* entries.balanceProof(account.id)
      assert.deepStrictEqual(
        proof.supported
          ? proof.conflicts.map((conflict) => [
              conflict.asOf,
              conflict.balances.length,
            ])
          : [],
        [['2026-09-30', 2]],
      )
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('leaves card balances to the reconciliation phase', () =>
    Effect.gen(function* () {
      const { openFinance } = yield* connect({
        accounts: [card],
        transactions: {},
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
      assert.deepStrictEqual(yield* (yield* Entries).balanceProof(account.id), {
        supported: false,
        reason: 'credit_card',
      })
    }).pipe(Effect.provide(openFinanceTest())),
  )
})
