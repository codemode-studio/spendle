import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import * as SqlClient from 'effect/sql/SqlClient'

import { Imports } from '../imports/Imports.ts'
import { Accounts, CardTerms } from '../ledger/Accounts.ts'
import { Entries } from '../ledger/Entries.ts'
import { Observations } from '../ledger/Observations.ts'
import type { ReportedTransaction } from '../ledger/Observations.ts'
import type { PluggyTransaction } from '../openfinance/PluggyApi.ts'
import {
  bank,
  categoriesTest,
  connect,
  drain,
  tx,
} from '../testing/FakePluggy.ts'
import { Categorizer, startup } from './Categorizer.ts'
import { KnowledgeStore } from './KnowledgeStore.ts'
import { POLICY_VERSION } from './Policy.ts'

const ofx = (lines: string, tag = 'STMTRS') =>
  new TextEncoder().encode(`OFXHEADER:100
CHARSET:UTF-8

<OFX><MSGS><${tag}><CURDEF>BRL<BANKTRANLIST>${lines}</BANKTRANLIST></${tag}></MSGS></OFX>`)

const line = (fitid: string, date: string, amount: string, memo: string) =>
  `<STMTTRN><DTPOSTED>${date}<TRNAMT>${amount}<FITID>${fitid}<MEMO>${memo}</STMTTRN>`

// One checking account with a statement already imported.
const statement = (lines: string) =>
  Effect.gen(function* () {
    const accounts = yield* Accounts
    const owner = yield* accounts.createOwner({
      name: 'Donald',
      kind: 'person',
    })
    const account = yield* accounts.open({
      ownerId: owner.id,
      institutionName: 'Nubank',
      name: 'Nubank',
      kind: 'checking',
      purpose: 'operating',
      currency: 'BRL',
    })
    if (lines !== '')
      yield* (yield* Imports).importFile({
        accountId: account.id,
        fileName: 'nubank.ofx',
        bytes: ofx(lines),
      })
    yield* drain
    const entries = yield* Entries
    const categorizer = yield* Categorizer
    // Entry ids by description and date, as the person would find them.
    const entry = (description: string, bookedOn?: string) =>
      Effect.map(
        entries.entries(account.id),
        (all) =>
          all.find(
            (found) =>
              found.description === description &&
              (bookedOn === undefined || found.bookedOn === bookedOn),
          )!.id,
      )
    const inferenceOf = (entryId: string) =>
      Effect.map(categorizer.explain(entryId), (inference) => ({
        categoryId: inference.categoryId,
        origin: inference.origin,
        status: inference.status,
        confidence: inference.confidence,
      }))
    return {
      account,
      categorizer,
      store: yield* KnowledgeStore,
      entry,
      inferenceOf,
    }
  })

