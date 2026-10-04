import { assert, describe, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Statement from 'effect/sql/Statement'
import * as Tracer from 'effect/Tracer'

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
    return {
      ...setup,
      transfer: transfer!,
      merged: merged!,
      mergeOlder,
      reportB,
    }
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

// Inter pays the Nubank card bill on 12 Sep; two sources report the card's receipt
// on 14 Sep, one of them naming Maria Souza as the payer, in either order.
const cardReceiptFromTwoSources = (payerNamedFirst: boolean) =>
  Effect.gen(function* () {
    const accounts = yield* Accounts
    const imports = yield* Imports
    const observations = yield* Observations
    const owner = yield* accounts.createOwner({
      name: 'Donald Silveira',
      kind: 'person',
    })
    const bank = yield* accounts.open({
      ownerId: owner.id,
      institutionName: 'Inter',
      name: 'Inter',
      kind: 'checking',
      purpose: 'operating',
      currency: 'BRL',
    })
    const card = yield* accounts.open({
      ownerId: owner.id,
      institutionName: 'Nubank',
      name: 'Nubank Cartão',
      kind: 'credit_card',
      purpose: 'operating',
      currency: 'BRL',
      card: new CardTerms({
        closingDay: 3,
        dueDay: 10,
        limitCents: null,
        lastFour: null,
      }),
    })
    yield* imports.importFile({
      accountId: bank.id,
      fileName: 'inter.ofx',
      bytes: ofx(line('n1', '20260912', '-1500.00', 'Pagamento fatura Nubank')),
    })
    const statement = imports.importFile({
      accountId: card.id,
      fileName: 'cartao.ofx',
      bytes: ofx(
        line('c1', '20260914', '1500.00', 'Pagamento recebido'),
        'CCSTMTRS',
      ),
    })
    const feed = Effect.gen(function* () {
      const source = yield* observations.registerSource({
        kind: 'manual',
        externalRef: 'nubank-card-feed',
        label: 'Nubank',
      })
      yield* observations.recordTransactions({
        sourceId: source.id,
        accountId: card.id,
        transactions: [
          {
            externalId: 'f1',
            bookedOn: '2026-09-14',
            amountCents: 150000,
            currency: 'BRL',
            description: 'Pagamento recebido de Maria Souza',
            status: 'posted',
            raw: null,
          },
        ],
      })
    })
    if (payerNamedFirst) {
      yield* feed
      yield* drain
      yield* statement
    } else {
      yield* statement
      yield* drain
      yield* feed
    }
    yield* drain
    const entries = yield* (yield* Entries).entries(card.id)
    return {
      sources: entries.map((entry) => entry.sources),
      relations: yield* (yield* Reconciliation).relations,
    }
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
    'rejecting a followed confirmation also covers its withdrawn observation',
    () =>
      Effect.gen(function* () {
        const { reconciliation, reportB, nubankEntry, merged } =
          yield* decidedThenWithdrawn('confirmed')
        const [followed] = yield* reconciliation.relations
        assert.strictEqual(followed!.inflowEntryId, merged.id)
        yield* reconciliation.decide(followed!.key, 'rejected')
        assert.deepStrictEqual(yield* reconciliation.relations, [])

        // The withdrawn Pix returns as a separate salary on 20 Sep: the
        // person's rejection still covers it, so no confirmation resurfaces.
        yield* reportB('2026-09-20', 'Salario Donald')
        assert.isFalse(
          (yield* reconciliation.relations).some(
            (relation) =>
              relation.outflowEntryId === nubankEntry &&
              (relation.origin === 'person' || relation.status === 'confirmed'),
          ),
        )
        assert.deepStrictEqual(yield* reconciliation.orphanedDecisions, [])
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

  it.effect(
    'keeps a rejection that commits while a rebuild is computing relations',
    () =>
      Effect.gen(function* () {
        const { reconciliation, report } = yield* twoAccounts
        yield* report('x1', '2026-09-10', 'Pix recebido Donald')
        const [transfer] = yield* reconciliation.relations
        assert.deepStrictEqual(shape([transfer!]), [
          ['internal_transfer', 'confirmed', 'auto'],
        ])

        // A rebuild has matched entries and decisions and stops right before
        // comparing with stored relations.
        const reached = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const hold: Statement.Transformer = (statement) =>
          statement.compile()[0].includes('FROM relations ORDER BY key') &&
          !Deferred.isDoneUnsafe(reached)
            ? Deferred.succeed(reached, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(statement),
              )
            : Effect.succeed(statement)
        const rebuild = yield* reconciliation
          .rebuild()
          .pipe(
            Effect.provideService(Statement.CurrentTransformer, hold),
            Effect.forkChild,
          )
        yield* Deferred.await(reached)

        // The person rejects the pair meanwhile. The rebuild resumes once
        // the rejection either committed or waits for its turn.
        const waiting = yield* Deferred.make<void>()
        const base = yield* Effect.tracer
        const observe = Tracer.make({
          ...(base.context ? { context: base.context } : {}),
          span: (options) => {
            if (options.name === 'Reconciliation.serialize')
              Deferred.doneUnsafe(waiting, Effect.void)
            return base.span(options)
          },
        })
        const decide = yield* reconciliation
          .decide(transfer!.key, 'rejected')
          .pipe(Effect.withTracer(observe), Effect.forkChild)
        yield* Effect.raceFirst(Deferred.await(waiting), Fiber.await(decide))
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(rebuild)
        yield* Fiber.join(decide)

        assert.deepStrictEqual(yield* reconciliation.relations, [])
        yield* reconciliation.rebuild()
        assert.deepStrictEqual(yield* reconciliation.relations, [])
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'keeps a card payment suggested when any source of its receipt names another payer',
    () =>
      Effect.gen(function* () {
        for (const payerNamedFirst of [false, true]) {
          const { sources, relations } = yield* cardReceiptFromTwoSources(
            payerNamedFirst,
          ).pipe(Effect.provide(openFinanceTest()))
          assert.deepStrictEqual(sources, [2])
          assert.deepStrictEqual(
            relations.map((relation) => [
              relation.kind,
              relation.status,
              relation.reasons.includes('names_third_party_payer'),
            ]),
            [['card_payment', 'suggested', true]],
          )
        }
      }),
  )

  it.effect(
    'revisits an automatic transfer when a secondary source names another payer',
    () =>
      Effect.gen(function* () {
        // The statement and Inter's feed report the Pix alike; the feed then
        // corrects its description to add Maria Souza, leaving the entry as is.
        const { reconciliation, inter, interEntries, report } =
          yield* twoAccounts
        yield* (yield* Imports).importFile({
          accountId: inter.id,
          fileName: 'inter.ofx',
          bytes: ofx(line('i1', '20260910', '500.00', 'Pix recebido Donald')),
        })
        yield* drain
        yield* report('a1', '2026-09-10', 'Pix recebido Donald')
        assert.deepStrictEqual(
          (yield* interEntries).map((entry) => entry.sources),
          [2],
        )
        assert.deepStrictEqual(shape(yield* reconciliation.relations), [
          ['internal_transfer', 'confirmed', 'auto'],
        ])

        yield* report('a1', '2026-09-10', 'Pix recebido Donald de Maria Souza')
        assert.deepStrictEqual(
          (yield* interEntries).map((entry) => [
            entry.description,
            entry.sources,
          ]),
          [['Pix recebido Donald', 2]],
        )
        assert.deepStrictEqual(shape(yield* reconciliation.relations), [
          ['internal_transfer', 'suggested', 'auto'],
        ])
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'revisits an automatic card payment when a secondary source names another payer',
    () =>
      Effect.gen(function* () {
        const { reconciliation, card, entryId } = yield* setup
        const observations = yield* Observations
        const feed = yield* observations.registerSource({
          kind: 'manual',
          externalRef: 'nubank-card-feed',
          label: 'Nubank',
        })
        const report = (description: string) =>
          Effect.andThen(
            observations.recordTransactions({
              sourceId: feed.id,
              accountId: card.id,
              transactions: [
                {
                  externalId: 'f1',
                  bookedOn: '2026-09-14',
                  amountCents: 150000,
                  currency: 'BRL',
                  description,
                  status: 'posted',
                  raw: null,
                },
              ],
            }),
            drain,
          )
        const entries = yield* Entries
        const receipt = Effect.andThen(entryId(card.id, 150000), (id) =>
          Effect.map(entries.entries(card.id), (found) =>
            found
              .filter((entry) => entry.id === id)
              .map((entry) => [entry.description, entry.sources]),
          ),
        )
        const payment = Effect.map(reconciliation.relations, (relations) =>
          shape(
            relations.filter((relation) => relation.kind === 'card_payment'),
          ),
        )
        yield* report('Pagamento recebido')
        assert.deepStrictEqual(yield* receipt, [['Pagamento recebido', 2]])
        assert.deepStrictEqual(yield* payment, [
          ['card_payment', 'confirmed', 'auto'],
        ])

        yield* report('Pagamento recebido de Maria Souza')
        assert.deepStrictEqual(yield* receipt, [['Pagamento recebido', 2]])
        assert.deepStrictEqual(yield* payment, [
          ['card_payment', 'suggested', 'auto'],
        ])
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'keeps imported pairs suggested when a description has words it cannot account for',
    () =>
      Effect.gen(function* () {
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
        const inter = yield* open('Banco Inter')
        const card = yield* open(
          'Nubank',
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
            line('n1', '20260910', '-500.00', 'Pix enviado Ted Banco Inter'),
          ),
        })
        yield* imports.importFile({
          accountId: inter.id,
          fileName: 'inter.ofx',
          bytes: ofx(
            line('i1', '20260910', '500.00', 'Pix recebido') +
              line('i2', '20260912', '-1500.00', 'Pagamento fatura Nubank'),
          ),
        })
        yield* imports.importFile({
          accountId: card.id,
          fileName: 'cartao.ofx',
          bytes: ofx(
            line('c1', '20260914', '1500.00', 'Pagamento recebido de Ted'),
            'CCSTMTRS',
          ),
        })
        yield* drain
        const relations = yield* (yield* Reconciliation).relations
        assert.deepStrictEqual(
          relations.map((relation) => [
            relation.kind,
            relation.status,
            relation.reasons.includes('unrecognized_words'),
          ]),
          [
            ['card_payment', 'suggested', true],
            ['internal_transfer', 'suggested', true],
          ],
        )
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

  it.effect('links a card refund to the purchase it gives back', () =>
    Effect.gen(function* () {
      const { reconciliation, card } = yield* setup
      yield* (yield* Imports).importFile({
        accountId: card.id,
        fileName: 'cartao-2.ofx',
        bytes: ofx(
          line('c2', '20260916', '-250.00', 'Amazon Marketplace') +
            line('c3', '20260925', '250.00', 'Estorno Amazon Marketplace'),
          'CCSTMTRS',
        ),
      })
      yield* drain
      const refunds = (yield* reconciliation.relations).filter(
        (relation) => relation.kind === 'refund',
      )
      assert.deepStrictEqual(
        refunds.map((relation) => [
          relation.status,
          relation.reasons.includes('refund_wording'),
        ]),
        [['confirmed', true]],
      )
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'does not confirm a refund against another shop of the same business',
    () =>
      Effect.gen(function* () {
        const { reconciliation, card, entryId } = yield* setup
        yield* (yield* Imports).importFile({
          accountId: card.id,
          fileName: 'cartao-bom-preco.ofx',
          bytes: ofx(
            line('b1', '20260910', '-50.00', 'Acougue Bom Preco') +
              line('b2', '20260911', '-250.00', 'Supermercado Bom Preco') +
              line('b3', '20260915', '50.00', 'Estorno Supermercado Bom Preco'),
            'CCSTMTRS',
          ),
        })
        yield* drain
        const supermarket = yield* entryId(card.id, -25000)
        const refunds = (yield* reconciliation.relations).filter(
          (relation) => relation.kind === 'refund',
        )
        assert.deepStrictEqual(
          refunds.map((relation) => [relation.outflowEntryId, relation.status]),
          [[supermarket, 'suggested']],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'does not confirm a refund from another trade under a shared umbrella word, but does from the same trade',
    () =>
      Effect.gen(function* () {
        const { reconciliation, card, entryId } = yield* setup
        yield* (yield* Imports).importFile({
          accountId: card.id,
          fileName: 'cartao-umbrella.ofx',
          bytes: ofx(
            line('u1', '20260910', '-50.00', 'Auto Pecas Avenida') +
              line('u2', '20260911', '-250.00', 'Auto Oficina Avenida') +
              line('u3', '20260915', '50.00', 'Estorno Auto Oficina Avenida') +
              line('u4', '20260910', '-60.00', 'Petshop Bicho Feliz') +
              line('u5', '20260911', '-300.00', 'Pet Clinica Bicho Feliz') +
              line(
                'u6',
                '20260915',
                '60.00',
                'Estorno Pet Clinica Bicho Feliz',
              ) +
              line('u7', '20260910', '-70.00', 'Pet Shop Primavera') +
              line('u8', '20260915', '70.00', 'Estorno Pet Clinica Primavera') +
              line('u9', '20260910', '-80.00', 'Auto Pecas Horizonte Azul') +
              line(
                'u10',
                '20260915',
                '80.00',
                'Estorno Autopecas Horizonte Azul',
              ) +
              line('u11', '20260910', '-90.00', 'Auto Posto Ipiranga') +
              line('u12', '20260915', '90.00', 'Estorno Posto Ipiranga'),
            'CCSTMTRS',
          ),
        })
        yield* drain
        const refunds = (yield* reconciliation.relations).filter(
          (relation) => relation.kind === 'refund',
        )
        const statusOf = (purchaseCents: number) =>
          Effect.map(entryId(card.id, purchaseCents), (id) =>
            refunds
              .filter(
                (relation) =>
                  relation.outflowEntryId === id &&
                  relation.status === 'confirmed',
              )
              .map((relation) => relation.status),
          )
        assert.deepStrictEqual(
          [
            yield* statusOf(-5000),
            yield* statusOf(-25000),
            yield* statusOf(-6000),
            yield* statusOf(-30000),
            yield* statusOf(-7000),
            yield* statusOf(-8000),
            yield* statusOf(-9000),
          ],
          [[], [], [], [], [], ['confirmed'], ['confirmed']],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'does not confirm a refund from another trade named in the plural or in words it does not know',
    () =>
      Effect.gen(function* () {
        const { reconciliation, card, entryId } = yield* setup
        yield* (yield* Imports).importFile({
          accountId: card.id,
          fileName: 'cartao-trades.ofx',
          bytes: ofx(
            line('t1', '20260910', '-50.00', 'Acougues Bom Preco') +
              line(
                't2',
                '20260915',
                '50.00',
                'Estorno Supermercado Bom Preco',
              ) +
              line('t3', '20260910', '-160.00', 'Postos Avenida') +
              line('t4', '20260915', '160.00', 'Estorno Restaurante Avenida') +
              line('t5', '20260910', '-270.00', 'Hoteis Atlantico') +
              line('t6', '20260915', '270.00', 'Estorno Pousada Atlantico') +
              line('t7', '20260910', '-380.00', 'Quitanda Primavera') +
              line('t8', '20260915', '380.00', 'Estorno Mercado Primavera') +
              line('t9', '20260910', '-490.00', 'Drogarias Raia') +
              line('t10', '20260915', '490.00', 'Estorno Drogaria Raia'),
            'CCSTMTRS',
          ),
        })
        yield* drain
        const refunds = (yield* reconciliation.relations).filter(
          (relation) => relation.kind === 'refund',
        )
        const statusOf = (purchaseCents: number) =>
          Effect.map(entryId(card.id, purchaseCents), (id) =>
            refunds
              .filter((relation) => relation.outflowEntryId === id)
              .map((relation) => relation.status),
          )
        assert.deepStrictEqual(
          [
            yield* statusOf(-5000),
            yield* statusOf(-16000),
            yield* statusOf(-27000),
            yield* statusOf(-38000),
            yield* statusOf(-49000),
          ],
          [
            ['suggested'],
            ['suggested'],
            ['suggested'],
            ['suggested'],
            ['confirmed'],
          ],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'links several refunds of one purchase, refuses one beyond it, and keeps them against later debits',
    () =>
      Effect.gen(function* () {
        const { reconciliation, nubank, card, entryId } = yield* setup
        const imports = yield* Imports
        yield* imports.importFile({
          accountId: card.id,
          fileName: 'cartao-pedido.ofx',
          bytes: ofx(
            line('p1', '20260916', '-250.00', 'Loja Online') +
              line('p2', '20260920', '50.00', 'Credito') +
              line('p3', '20260922', '200.00', 'Credito ajuste') +
              line('p4', '20260923', '10.00', 'Credito'),
            'CCSTMTRS',
          ),
        })
        yield* drain
        const order = yield* entryId(card.id, -25000)
        const keys = []
        for (const amount of [5000, 20000]) {
          keys.push(
            yield* reconciliation.link({
              outflowEntryId: order,
              inflowEntryId: yield* entryId(card.id, amount),
            }),
          )
        }
        const beyond = yield* reconciliation
          .link({
            outflowEntryId: order,
            inflowEntryId: yield* entryId(card.id, 1000),
          })
          .pipe(Effect.flip)

        // A bank debit of the same amount arrives later; the refund holds.
        yield* imports.importFile({
          accountId: nubank.id,
          fileName: 'nubank-2.ofx',
          bytes: ofx(line('n4', '20260922', '-200.00', 'Pagamento fatura')),
        })
        yield* drain
        const relations = yield* reconciliation.relations
        assert.deepStrictEqual(
          [
            beyond._tag === 'ReconciliationError' && beyond.reason,
            keys.map(
              (key) =>
                relations.find((relation) => relation.key === key)?.status,
            ),
          ],
          ['exceeds_purchase', ['confirmed', 'confirmed']],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  // A purchase and a same-merchant credit on the card, reported by `source`.
  const cardCredit = Effect.gen(function* () {
    const { reconciliation, card } = yield* setup
    const observations = yield* Observations
    const register = (ref: string) =>
      observations.registerSource({
        kind: 'open_finance',
        externalRef: ref,
        label: ref,
      })
    const report = (
      sourceId: string,
      externalId: string,
      amountCents: number,
      bookedOn: string,
      raw: Record<string, string>,
    ) =>
      Effect.andThen(
        observations.recordTransactions({
          sourceId,
          accountId: card.id,
          transactions: [
            {
              externalId,
              bookedOn,
              amountCents,
              currency: 'BRL',
              description: 'Amazon Marketplace',
              status: 'posted',
              raw,
            },
          ],
        }),
        drain,
      )
    const source = yield* register('feed')
    yield* report(source.id, 'order', -25000, '2026-09-16', {})
    const refunds = Effect.map(reconciliation.relations, (relations) =>
      relations
        .filter((relation) => relation.kind === 'refund')
        .map((relation) => relation.status),
    )
    return { reconciliation, source, register, report, refunds }
  })

  // Amazon purchases on the card, then a credit the feed calls an ESTORNO;
  // what each purchase's refund relations are.
  const estornoAgainst = (
    purchasesCents: ReadonlyArray<number>,
    description: string,
  ) =>
    Effect.gen(function* () {
      const { reconciliation, card } = yield* setup
      const observations = yield* Observations
      const source = yield* observations.registerSource({
        kind: 'open_finance',
        externalRef: 'amazon-feed',
        label: 'Amazon feed',
      })
      yield* observations.recordTransactions({
        sourceId: source.id,
        accountId: card.id,
        transactions: [
          ...purchasesCents.map((amountCents, index) => ({
            externalId: `order-${index}`,
            bookedOn: '2026-09-16',
            amountCents,
            currency: 'BRL',
            description: 'Amazon Marketplace',
            status: 'posted' as const,
            raw: null,
          })),
          {
            externalId: 'credit',
            bookedOn: '2026-09-25',
            amountCents: 5000,
            currency: 'BRL',
            description,
            status: 'posted' as const,
            raw: { operationType: 'ESTORNO' },
          },
        ],
      })
      yield* drain
      const found = yield* (yield* Entries).entries(card.id)
      const amountOf = (id: string) =>
        found.find((entry) => entry.id === id)?.amountCents
      return (yield* reconciliation.relations)
        .filter((relation) => relation.kind === 'refund')
        .map((relation) => [amountOf(relation.outflowEntryId), relation.status])
    })

  for (const description of [
    'Estorno parcial Amazon Marketplace',
    'Devolucao parcial Amazon Marketplace',
    'Estorno parc Amazon Marketplace',
  ])
    it.effect(
      `keeps "${description}" suggested while a larger purchase of the shop could be its order`,
      () =>
        Effect.gen(function* () {
          assert.deepStrictEqual(
            (yield* estornoAgainst([-5000, -25000], description)).map(
              ([, status]) => status,
            ),
            ['suggested'],
          )
        }).pipe(Effect.provide(openFinanceTest())),
    )

  it.effect('confirms a partial refund of the only order it can return', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* estornoAgainst([-25000], 'Estorno parcial Amazon Marketplace'),
        [[-25000, 'confirmed']],
      )
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('confirms a whole refund against the purchase of its amount', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* estornoAgainst([-5000, -25000], 'Estorno Amazon Marketplace'),
        [[-5000, 'confirmed']],
      )
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect('drops a refund once a credit is corrected to cashback', () =>
    Effect.gen(function* () {
      const { source, report, refunds } = yield* cardCredit
      yield* report(source.id, 'credit', 25000, '2026-09-25', {})
      const before = yield* refunds
      // Only the operation changes: entries stay the same.
      yield* report(source.id, 'credit', 25000, '2026-09-25', {
        operationType: 'CASHBACK',
      })
      assert.deepStrictEqual([before, yield* refunds], [['confirmed'], []])
    }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'drops a refund once its credit is called anything but a refund',
    () =>
      Effect.gen(function* () {
        const { source, report, refunds } = yield* cardCredit
        const credit = (operationType: string) =>
          Effect.andThen(
            report(source.id, 'credit', 25000, '2026-09-25', { operationType }),
            refunds,
          )
        assert.deepStrictEqual(
          [
            yield* credit('ESTORNO'),
            yield* credit('PAGAMENTO_FATURA'),
            yield* credit('CHARGEBACK'),
            yield* credit('OPERACOES_CREDITO_CONTRATADAS_CARTAO'),
          ],
          [['confirmed'], [], ['confirmed'], []],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'reads the current operation of each source, and doubts a credit any source calls cashback',
    () =>
      Effect.gen(function* () {
        const { reconciliation, source, register, report, refunds } =
          yield* cardCredit
        yield* report(source.id, 'credit', 25000, '2026-09-25', {
          operationType: 'ESTORNO',
        })
        yield* report(source.id, 'credit', 25000, '2026-09-25', {
          operationType: 'CASHBACK',
        })
        yield* reconciliation.rebuild()
        const corrected = yield* refunds

        yield* report(source.id, 'credit', 25000, '2026-09-25', {
          operationType: 'ESTORNO',
        })
        const other = yield* register('other-feed')
        yield* report(other.id, 'credit', 25000, '2026-09-25', {
          operationType: 'CASHBACK',
        })
        yield* reconciliation.rebuild()
        assert.deepStrictEqual([corrected, yield* refunds], [[], []])
      }).pipe(Effect.provide(openFinanceTest())),
  )

  it.effect(
    'keeps a refund whose credit vanished when another refund of the purchase is linked',
    () =>
      Effect.gen(function* () {
        const { reconciliation, card } = yield* setup
        const observations = yield* Observations
        const entries = yield* Entries
        const source = yield* observations.registerSource({
          kind: 'manual',
          externalRef: 'card-feed',
          label: 'Card',
        })
        const report = (
          externalId: string,
          bookedOn: string,
          amountCents: number,
          description: string,
          status: 'posted' | 'removed' = 'posted',
        ) =>
          Effect.andThen(
            observations.recordTransactions({
              sourceId: source.id,
              accountId: card.id,
              transactions: [
                {
                  externalId,
                  bookedOn,
                  amountCents,
                  currency: 'BRL',
                  description,
                  status,
                  raw: null,
                },
              ],
            }),
            drain,
          )
        const entryId = (amountCents: number) =>
          Effect.map(
            entries.entries(card.id),
            (found) =>
              found.find((entry) => entry.amountCents === amountCents)!.id,
          )
        yield* report('order', '2026-09-16', -25000, 'Loja Online')
        yield* report('first', '2026-09-20', 5000, 'Credito')
        const order = yield* entryId(-25000)
        const first = yield* reconciliation.link({
          outflowEntryId: order,
          inflowEntryId: yield* entryId(5000),
        })
        yield* report('first', '2026-09-20', 5000, 'Credito', 'removed')
        yield* report('second', '2026-09-22', 20000, 'Credito ajuste')
        const second = yield* reconciliation.link({
          outflowEntryId: order,
          inflowEntryId: yield* entryId(20000),
        })
        const orphans = (yield* reconciliation.orphanedDecisions).map(
          (orphan) => [orphan.key, orphan.reason, orphan.reserved],
        )

        // The credit returns: its confirmation still holds.
        yield* report('first', '2026-09-20', 5000, 'Credito')
        const statuses = (yield* reconciliation.relations)
          .filter((relation) => relation.kind === 'refund')
          .map((relation) => [relation.status, relation.origin])
        assert.deepStrictEqual(
          [orphans, statuses, first !== second],
          [
            [[first, 'entry_missing', []]],
            [
              ['confirmed', 'person'],
              ['confirmed', 'person'],
            ],
            true,
          ],
        )
      }).pipe(Effect.provide(openFinanceTest())),
  )
})
