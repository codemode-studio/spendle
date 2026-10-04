import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { Imports } from '../imports/Imports.ts'
import { Accounts, CardTerms } from '../ledger/Accounts.ts'
import { Entries } from '../ledger/Entries.ts'
import { Observations } from '../ledger/Observations.ts'
import { drain, openFinanceTest } from '../testing/FakePluggy.ts'
import { Reconciliation } from './Reconciliation.ts'

const ofx = (lines: string, tag = 'STMTRS') =>
  new TextEncoder().encode(`OFXHEADER:100
CHARSET:UTF-8

<OFX><MSGS><${tag}><CURDEF>BRL<BANKTRANLIST>${lines}</BANKTRANLIST></${tag}></MSGS></OFX>`)

const line = (fitid: string, date: string, amount: string, memo: string) =>
  `<STMTTRN><DTPOSTED>${date}<TRNAMT>${amount}<FITID>${fitid}<MEMO>${memo}</STMTTRN>`

// Three of Donald's accounts with statements already imported.
const setup = Effect.gen(function* () {
  const accounts = yield* Accounts
  const imports = yield* Imports
  const owner = yield* accounts.createOwner({
    name: 'Donald Silveira',
    kind: 'person',
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

// Nubank sends R$ 500,00 by Pix; Inter's own reports are added by each test.
const twoAccounts = Effect.gen(function* () {
  const accounts = yield* Accounts
  const owner = yield* accounts.createOwner({ name: 'Donald', kind: 'person' })
  const open = (name: string) =>
    accounts.open({
      ownerId: owner.id,
      institutionName: name,
      name,
      kind: 'checking',
      purpose: 'operating',
      currency: 'BRL',
    })
  const nubank = yield* open('Nubank')
  const inter = yield* open('Inter')
  yield* (yield* Imports).importFile({
    accountId: nubank.id,
    fileName: 'nubank.ofx',
    bytes: ofx(line('n1', '20260910', '-500.00', 'Pix enviado Donald')),
  })
  yield* drain
  const observations = yield* Observations
  const bank = yield* observations.registerSource({
    kind: 'manual',
    externalRef: 'inter-bank',
    label: 'Inter',
  })
  // What Inter's own feed reports, as a new version each time it changes.
  const report = (
    externalId: string,
    bookedOn: string,
    description: string,
    status: 'posted' | 'removed' = 'posted',
  ) =>
    Effect.andThen(
      observations.recordTransactions({
        sourceId: bank.id,
        accountId: inter.id,
        transactions: [
          {
            externalId,
            bookedOn,
            amountCents: 50000,
            currency: 'BRL',
            description,
            status,
            raw: null,
          },
        ],
      }),
      drain,
    )
  const entries = yield* Entries
  const nubankEntry = (yield* entries.entries(nubank.id))[0]!.id
  return {
    reconciliation: yield* Reconciliation,
    accounts,
    nubank,
    inter,
    nubankEntry,
    report,
    interEntries: entries.entries(inter.id),
  }
})

// Inter's feed reports a deposit on 14 Sep; the statement then reports the
// Pix on 10 Sep as a separate entry, which pairs with Nubank's.
const separateReports = Effect.gen(function* () {
  const setup = yield* twoAccounts
  yield* setup.report('a1', '2026-09-14', 'Deposito')
  yield* (yield* Imports).importFile({
    accountId: setup.inter.id,
    fileName: 'inter.ofx',
    bytes: ofx(line('i1', '20260910', '500.00', 'Pix recebido Donald')),
  })
  yield* drain
  const [transfer] = yield* setup.reconciliation.relations
  return { ...setup, transfer: transfer! }
})

// Two feeds report Inter's side: one a deposit on 14 Sep, the other the Pix
// on 10 Sep, a separate entry pairing with Nubank's. `decide` settles that
// pair; then the first feed corrects its report so both merge into the older
// entry, and the second withdraws the very observation the person decided on.
//
// With `older`, a third feed first reports a credit on 25 Sep, too late to
// pair, which it can later correct into the Pix too (`mergeOlder`).
const decidedThenWithdrawn = (
  decision: 'confirmed' | 'rejected',
  older = false,
) =>
  Effect.gen(function* () {
    const setup = yield* twoAccounts
    const observations = yield* Observations
    const feed = (externalRef: string, externalId: string) =>
      Effect.gen(function* () {
        const source = yield* observations.registerSource({
          kind: 'manual',
          externalRef,
          label: externalRef,
        })
        return (
          bookedOn: string,
          description: string,
          status: 'posted' | 'removed' = 'posted',
        ) =>
          Effect.andThen(
            observations.recordTransactions({
              sourceId: source.id,
              accountId: setup.inter.id,
              transactions: [
                {
                  externalId,
                  bookedOn,
                  amountCents: 50000,
                  currency: 'BRL',
                  description,
                  status,
                  raw: null,
                },
              ],
            }),
            drain,
          )
      })
    const reportOlder = yield* feed('inter-feed-3', 'c1')
    if (older) yield* reportOlder('2026-09-25', 'Ted recebido')
    const reportB = yield* feed('inter-feed-2', 'b1')
    const reportSecond = (status: 'posted' | 'removed') =>
      reportB('2026-09-10', 'Pix recebido Donald', status)
    yield* setup.report('a1', '2026-09-14', 'Deposito')
    yield* reportSecond('posted')
    const [transfer] = yield* setup.reconciliation.relations
    yield* setup.reconciliation.decide(transfer!.key, decision)

    yield* setup.report('a1', '2026-09-10', 'Pix recebido Donald')
    const [merged] = yield* setup.interEntries
    yield* reportSecond('removed')
    const remaining = yield* setup.interEntries
    assert.deepStrictEqual(
      remaining
        .filter((entry) => entry.bookedOn === '2026-09-10')
        .map((entry) => entry.id),
      [merged!.id],
    )
    assert.strictEqual(remaining.length, older ? 2 : 1)
    const mergeOlder = Effect.gen(function* () {
      yield* reportOlder('2026-09-10', 'Pix recebido Donald')
      const entries = yield* setup.interEntries
      assert.strictEqual(entries.length, 1)
      assert.notStrictEqual(entries[0]!.id, merged!.id)
      return entries[0]!
    })
    return { ...setup, transfer: transfer!, merged: merged!, mergeOlder }
  })

// A fuller Nubank statement shows another R$ 500,00 sent to Donald on 10 Sep.
const anotherDebit = (nubankId: string) =>
  Effect.gen(function* () {
    yield* (yield* Imports).importFile({
      accountId: nubankId,
      fileName: 'nubank-2.ofx',
      bytes: ofx(
        line('n1', '20260910', '-500.00', 'Pix enviado Donald') +
          line('n2', '20260910', '-500.00', 'Pix enviado Donald'),
      ),
    })
    yield* drain
    assert.strictEqual((yield* (yield* Entries).entries(nubankId)).length, 2)
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

        // A second link for an entry the person already linked is refused,
        // instead of succeeding without effect.
        yield* (yield* Imports).importFile({
          accountId: inter.id,
          fileName: 'inter-3.ofx',
          bytes: ofx(line('i3', '20260926', '80.00', 'Outro')),
        })
        yield* drain
        const entries = yield* (yield* Entries).entries(inter.id)
        const other = entries.find((item) => item.description === 'Outro')!.id
        const again = yield* reconciliation
          .link({ outflowEntryId: market, inflowEntryId: other })
          .pipe(Effect.flip)
        assert.strictEqual(
          again._tag === 'ReconciliationError' && again.reason,
          'already_linked',
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'keeps a rejection when the rejected entry merges into an older one',
    () =>
      Effect.gen(function* () {
        const { reconciliation, report, interEntries, transfer } =
          yield* separateReports
        yield* reconciliation.decide(transfer.key, 'rejected')

        // Inter corrects its report: it is the same Pix, so both merge into
        // the older entry, under a new relation key.
        yield* report('a1', '2026-09-10', 'Pix recebido Donald')
        assert.strictEqual((yield* interEntries).length, 1)
        assert.deepStrictEqual(yield* reconciliation.relations, [])
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'keeps a confirmation on the entries its movements merged into',
    () =>
      Effect.gen(function* () {
        const { reconciliation, report, interEntries, nubankEntry, transfer } =
          yield* separateReports
        yield* reconciliation.decide(transfer.key, 'confirmed')

        yield* report('a1', '2026-09-10', 'Pix recebido Donald')
        const [merged] = yield* interEntries
        assert.deepStrictEqual(
          (yield* reconciliation.relations).map((relation) => [
            relation.outflowEntryId,
            relation.inflowEntryId,
            relation.status,
            relation.origin,
          ]),
          [[nubankEntry, merged!.id, 'confirmed', 'person']],
        )
        assert.deepStrictEqual(yield* reconciliation.orphanedDecisions, [])
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'keeps a confirmation on its merged entry after its decided observation is withdrawn',
    () =>
      Effect.gen(function* () {
        const { reconciliation, nubank, nubankEntry, merged } =
          yield* decidedThenWithdrawn('confirmed')
        yield* anotherDebit(nubank.id)
        assert.deepStrictEqual(
          (yield* reconciliation.relations).map((relation) => [
            relation.outflowEntryId,
            relation.inflowEntryId,
            relation.status,
            relation.origin,
          ]),
          [[nubankEntry, merged.id, 'confirmed', 'person']],
        )
        assert.deepStrictEqual(yield* reconciliation.orphanedDecisions, [])
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'keeps a rejection on its merged entry after its decided observation is withdrawn',
    () =>
      Effect.gen(function* () {
        const { reconciliation } = yield* decidedThenWithdrawn('rejected')
        assert.deepStrictEqual(yield* reconciliation.relations, [])
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'keeps a confirmation past a withdrawn observation through a later merge',
    () =>
      Effect.gen(function* () {
        const { reconciliation, nubank, nubankEntry, mergeOlder } =
          yield* decidedThenWithdrawn('confirmed', true)
        const older = yield* mergeOlder
        yield* anotherDebit(nubank.id)
        assert.deepStrictEqual(
          (yield* reconciliation.relations).map((relation) => [
            relation.outflowEntryId,
            relation.inflowEntryId,
            relation.status,
            relation.origin,
          ]),
          [[nubankEntry, older.id, 'confirmed', 'person']],
        )
        assert.deepStrictEqual(yield* reconciliation.orphanedDecisions, [])
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'keeps a rejection past a withdrawn observation through a later merge',
    () =>
      Effect.gen(function* () {
        const { reconciliation, mergeOlder } = yield* decidedThenWithdrawn(
          'rejected',
          true,
        )
        yield* mergeOlder
        assert.deepStrictEqual(yield* reconciliation.relations, [])
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'reports a confirmation hidden by merged entries and lets the person reject it',
    () =>
      Effect.gen(function* () {
        const { reconciliation, report, interEntries, nubank, nubankEntry } =
          yield* separateReports
        yield* (yield* Imports).importFile({
          accountId: nubank.id,
          fileName: 'nubank-2.ofx',
          bytes: ofx(line('n2', '20260914', '-500.00', 'Pix enviado')),
        })
        yield* drain
        const second = (yield* (yield* Entries).entries(nubank.id)).find(
          (entry) => entry.id !== nubankEntry,
        )!.id
        const inflow = (description: string) =>
          Effect.map(
            interEntries,
            (found) =>
              found.find((entry) => entry.description === description)!.id,
          )
        // The person links each outflow to its own inflow.
        const links = new Map([
          [
            yield* reconciliation.link({
              outflowEntryId: nubankEntry,
              inflowEntryId: yield* inflow('Pix recebido Donald'),
            }),
            nubankEntry,
          ],
          [
            yield* reconciliation.link({
              outflowEntryId: second,
              inflowEntryId: yield* inflow('Deposito'),
            }),
            second,
          ],
        ])

        // Inter corrects its report: both inflows are one Pix and merge. One
        // confirmation holds the merged entry; the other waits for the person.
        yield* report('a1', '2026-09-10', 'Pix recebido Donald')
        assert.strictEqual((yield* interEntries).length, 1)
        const [kept] = yield* reconciliation.relations
        const [hidden, reserved] = [...links].find(
          ([, outflow]) => outflow !== kept?.outflowEntryId,
        )!
        assert.deepStrictEqual(
          (yield* reconciliation.orphanedDecisions).map((orphan) => [
            orphan.key,
            orphan.reason,
            orphan.reserved,
          ]),
          [[hidden, 'overlapping_confirmation', [reserved]]],
        )

        yield* reconciliation.decide(hidden, 'rejected')
        assert.deepStrictEqual(yield* reconciliation.orphanedDecisions, [])
        assert.deepStrictEqual(shape(yield* reconciliation.relations), [
          ['internal_transfer', 'confirmed', 'person'],
        ])
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'keeps every branch of a split confirmation rejected once the person rejects it',
    () =>
      Effect.gen(function* () {
        const { reconciliation, report, interEntries, inter } =
          yield* twoAccounts
        // Inter's feed and statement report one Pix, which the person confirms.
        yield* report('a1', '2026-09-10', 'Pix recebido Donald')
        yield* (yield* Imports).importFile({
          accountId: inter.id,
          fileName: 'inter.ofx',
          bytes: ofx(line('i1', '20260910', '500.00', 'Pix recebido Donald')),
        })
        yield* drain
        assert.strictEqual((yield* interEntries).length, 1)
        const [transfer] = yield* reconciliation.relations
        yield* reconciliation.decide(transfer!.key, 'confirmed')

        // The feed corrects its report into another movement: the entry
        // splits, one branch keeping the confirmed id.
        yield* report('a1', '2026-09-11', 'Deposito')
        const split = yield* interEntries
        assert.isTrue(
          split.length === 2 &&
            split.some((entry) => entry.id === transfer!.inflowEntryId),
        )
        assert.deepStrictEqual(
          (yield* reconciliation.orphanedDecisions).map((orphan) => [
            orphan.key,
            orphan.reason,
          ]),
          [[transfer!.key, 'entry_split']],
        )

        // Rejecting it rejects both branches, not only the one with its id.
        yield* reconciliation.decide(transfer!.key, 'rejected')
        assert.deepStrictEqual(yield* reconciliation.orphanedDecisions, [])
        assert.deepStrictEqual(yield* reconciliation.relations, [])
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('lets the person reject a confirmation whose entry vanished', () =>
    Effect.gen(function* () {
      const { reconciliation, report, nubankEntry } = yield* twoAccounts
      yield* report('x1', '2026-09-10', 'Pix recebido Donald')
      const [transfer] = yield* reconciliation.relations
      yield* reconciliation.decide(transfer!.key, 'confirmed')
      yield* report('x1', '2026-09-10', 'Pix recebido Donald', 'removed')
      assert.deepStrictEqual(
        (yield* reconciliation.orphanedDecisions).map((orphan) => [
          orphan.key,
          orphan.reason,
          orphan.reserved,
        ]),
        [[transfer!.key, 'entry_missing', [nubankEntry]]],
      )

      yield* reconciliation.decide(transfer!.key, 'rejected')
      assert.deepStrictEqual(yield* reconciliation.orphanedDecisions, [])
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'links the partner of an orphaned confirmation elsewhere, superseding it',
    () =>
      Effect.gen(function* () {
        const { reconciliation, report, interEntries, nubankEntry } =
          yield* twoAccounts
        yield* report('x1', '2026-09-10', 'Pix recebido Donald')
        const [transfer] = yield* reconciliation.relations
        yield* reconciliation.decide(transfer!.key, 'confirmed')
        yield* report('x1', '2026-09-10', 'Pix recebido Donald', 'removed')
        yield* report('x2', '2026-09-20', 'Credito')

        const key = yield* reconciliation.link({
          outflowEntryId: nubankEntry,
          inflowEntryId: (yield* interEntries)[0]!.id,
        })
        assert.deepStrictEqual(
          (yield* reconciliation.relations).map((relation) => [
            relation.key,
            relation.origin,
          ]),
          [[key, 'person']],
        )
        assert.deepStrictEqual(yield* reconciliation.orphanedDecisions, [])
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('revisits relations when an account changes kind', () =>
    Effect.gen(function* () {
      const { reconciliation, inter } = yield* setup
      const accounts = yield* Accounts
      const transfer = (yield* reconciliation.relations).find(
        (relation) => relation.kind === 'internal_transfer',
      )!
      yield* reconciliation.decide(transfer.key, 'confirmed')

      // Inter was a card all along: the confirmed transfer needs review.
      yield* accounts.update(inter.id, {
        kind: 'credit_card',
        card: new CardTerms({
          closingDay: 1,
          dueDay: 8,
          limitCents: null,
          lastFour: null,
        }),
      })
      yield* drain
      const changed = (yield* reconciliation.relations).find(
        (relation) => relation.key === transfer.key,
      )
      assert.deepStrictEqual(
        [changed?.status, changed?.reasons],
        ['conflict', ['confirmed_by_person', 'facts_changed']],
      )
    }).pipe(Effect.provide(openFinanceTest())),
  )
})