describe('Categorizer', () => {
  it.effect(
    'keeps a decision on a pending Pluggy entry once it posts and merges with a statement line',
    () =>
      Effect.gen(function* () {
        const purchase = (fields: Partial<PluggyTransaction> = {}) =>
          tx('padaria', '2026-10-01', {
            description: 'PADARIA SAO JOSE',
            amount: 25.5,
            ...fields,
          })
        const { openFinance, connectionId, state } = yield* connect({
          accounts: [bank],
          transactions: {
            'provider-bank': [purchase({ status: 'PENDING' })],
          },
        })
        const account = yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank',
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        })
        yield* drain
        const entries = yield* Entries
        const categorizer = yield* Categorizer
        const [pending] = yield* entries.entries(account.id)
        assert.strictEqual(pending!.status, 'pending')
        yield* categorizer.decide(pending!.id, 'groceries')

        yield* Ref.update(state, (current) => ({
          ...current,
          transactions: { 'provider-bank': [purchase()] },
        }))
        yield* openFinance.requestSync({ connectionId })
        yield* drain
        yield* (yield* Imports).importFile({
          accountId: account.id,
          fileName: 'extrato.ofx',
          bytes: ofx(
            line('f1', '20261001', '-25.50', 'Compra PADARIA SAO JOSE'),
          ),
        })
        yield* drain

        const [merged, ...others] = yield* entries.entries(account.id)
        assert.deepStrictEqual(others, [])
        assert.deepInclude(merged, { status: 'posted', sources: 2 })
        const inference = yield* categorizer.explain(merged!.id)
        assert.deepInclude(inference, {
          categoryId: 'groceries',
          origin: 'decision',
          status: 'applied',
          confidence: 100,
        })
      }).pipe(Effect.provide(categoriesTest())),
  )

  it.effect(
    'learns from a decision and applies it to the same merchant’s other movements',
    () =>
      Effect.gen(function* () {
        const { categorizer, store, entry, inferenceOf } = yield* statement(
          line('a', '20260901', '-23.90', 'Uber *Trip 0109') +
            line('b', '20260915', '-31.10', 'Uber *Trip 1509') +
            line('c', '20260920', '-12.00', 'Padaria Real'),
        )
        const first = yield* entry('Uber *Trip 0109')
        const second = yield* entry('Uber *Trip 1509')
        assert.strictEqual((yield* inferenceOf(second)).status, 'none')

        yield* categorizer.decide(first, 'transport')
        yield* drain

        assert.deepStrictEqual(yield* inferenceOf(second), {
          categoryId: 'transport',
          origin: 'pattern',
          status: 'applied',
          confidence: 98,
        })
        assert.strictEqual(
          (yield* inferenceOf(yield* entry('Padaria Real'))).status,
          'none',
        )
        const [pattern] = yield* store.list
        assert.deepInclude(pattern, {
          pattern: 'uber trip',
          direction: 'expense',
          categoryId: 'transport',
          categoryName: 'Transporte',
          confirmations: 1,
        })
      }).pipe(Effect.provide(categoriesTest())),
  )

  it.effect(
    'applies a store edit to history, previewed exactly, and leaves decided entries alone',
    () =>
      Effect.gen(function* () {
        const { categorizer, store, entry, inferenceOf } = yield* statement(
          line('a', '20260901', '-80.00', 'Restaurante Sabor') +
            line('b', '20260910', '-95.00', 'Restaurante Sabor') +
            line('c', '20260920', '-60.00', 'Restaurante Sabor'),
        )
        const decided = yield* entry('Restaurante Sabor', '2026-09-01')
        yield* categorizer.decide(decided, 'restaurants')
        yield* drain
        const [pattern] = yield* store.list

        const preview = yield* categorizer.previewStoreEdit({
          _tag: 'Recategorize',
          id: pattern!.id,
          categoryId: 'delivery',
        })
        assert.sameMembers(
          preview.map((change) => change.entryId),
          [
            yield* entry('Restaurante Sabor', '2026-09-10'),
            yield* entry('Restaurante Sabor', '2026-09-20'),
          ],
        )
        assert.deepStrictEqual(
          preview.map((change) => [
            change.before.categoryId,
            change.after.categoryId,
          ]),
          [
            ['restaurants', 'delivery'],
            ['restaurants', 'delivery'],
          ],
        )

        yield* store.recategorize(pattern!.id, 'delivery')
        yield* drain
        for (const change of preview) {
          const stored = yield* categorizer.explain(change.entryId)
          const { candidates, entryId, ...expected } = change.after
          assert.deepInclude(stored, { ...expected, entryId })
          assert.deepStrictEqual(stored.candidates, candidates)
        }
        assert.deepInclude(yield* inferenceOf(decided), {
          categoryId: 'restaurants',
          origin: 'decision',
        })
        assert.deepInclude((yield* store.list)[0], {
          categoryId: 'delivery',
          confirmations: 1,
          corrections: 1,
        })
      }).pipe(Effect.provide(categoriesTest())),
  )

  it.effect('sends a merchant to review when its patterns disagree', () =>
    Effect.gen(function* () {
      const { categorizer, entry, inferenceOf } = yield* statement(
        line('a', '20260901', '-300.00', 'Pix enviado JOAO DA SILVA') +
          line('b', '20260905', '-150.00', 'JOAO DA SILVA') +
          line('c', '20260920', '-300.00', 'Pix enviado JOAO DA SILVA'),
      )
      yield* categorizer.decide(
        yield* entry('Pix enviado JOAO DA SILVA', '2026-09-01'),
        'family',
      )
      yield* categorizer.decide(yield* entry('JOAO DA SILVA'), 'maintenance')
      yield* drain
      const later = yield* entry('Pix enviado JOAO DA SILVA', '2026-09-20')
      assert.deepStrictEqual(yield* inferenceOf(later), {
        categoryId: 'family',
        origin: 'pattern',
        status: 'review',
        confidence: 98,
      })
      const explained = yield* categorizer.explain(later)
      assert.include(explained.reasons, 'conflicting_patterns')
      assert.deepStrictEqual(
        explained.candidates.map((candidate) => candidate.categoryId),
        ['maintenance'],
      )
      assert.deepStrictEqual(
        (yield* categorizer.reviewQueue).map((item) => item.inference.entryId),
        [later],
      )
    }).pipe(Effect.provide(categoriesTest())),
  )

  it.effect(
    'sends a pattern corrected more often than confirmed to review',
    () =>
      Effect.gen(function* () {
        const { categorizer, entry, inferenceOf } = yield* statement(
          line('a', '20260901', '-40.00', 'Loja Alfa') +
            line('b', '20260905', '-41.00', 'Loja Alfa') +
            line('c', '20260910', '-42.00', 'Loja Alfa') +
            line('d', '20260920', '-43.00', 'Loja Alfa'),
        )
        const on = (day: string) => entry('Loja Alfa', `2026-09-${day}`)
        yield* categorizer.decide(yield* on('01'), 'shopping')
        yield* categorizer.decide(yield* on('05'), 'pets')
        yield* categorizer.decide(yield* on('10'), 'shopping')
        yield* drain
        assert.deepInclude(yield* inferenceOf(yield* on('20')), {
          categoryId: 'shopping',
          status: 'review',
        })
      }).pipe(Effect.provide(categoriesTest())),
  )

  it.effect('sends both parts of a decided entry that split to review', () =>
    Effect.gen(function* () {
      const { account, categorizer, inferenceOf } = yield* statement('')
      const observations = yield* Observations
      // Two feeds report the same purchase, then one corrects its date.
      const feed = (externalRef: string) =>
        Effect.gen(function* () {
          const source = yield* observations.registerSource({
            kind: 'manual',
            externalRef,
            label: externalRef,
          })
          return (bookedOn: string) =>
            Effect.andThen(
              observations.recordTransactions({
                sourceId: source.id,
                accountId: account.id,
                transactions: [
                  {
                    externalId: 'x1',
                    bookedOn,
                    amountCents: -12000,
                    currency: 'BRL',
                    description: 'Farmacia Central',
                    status: 'posted',
                    raw: null,
                  },
                ],
              }),
              drain,
            )
        })
      const first = yield* feed('one')
      const second = yield* feed('two')
      yield* first('2026-09-10')
      yield* second('2026-09-11')
      const entries = yield* Entries
      const [whole, ...none] = yield* entries.entries(account.id)
      assert.deepStrictEqual(none, [])
      yield* categorizer.decide(whole!.id, 'health')

      yield* second('2026-09-25')
      const parts = yield* entries.entries(account.id)
      assert.strictEqual(parts.length, 2)
      for (const part of parts) {
        assert.deepStrictEqual(yield* inferenceOf(part.id), {
          categoryId: 'health',
          origin: 'decision',
          status: 'review',
          confidence: 70,
        })
        assert.deepStrictEqual((yield* categorizer.explain(part.id)).reasons, [
          'decision_split',
        ])
      }
      // Confirming a part settles it alone.
      yield* categorizer.confirm(parts[0]!.id)
      assert.deepInclude(yield* inferenceOf(parts[0]!.id), {
        status: 'applied',
        confidence: 100,
      })
      assert.strictEqual((yield* inferenceOf(parts[1]!.id)).status, 'review')
    }).pipe(Effect.provide(categoriesTest())),
  )

  it.effect(
    'undoes a decision and refuses categories nobody assigns by hand',
    () =>
      Effect.gen(function* () {
        const { categorizer, entry, inferenceOf } = yield* statement(
          line('a', '20260901', '-19.90', 'Netflix.com'),
        )
        const id = yield* entry('Netflix.com')
        const refused = yield* Effect.flip(categorizer.decide(id, 'transfer'))
        assert.strictEqual(refused.message, 'category_not_assignable: transfer')
        yield* categorizer.decide(id, 'uncategorized')
        assert.deepInclude(yield* inferenceOf(id), {
          categoryId: 'uncategorized',
          status: 'applied',
        })
        yield* categorizer.undo(id)
        assert.strictEqual((yield* inferenceOf(id)).status, 'none')
      }).pipe(Effect.provide(categoriesTest())),
  )

  it.effect(
    'suggests Pluggy’s category for review until the person maps it',
    () =>
      Effect.gen(function* () {
        const { openFinance } = yield* connect({
          accounts: [bank],
          transactions: {
            'provider-bank': [
              tx('market', '2026-10-01', {
                description: 'SUPERMERCADO BOM PRECO',
                category: 'Groceries',
                categoryId: '10000000',
              }),
              tx('shop', '2026-10-02', {
                description: 'LOJA QUALQUER',
                category: 'Shopping',
                categoryId: '08000000',
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
        const categorizer = yield* Categorizer
        const entries = yield* Entries
        const idOf = (description: string) =>
          Effect.map(
            entries.entries(account.id),
            (all) => all.find((entry) => entry.description === description)!.id,
          )
        const market = yield* idOf('SUPERMERCADO BOM PRECO')
        assert.deepInclude(yield* categorizer.explain(market), {
          categoryId: 'groceries',
          origin: 'provider',
          status: 'review',
          confidence: 60,
        })
        assert.strictEqual(
          (yield* categorizer.explain(yield* idOf('LOJA QUALQUER'))).status,
          'none',
        )

        yield* (yield* KnowledgeStore).setProviderMapping(
          'pluggy',
          '10000000',
          'groceries',
        )
        yield* drain
        assert.deepInclude(yield* categorizer.explain(market), {
          categoryId: 'groceries',
          origin: 'provider',
          status: 'applied',
          confidence: 90,
        })
      }).pipe(Effect.provide(categoriesTest())),
  )
})

// Donald's bank accounts and card, each with a statement imported.
const ownAccounts = (files: {
  readonly nubank: string
  readonly inter?: string
  readonly card?: string
}) =>
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
    for (const [account, lines, tag] of [
      [nubank, files.nubank, 'STMTRS'],
      [inter, files.inter ?? '', 'STMTRS'],
      [card, files.card ?? '', 'CCSTMTRS'],
    ] as const) {
      if (lines !== '')
        yield* imports.importFile({
          accountId: account.id,
          fileName: `${account.name}.ofx`,
          bytes: ofx(lines, tag),
        })
    }
    yield* drain
    const entries = yield* Entries
    const categorizer = yield* Categorizer
    const entryId = (accountId: string, amountCents: number) =>
      Effect.map(
        entries.entries(accountId),
        (found) => found.find((entry) => entry.amountCents === amountCents)!.id,
      )
    const outcome = (accountId: string, amountCents: number) =>
      Effect.gen(function* () {
        const inference = yield* categorizer.explain(
          yield* entryId(accountId, amountCents),
        )
        return [
          inference.categoryId,
          inference.origin,
          inference.status,
          inference.excludedFromSpending,
        ]
      })
    return { nubank, inter, card, categorizer, entryId, outcome }
  })

describe('Categorizer with reconciliation', () => {
  it.effect(
    'gives confirmed transfers and card payments system categories, out of spending',
    () =>
      Effect.gen(function* () {
        const { nubank, inter, card, categorizer, entryId, outcome } =
          yield* ownAccounts({
            nubank:
              line('n1', '20260910', '-500.00', 'Pix enviado Donald') +
              line('n2', '20260912', '-1500.00', 'Pagamento fatura'),
            inter: line('i1', '20260910', '500.00', 'Pix recebido Donald'),
            card: line('c1', '20260914', '1500.00', 'Pagamento recebido'),
          })
        const transfer = ['transfer', 'reconciliation', 'applied', true]
        const payment = ['card_payment', 'reconciliation', 'applied', true]
        assert.deepStrictEqual(yield* outcome(nubank.id, -50000), transfer)
        assert.deepStrictEqual(yield* outcome(inter.id, 50000), transfer)
        assert.deepStrictEqual(yield* outcome(nubank.id, -150000), payment)
        assert.deepStrictEqual(yield* outcome(card.id, 150000), payment)

        // A decision on a transfer stays stored but does not apply.
        const sent = yield* entryId(nubank.id, -50000)
        yield* categorizer.decide(sent, 'family')
        const explained = yield* categorizer.explain(sent)
        assert.deepInclude(explained, {
          categoryId: 'transfer',
          origin: 'reconciliation',
        })
        assert.include(explained.reasons, 'decision_shadowed')
        assert.deepStrictEqual(
          explained.candidates.map((candidate) => [
            candidate.origin,
            candidate.categoryId,
          ]),
          [['decision', 'family']],
        )
      }).pipe(Effect.provide(categoriesTest())),
  )

  it.effect(
    'lets a person mark a bill payment without its other side, out of spending and unlearned',
    () =>
      Effect.gen(function* () {
        // The bank pays a card the space does not track.
        const { nubank, categorizer, entryId, outcome } = yield* ownAccounts({
          nubank:
            line('n1', '20260912', '-1500.00', 'Pagamento fatura') +
            line('n2', '20260913', '-80.00', 'Pix enviado Maria'),
        })
        yield* categorizer.decide(
          yield* entryId(nubank.id, -150000),
          'card_payment',
        )
        const refused = yield* categorizer
          .decide(yield* entryId(nubank.id, -8000), 'transfer')
          .pipe(Effect.flip)

        assert.deepStrictEqual(yield* outcome(nubank.id, -150000), [
          'card_payment',
          'decision',
          'applied',
          true,
        ])
        assert.deepInclude(refused, { reason: 'category_not_assignable' })
        assert.deepStrictEqual(yield* (yield* KnowledgeStore).list, [])
      }).pipe(Effect.provide(categoriesTest())),
  )

  it.effect('sends a suggested transfer to review without applying it', () =>
    Effect.gen(function* () {
      const { nubank, outcome } = yield* ownAccounts({
        nubank: line('n1', '20260910', '-500.00', 'Pix enviado Donald'),
        inter:
          line('i1', '20260910', '500.00', 'Pix recebido Donald') +
          line('i2', '20260911', '500.00', 'Pix recebido Donald'),
      })
      const review = ['transfer', 'reconciliation', 'review', false]
      assert.deepStrictEqual(yield* outcome(nubank.id, -50000), review)
    }).pipe(Effect.provide(categoriesTest())),
  )

  it.effect(
    'gives a refund its purchase’s category and learns nothing from it',
    () =>
      Effect.gen(function* () {
        const { card, categorizer, entryId, outcome } = yield* ownAccounts({
          nubank: line('n1', '20260901', '-10.00', 'Tarifa'),
          card:
            line('c2', '20260916', '-250.00', 'Amazon Marketplace') +
            line('c3', '20260925', '250.00', 'Estorno Amazon Marketplace'),
        })
        yield* categorizer.decide(yield* entryId(card.id, -25000), 'shopping')
        assert.deepStrictEqual(yield* outcome(card.id, 25000), [
          'shopping',
          'refund',
          'applied',
          false,
        ])
        const store = yield* (yield* KnowledgeStore).list
        assert.deepStrictEqual(
          store.map((row) => [row.pattern, row.direction]),
          [['amazon marketplace', 'expense']],
        )
      }).pipe(Effect.provide(categoriesTest())),
  )
})

// Reports transactions straight from a source named `ref`, as a feed would.
const report = (
  accountId: string,
  ref: string,
  transactions: ReadonlyArray<
    Pick<
      ReportedTransaction,
      'externalId' | 'bookedOn' | 'amountCents' | 'description' | 'raw'
    >
  >,
) =>
  Effect.gen(function* () {
    const observations = yield* Observations
    const source = yield* observations.registerSource({
      kind: 'open_finance',
      externalRef: ref,
      label: ref,
    })
    yield* observations.recordTransactions({
      sourceId: source.id,
      accountId,
      transactions: transactions.map((transaction) => ({
        ...transaction,
        currency: 'BRL',
        status: 'posted' as const,
      })),
    })
    yield* drain
  })

describe('Categorizer and provider categories', () => {
  it.effect(
    'follows a provider category corrected in a later observation',
    () =>
      Effect.gen(function* () {
        const purchase = (fields: Partial<PluggyTransaction>) =>
          tx('loja', '2026-10-01', {
            description: 'LOJA CENTRAL',
            amount: 80,
            ...fields,
          })
        const { openFinance, connectionId, state } = yield* connect({
          accounts: [bank],
          transactions: {
            'provider-bank': [
              purchase({ category: 'Groceries', categoryId: '10000000' }),
            ],
          },
        })
        const store = yield* KnowledgeStore
        yield* store.setProviderMapping('pluggy', '10000000', 'groceries')
        yield* store.setProviderMapping('pluggy', '08000000', 'shopping')
        const account = yield* openFinance.linkAccount({
          providerAccountId: 'provider-bank',
          target: { kind: 'checking', purpose: 'operating' },
          historyMonths: 3,
        })
        yield* drain
        const categorizer = yield* Categorizer
        const [entry] = yield* (yield* Entries).entries(account.id)
        assert.deepInclude(yield* categorizer.explain(entry!.id), {
          categoryId: 'groceries',
          status: 'applied',
        })

        yield* Ref.update(state, (current) => ({
          ...current,
          transactions: {
            'provider-bank': [
              purchase({ category: 'Shopping', categoryId: '08000000' }),
            ],
          },
        }))
        yield* openFinance.requestSync({ connectionId })
        yield* drain

        assert.deepInclude(yield* categorizer.explain(entry!.id), {
          categoryId: 'shopping',
          origin: 'provider',
          status: 'applied',
        })
      }).pipe(Effect.provide(categoriesTest())),
  )

  it.effect(
    'sends an entry to review when its sources’ provider categories map apart',
    () =>
      Effect.gen(function* () {
        const { account, categorizer } = yield* statement('')
        const store = yield* KnowledgeStore
        yield* store.setProviderMapping('pluggy', '10000000', 'groceries')
        yield* store.setProviderMapping('pluggy', '08000000', 'shopping')
        const purchase = {
          bookedOn: '2026-10-01',
          amountCents: -8000,
          description: 'LOJA CENTRAL',
        }
        yield* report(account.id, 'old-connection', [
          {
            ...purchase,
            externalId: 'old-1',
            raw: { category: 'Groceries', categoryId: '10000000' },
          },
        ])
        yield* report(account.id, 'new-connection', [
          {
            ...purchase,
            externalId: 'new-1',
            raw: { category: 'Shopping', categoryId: '08000000' },
          },
        ])

        const [entry, ...others] = yield* (yield* Entries).entries(account.id)
        assert.deepStrictEqual(others, [])
        assert.deepInclude(entry, { sources: 2 })
        const inference = yield* categorizer.explain(entry!.id)
        assert.deepInclude(inference, { origin: 'provider', status: 'review' })
        assert.include(inference.reasons, 'conflicting_provider_categories')
        assert.sameMembers(
          [
            ...new Set(
              [inference, ...inference.candidates].map(
                (proposal) => proposal.categoryId,
              ),
            ),
          ],
          ['groceries', 'shopping'],
        )
      }).pipe(Effect.provide(categoriesTest())),
  )

  it.effect(
    'previews a new provider mapping with the id it commits under',
    () =>
      Effect.gen(function* () {
        const { account, categorizer } = yield* statement('')
        yield* report(account.id, 'feed', [
          {
            externalId: 'shop',
            bookedOn: '2026-10-01',
            amountCents: -8000,
            description: 'LOJA CENTRAL',
            raw: { category: 'Shopping', categoryId: '08000000' },
          },
        ])
        const edit = {
          _tag: 'SetProviderMapping',
          provider: 'pluggy',
          providerCategory: '08000000',
          categoryId: 'shopping',
        } as const
        const [change] = yield* categorizer.previewStoreEdit(edit)
        yield* (yield* KnowledgeStore).edit(edit)
        yield* drain
        const { categoryId, origin, originRef, status, confidence, reasons } =
          yield* categorizer.explain(change!.entryId)
        assert.deepStrictEqual(
          { categoryId, origin, originRef, status, confidence, reasons },
          {
            categoryId: change!.after.categoryId,
            origin: change!.after.origin,
            originRef: change!.after.originRef,
            status: change!.after.status,
            confidence: change!.after.confidence,
            reasons: change!.after.reasons,
          },
        )
        assert.strictEqual(status, 'applied')
      }).pipe(Effect.provide(categoriesTest())),
  )
})

describe('Categorizer and refunds', () => {
  it.effect(
    'leaves a refund of an uncategorised purchase without a category until the purchase has one',
    () =>
      Effect.gen(function* () {
        const { card, categorizer, entryId, outcome } = yield* ownAccounts({
          nubank: '',
        })
        yield* (yield* KnowledgeStore).setProviderMapping(
          'pluggy',
          '02030000',
          'reimbursements',
        )
        yield* report(card.id, 'feed', [
          {
            externalId: 'order',
            bookedOn: '2026-09-16',
            amountCents: -25000,
            description: 'Amazon Marketplace',
            raw: null,
          },
          {
            externalId: 'credit',
            bookedOn: '2026-09-25',
            amountCents: 25000,
            description: 'Estorno Amazon Marketplace',
            raw: { category: 'Refunds', categoryId: '02030000' },
          },
        ])
        assert.deepStrictEqual(yield* outcome(card.id, 25000), [
          null,
          'refund',
          'none',
          false,
        ])

        yield* categorizer.decide(yield* entryId(card.id, -25000), 'shopping')
        assert.deepStrictEqual(yield* outcome(card.id, 25000), [
          'shopping',
          'refund',
          'applied',
          false,
        ])

        // The person's own category for the credit still wins.
        yield* categorizer.decide(
          yield* entryId(card.id, 25000),
          'reimbursements',
        )
        assert.deepStrictEqual(yield* outcome(card.id, 25000), [
          'reimbursements',
          'decision',
          'applied',
          false,
        ])
      }).pipe(Effect.provide(categoriesTest())),
  )
})

describe('Categorizer startup', () => {
  it.effect('rebuilds every inference left by another policy version', () =>
    Effect.gen(function* () {
      const { categorizer, entry, inferenceOf } = yield* statement(
        line('a', '20260901', '-23.90', 'Uber *Trip 0109') +
          line('b', '20260915', '-31.10', 'Uber *Trip 1509'),
      )
      yield* categorizer.decide(yield* entry('Uber *Trip 0109'), 'transport')
      yield* drain
      // What an older policy left behind.
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE categorization_state SET policy_version = ${POLICY_VERSION - 1}`
      yield* sql`
        UPDATE category_inferences SET policy_version = ${POLICY_VERSION - 1},
          category_id = NULL, origin = 'none', status = 'none'
      `
      const second = yield* entry('Uber *Trip 1509')
      assert.strictEqual((yield* inferenceOf(second)).status, 'none')

      yield* Effect.scoped(Layer.build(startup))
      assert.deepStrictEqual(yield* inferenceOf(second), {
        categoryId: 'transport',
        origin: 'pattern',
        status: 'applied',
        confidence: 98,
      })
      const versions = yield* sql<{ version: number }>`
        SELECT DISTINCT policy_version AS version FROM category_inferences
      `
      assert.deepStrictEqual(versions, [{ version: POLICY_VERSION }])
      assert.isTrue(yield* categorizer.rebuiltThrough(0))
    }).pipe(Effect.provide(categoriesTest())),
  )

  it.effect('leaves inferences of the current policy as they are', () =>
    Effect.gen(function* () {
      const { entry, inferenceOf } = yield* statement(
        line('a', '20260901', '-12.00', 'Padaria Real'),
      )
      const sql = yield* SqlClient.SqlClient
      const id = yield* entry('Padaria Real')
      yield* sql`UPDATE category_inferences SET confidence = 7 WHERE entry_id = ${id}`
      yield* Effect.scoped(Layer.build(startup))
      assert.strictEqual((yield* inferenceOf(id)).confidence, 7)
    }).pipe(Effect.provide(categoriesTest())),
  )
})
