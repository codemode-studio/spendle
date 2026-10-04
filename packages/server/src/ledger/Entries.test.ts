import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as Ref from 'effect/Ref'
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
import { Accounts, CardTerms } from './Accounts.ts'
import { Entries } from './Entries.ts'
import { Observations } from './Observations.ts'

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

// Pluggy sees the same two movements a day later, plus October's, with the
// bank's running balance after each one.
const pluggyData = {
  accounts: [{ ...bank, balance: 830 }],
  transactions: {
    'provider-bank': [
      tx('p-salary', '2026-09-06', {
        type: 'CREDIT',
        amount: 1000,
        balance: 1000,
        description: 'Salário Empresa',
      }),
      tx('p-bakery', '2026-09-11', {
        amount: 100,
        balance: 900,
        description: 'Padaria São João',
      }),
      tx('p-market', '2026-10-02', {
        amount: 50,
        balance: 850,
        description: 'Mercado',
      }),
      tx('p-coffee', '2026-10-04', {
        amount: 20,
        balance: 830,
        description: 'Café',
      }),
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

const openChecking = Effect.gen(function* () {
  const accounts = yield* Accounts
  const owner = yield* accounts.createOwner({ name: 'Donald', kind: 'person' })
  return yield* accounts.open({
    ownerId: owner.id,
    institutionName: 'Banco',
    name: 'Conta',
    kind: 'checking',
    purpose: 'operating',
    currency: 'BRL',
  })
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
    'proves every interval between the statement close and Pluggy end-of-day balances',
    () =>
      Effect.gen(function* () {
        const { account, entries } = yield* linkedWithStatement()
        const proof = yield* entries.balanceProof(account.id)
        // Booked checkpoints: Pluggy's end of 6 Sep, 11 Sep and 2 Oct (today, 4 Oct,
        // may still change) and the statement's close on 30 Sep.
        assert.deepStrictEqual(
          proof.supported
            ? proof.intervals.map((interval) => [
                interval.from,
                interval.to,
                interval.differenceCents,
              ])
            : [],
          [
            ['2026-09-06', '2026-09-11', 0],
            ['2026-09-11', '2026-09-30', 0],
            ['2026-09-30', '2026-10-02', 0],
          ],
        )
        assert.deepStrictEqual(proof.supported ? proof.conflicts : null, [])
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('shows a gap when a movement is missing from every source', () =>
    Effect.gen(function* () {
      // The statement closes R$ 30,00 above what the movements explain.
      const { account, entries } = yield* linkedWithStatement(
        new TextEncoder().encode(
          new TextDecoder()
            .decode(septemberOfx())
            .replace('<BALAMT>900.00', '<BALAMT>930.00'),
        ),
      )
      const proof = yield* entries.balanceProof(account.id)
      assert.deepStrictEqual(
        proof.supported
          ? proof.intervals.map((interval) => interval.differenceCents)
          : [],
        [0, 3000, -3000],
      )
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'leaves out a checkpoint its source withdrew, until reinstated',
    () =>
      Effect.gen(function* () {
        const { account, entries } = yield* linkedWithStatement(
          new TextEncoder().encode(
            new TextDecoder()
              .decode(septemberOfx())
              .replace('<BALAMT>900.00', '<BALAMT>930.00'),
          ),
        )
        // The statement's 30 September close is withdrawn: its gap goes with it.
        const sql = yield* SqlClient.SqlClient
        yield* sql`
        INSERT INTO open_finance_checkpoint_invalidations
          (balance_observation_id, withdrawn, account_id, source_id, as_of, invalidated_at)
        SELECT id, 1, account_id, source_id, as_of, '2026-10-04T00:00:00Z'
        FROM balance_observations
        WHERE account_id = ${account.id} AND kind = 'statement'
      `
        const differences = Effect.map(
          entries.balanceProof(account.id),
          (proof) =>
            proof.supported
              ? proof.intervals.map((interval) => interval.differenceCents)
              : [],
        )
        const withdrawn = yield* differences
        // A later complete read confirmed it again: the gap is back.
        yield* sql`
        INSERT INTO open_finance_checkpoint_invalidations
          (balance_observation_id, withdrawn, account_id, source_id, as_of, invalidated_at)
        SELECT id, 0, account_id, source_id, as_of, '2026-10-05T00:00:00Z'
        FROM balance_observations
        WHERE account_id = ${account.id} AND kind = 'statement'
      `
        assert.deepStrictEqual(
          [withdrawn, yield* differences],
          [
            [0, 0],
            [0, 3000, -3000],
          ],
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

  it.effect('keeps an entry id when its first observation disappears', () =>
    Effect.gen(function* () {
      const { openFinance, connectionId, state } = yield* connect({
        accounts: [bank],
        transactions: {
          'provider-bank': [
            tx('hold', '2026-10-02', {
              status: 'PENDING',
              description: 'Padaria Central',
            }),
          ],
        },
      })
      const account = yield* openFinance.linkAccount({
        providerAccountId: 'provider-bank',
        target: { kind: 'checking', purpose: 'operating' },
        historyMonths: 3,
      })
      yield* drain
      yield* TestClock.adjust('1 minute')
      yield* (yield* Imports).importFile({
        accountId: account.id,
        fileName: 'out.ofx',
        bytes: new TextEncoder().encode(`<OFX><STMTRS><CURDEF>BRL<BANKTRANLIST>
          <STMTTRN><DTPOSTED>20261002<TRNAMT>-10.00<FITID>f1<MEMO>PADARIA CENTRAL</STMTTRN>
          </BANKTRANLIST></STMTRS></OFX>`),
      })
      yield* drain
      const entries = yield* Entries
      const [before] = yield* entries.entries(account.id)

      // Pluggy drops the hold; the statement still confirms the movement.
      yield* Ref.update(state, (current) => ({
        ...current,
        transactions: { 'provider-bank': [] },
      }))
      yield* openFinance.requestSync({ connectionId })
      yield* drain
      const after = yield* entries.entries(account.id)
      assert.deepStrictEqual(
        after.map((entry) => [entry.id, entry.sources]),
        [[before!.id, 1]],
      )
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'uses the latest report of a day, even when it repeats an earlier value',
    () =>
      Effect.gen(function* () {
        const { account, entries } = yield* linkedWithStatement()
        const observations = yield* Observations
        const source = yield* observations.registerSource({
          kind: 'manual',
          externalRef: 'checks',
          label: 'checks',
        })
        const report = (balanceCents: number) =>
          observations.recordBalance({
            sourceId: source.id,
            accountId: account.id,
            balance: {
              kind: 'booked',
              asOf: '2026-10-03',
              balanceCents,
              currency: 'BRL',
            },
          })
        yield* report(85000)
        yield* report(84000)
        yield* report(85000)
        const proof = yield* entries.balanceProof(account.id)
        const last = proof.supported ? proof.intervals.at(-1) : undefined
        assert.deepStrictEqual(
          [last?.to, last?.differenceCents],
          ['2026-10-03', 0],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'keeps equal purchases from statements of different months apart',
    () =>
      Effect.gen(function* () {
        const account = yield* openChecking
        const statement = (start: string, end: string, line: string) =>
          new TextEncoder().encode(`<OFX><STMTRS><CURDEF>BRL<BANKTRANLIST>
            <DTSTART>${start}<DTEND>${end}${line}
            </BANKTRANLIST></STMTRS></OFX>`)
        const imports = yield* Imports
        yield* imports.importFile({
          accountId: account.id,
          fileName: 'set.ofx',
          bytes: statement(
            '20260901',
            '20260930',
            '<STMTTRN><DTPOSTED>20260930<TRNAMT>-10.00<FITID>s1<MEMO>PADARIA CENTRAL</STMTTRN>',
          ),
        })
        yield* imports.importFile({
          accountId: account.id,
          fileName: 'out.ofx',
          bytes: statement(
            '20261001',
            '20261031',
            '<STMTTRN><DTPOSTED>20261001<TRNAMT>-10.00<FITID>o1<MEMO>PADARIA CENTRAL</STMTTRN>',
          ),
        })
        yield* drain
        const resolved = yield* (yield* Entries).entries(account.id)
        assert.deepStrictEqual(
          resolved.map((entry) => [entry.bookedOn, entry.sources]),
          [
            ['2026-09-30', 1],
            ['2026-10-01', 1],
          ],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'merges the same file transaction id across overlapping exports whatever the description',
    () =>
      Effect.gen(function* () {
        const imports = yield* Imports
        const observations = yield* Observations
        const entries = yield* Entries
        const exported = (
          start: string,
          end: string,
          memo: string,
          fitid: string,
        ) =>
          new TextEncoder().encode(`<OFX><STMTRS><CURDEF>BRL<BANKTRANLIST>
            <DTSTART>${start}<DTEND>${end}
            <STMTTRN><DTPOSTED>20260910<TRNAMT>-10.00${fitid}<MEMO>${memo}</STMTTRN>
            </BANKTRANLIST><LEDGERBAL><BALAMT>90.00<DTASOF>${end}</LEDGERBAL></STMTRS></OFX>`)
        // Two overlapping exports of an account opened at R$ 100,00; the
        // bank renamed the merchant between them.
        const importBoth = (fitid: string) =>
          Effect.gen(function* () {
            const account = yield* openChecking
            const opening = yield* observations.registerSource({
              kind: 'manual',
              externalRef: `opening-${account.id}`,
              label: 'opening',
            })
            yield* observations.recordBalance({
              sourceId: opening.id,
              accountId: account.id,
              balance: {
                kind: 'booked',
                asOf: '2026-09-01',
                balanceCents: 100_00,
                currency: 'BRL',
              },
            })
            yield* imports.importFile({
              accountId: account.id,
              fileName: 'a.ofx',
              bytes: exported(
                '20260901',
                '20260912',
                'Amazon Marketplace',
                fitid,
              ),
            })
            yield* imports.importFile({
              accountId: account.id,
              fileName: 'b.ofx',
              bytes: exported('20260905', '20260920', 'AMZN Mktp', fitid),
            })
            yield* drain
            const proof = yield* entries.balanceProof(account.id)
            return {
              sources: (yield* entries.entries(account.id)).map(
                (entry) => entry.sources,
              ),
              gaps: proof.supported
                ? proof.intervals.map((interval) => interval.differenceCents)
                : [],
            }
          })
        assert.deepStrictEqual(yield* importBoth('<FITID>T-77'), {
          sources: [2],
          gaps: [0, 0],
        })
        // Without the files' ids, nothing says the two lines are one.
        assert.deepStrictEqual((yield* importBoth('')).sources, [1, 1])
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'never lets an earlier pairing split the lines two exports identify as one',
    () =>
      Effect.gen(function* () {
        // Two equal bakery debits Pluggy dates on the 1st and 2nd; two
        // overlapping exports of the account date them differently but give
        // each the same FITID: T-0 is the 1st's, T-1 the 2nd's.
        const debit = (fitid: string, day: string) =>
          `<STMTTRN><DTPOSTED>202609${day}<TRNAMT>-10.00<FITID>${fitid}<MEMO>PADARIA CENTRAL</STMTTRN>`
        const exported = (lines: string) =>
          new TextEncoder().encode(`<OFX><STMTRS><CURDEF>BRL<BANKTRANLIST>
            <DTSTART>20260901<DTEND>20260930
            ${lines}
            </BANKTRANLIST></STMTRS></OFX>`)
        const { account, entries } = yield* linkedWithStatement(
          exported(debit('T-0', '02') + debit('T-1', '02')),
          {
            accounts: [{ ...bank, balance: 980 }],
            transactions: {
              'provider-bank': [
                tx('p-0', '2026-09-01', { description: 'Padaria Central' }),
                tx('p-1', '2026-09-02', { description: 'Padaria Central' }),
              ],
            },
          },
        )
        yield* (yield* Imports).importFile({
          accountId: account.id,
          fileName: 'b.ofx',
          bytes: exported(debit('T-0', '01') + debit('T-1', '05')),
        })
        yield* drain

        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ entryId: string; externalId: string }>`
          SELECT v.entry_id AS entryId, v.external_id AS externalId
          FROM entry_evidence v JOIN sources s ON s.id = v.source_id
          WHERE v.account_id = ${account.id} AND s.kind = 'file'
          ORDER BY v.external_id
        `
        const fitidsOf = new Map<string, Array<string>>()
        for (const row of rows)
          fitidsOf.set(row.entryId, [
            ...(fitidsOf.get(row.entryId) ?? []),
            row.externalId,
          ])
        assert.deepStrictEqual([...fitidsOf.values()].sort(), [
          ['id:T-0@1', 'id:T-0@1'],
          ['id:T-1@1', 'id:T-1@1'],
        ])
        const resolved = yield* entries.entries(account.id)
        assert.deepStrictEqual(
          resolved.map((entry) => entry.sources),
          [3, 3],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'looks up checkpoint withdrawals by index, not by scanning them all per balance',
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        // The checkpoint query balanceProof runs: one withdrawal lookup per balance.
        const plan = yield* sql<{ detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT b.id, COALESCE((
            SELECT i.withdrawn FROM open_finance_checkpoint_invalidations i
            WHERE i.balance_observation_id = b.id ORDER BY i.rowid DESC LIMIT 1
          ), 0) AS invalidated
          FROM balance_observations b
          WHERE b.account_id = ${'account'} AND b.kind IN ('booked', 'statement')
          ORDER BY b.as_of, b.rowid
        `
        const lookups = plan
          .map((row) => row.detail)
          .filter((detail) => / i\b/.test(detail))
        assert.deepStrictEqual(lookups, [
          'SEARCH i USING INDEX open_finance_checkpoint_invalidations_observation (balance_observation_id=?)',
        ])
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('reports a change when secondary evidence is corrected', () =>
    Effect.gen(function* () {
      const account = yield* openChecking
      const observations = yield* Observations
      const entries = yield* Entries
      const source = (label: string) =>
        observations.registerSource({
          kind: 'manual',
          externalRef: label,
          label,
        })
      const statement = yield* source('statement')
      const aggregator = yield* source('aggregator')
      const report = (sourceId: string, bookedOn: string) =>
        observations.recordTransactions({
          sourceId,
          accountId: account.id,
          transactions: [
            {
              externalId: 'bakery',
              bookedOn,
              amountCents: -1000,
              currency: 'BRL',
              description: 'Padaria Central',
              status: 'posted',
              raw: {},
            },
          ],
        })
      const balance = (asOf: string, balanceCents: number) =>
        observations.recordBalance({
          sourceId: aggregator.id,
          accountId: account.id,
          balance: { kind: 'booked', asOf, balanceCents, currency: 'BRL' },
        })
      // The statement speaks for the entry; the aggregator also confirms it.
      yield* report(statement.id, '2026-10-01')
      yield* report(aggregator.id, '2026-10-01')
      yield* balance('2026-09-30', 1000_00)
      yield* balance('2026-10-01', 990_00)
      assert.isTrue(yield* entries.resolveAccount(account.id))
      const differences = Effect.map(
        entries.balanceProof(account.id),
        (proof) =>
          proof.supported
            ? proof.intervals.map((interval) => interval.differenceCents)
            : [],
      )
      assert.deepStrictEqual(yield* differences, [0])

      // The aggregator corrects its date: the entry is the same, the proof is not.
      yield* report(aggregator.id, '2026-10-02')
      assert.isTrue(yield* entries.resolveAccount(account.id))
      assert.deepStrictEqual(yield* differences, [-1000])
    }).pipe(Effect.provide(openFinanceTest())),
  )
})
