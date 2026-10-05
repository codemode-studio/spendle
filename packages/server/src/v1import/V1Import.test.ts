import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/sql/SqlClient'

import { Categories } from '../categories/Categories.ts'
import { Categorizer } from '../categories/Categorizer.ts'
import { KnowledgeStore } from '../categories/KnowledgeStore.ts'
import { EventLog } from '../events/EventLog.ts'
import { Imports } from '../imports/Imports.ts'
import { Accounts } from '../ledger/Accounts.ts'
import { Investments } from '../investments/Investments.ts'
import { Entries } from '../ledger/Entries.ts'
import { Notes } from '../ledger/Notes.ts'
import { Reconciliation } from '../reconciliation/Reconciliation.ts'
import { categoriesTest, drain } from '../testing/FakePluggy.ts'
import { makeV1Database } from '../testing/V1Fixture.ts'
import {
  checkingStatement,
  savingsStatement,
  seedV1,
} from '../testing/V1Scenario.ts'
import { readV1 } from './V1Database.ts'
import { reactor, V1Import } from './V1Import.ts'

const MigrationTest = reactor.pipe(
  Layer.provideMerge(V1Import.layer),
  Layer.provideMerge(categoriesTest()),
  Layer.provideMerge(NodeServices.layer),
)

const v1Database = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* fs.makeTempDirectoryScoped()
  return yield* makeV1Database(dir, seedV1)
})

const migrate = (path: string) =>
  Effect.gen(function* () {
    return yield* (yield* V1Import).run(yield* readV1(path))
  })

const accountId = (name: string) =>
  Effect.gen(function* () {
    const all = yield* (yield* Accounts).list
    return all.find((account) => account.name === name)!.id
  })

const importStatements = Effect.gen(function* () {
  const imports = yield* Imports
  yield* imports.importFile({
    accountId: yield* accountId('Conta Nubank'),
    fileName: 'nubank.ofx',
    bytes: checkingStatement,
  })
  yield* imports.importFile({
    accountId: yield* accountId('Reserva'),
    fileName: 'reserva.ofx',
    bytes: savingsStatement,
  })
  yield* drain
})

const entryId = (account: string, description: string) =>
  Effect.gen(function* () {
    const entries = yield* (yield* Entries).entries(yield* accountId(account))
    return entries.find((entry) => entry.description === description)!.id
  })

const inference = (account: string, description: string) =>
  Effect.gen(function* () {
    const found = yield* (yield* Categorizer).explain(
      yield* entryId(account, description),
    )
    return [found.categoryId, found.origin]
  })

describe('V1Import', () => {
  it.effect('moves owners, accounts and cards with their terms', () =>
    Effect.gen(function* () {
      const summary = yield* migrate(yield* v1Database)
      const accounts = yield* Accounts

      const owners = yield* accounts.listOwners
      assert.deepStrictEqual(
        owners.map((owner) => [owner.name, owner.kind]),
        [
          ['Empresa', 'company'],
          ['Família', 'household'],
        ],
      )
      const all = yield* accounts.list
      assert.deepStrictEqual(
        all.map((account) => [
          account.name,
          account.institutionName,
          account.kind,
          account.purpose,
          account.archived,
        ]),
        [
          ['Conta Nubank', 'Nubank', 'checking', 'operating', false],
          ['Conta PJ antiga', 'Nubank', 'checking', 'operating', true],
          ['Corretora', 'Sem instituição', 'investment', 'investment', false],
          ['Reserva', 'Sem instituição', 'savings', 'reserve', false],
          ['Ultravioleta', 'Nubank', 'credit_card', 'operating', false],
        ],
      )
      const card = all.find((account) => account.name === 'Ultravioleta')!
      assert.deepStrictEqual(
        { ...card.card },
        { closingDay: 3, dueDay: 10, limitCents: 500_000, lastFour: '1889' },
      )
      assert.deepStrictEqual(summary.cards, {
        migrated: 1,
        already: 0,
        skipped: 1,
      })
      assert.deepStrictEqual(
        summary.unmapped
          .filter((item) => item.kind === 'card')
          .map((item) => item.v1Id),
        ['no-due-day'],
      )
    }).pipe(Effect.scoped, Effect.provide(MigrationTest)),
  )

  it.effect('keeps V1 category ids, names, colours, parents and state', () =>
    Effect.gen(function* () {
      yield* migrate(yield* v1Database)
      const categories = yield* Categories
      const pick = (id: string) =>
        Effect.map(categories.get(id), (found) => [
          found.name,
          found.bucket,
          found.color,
          found.icon,
          found.parentId,
          found.active,
        ])

      assert.deepStrictEqual(yield* pick('groceries'), [
        'Supermercado',
        'essential',
        '#111111',
        null,
        null,
        true,
      ])
      assert.deepStrictEqual(yield* pick('vet'), [
        'Veterinário',
        'lifestyle',
        '#a16207',
        'paw',
        'pets',
        true,
      ])
      assert.deepStrictEqual((yield* pick('old')).at(-1), false)
      // Reconciliation's own category stays as V2 defines it.
      assert.deepStrictEqual(yield* pick('transfer'), [
        'Transferência interna',
        'excluded',
        '#64748b',
        null,
        null,
        true,
      ])
    }).pipe(Effect.scoped, Effect.provide(MigrationTest)),
  )

  it.effect('brings the knowledge base over as the person taught it', () =>
    Effect.gen(function* () {
      const summary = yield* migrate(yield* v1Database)
      const rows = yield* (yield* KnowledgeStore).rows

      assert.deepStrictEqual(
        rows
          .map((row) => [
            row.id,
            row.pattern,
            row.matchMode,
            row.direction,
            row.categoryId,
            row.source,
            row.confirmations,
            row.corrections,
          ])
          .sort(),
        [
          ['kb-ifd', 'ifd', 'prefix', 'expense', 'delivery', 'v1_import', 1, 0],
          [
            'kb-padaria',
            'padaria do joao',
            'exact',
            'expense',
            'groceries',
            'v1_import',
            3,
            1,
          ],
        ],
      )
      assert.strictEqual(
        rows.find((row) => row.id === 'kb-padaria')!.lastLearnedAt,
        '2026-08-29T10:40:00.000Z',
      )
      assert.deepStrictEqual(summary.knowledge, {
        migrated: 2,
        already: 0,
        skipped: 1,
      })
      assert.deepStrictEqual(
        summary.notMigrated.map((item) => [item.what, item.count]),
        // Recurrences move with the planning import; typed-in transactions
        // are recorded again as manual facts.
        [],
      )
    }).pipe(Effect.scoped, Effect.provide(MigrationTest)),
  )

  it.effect('applies decisions once V2 observes their movements', () =>
    Effect.gen(function* () {
      const summary = yield* migrate(yield* v1Database)
      assert.deepStrictEqual(summary.categoryDecisions, {
        migrated: 3,
        already: 0,
        skipped: 0,
      })
      assert.deepStrictEqual(summary.relationDecisions, {
        migrated: 1,
        already: 0,
        skipped: 0,
      })
      assert.strictEqual(summary.coveredByKnowledge, 1)
      // The typed-in transaction is recorded again at once, so its category applies.
      assert.deepStrictEqual(summary.pending.categories, {
        applied: 1,
        pending: 2,
        superseded: 0,
        refused: 0,
      })
      assert.deepStrictEqual(yield* inference('Conta Nubank', 'CONSULTA'), [
        'health',
        'decision',
      ])
      assert.deepStrictEqual(
        summary.unmapped
          .filter((item) => item.kind === 'statement_payment')
          .map((item) => item.v1Id),
        ['bill-link'],
      )

      yield* importStatements

      assert.deepStrictEqual(
        yield* inference('Conta Nubank', 'MERCADO CENTRAL'),
        ['groceries', 'decision'],
      )
      assert.deepStrictEqual(yield* inference('Conta Nubank', 'LOJA X'), [
        'shopping',
        'decision',
      ])
      assert.deepStrictEqual(
        yield* inference('Conta Nubank', 'PADARIA DO JOAO'),
        ['groceries', 'pattern'],
      )
      assert.deepStrictEqual(yield* inference('Conta Nubank', 'CAFE'), [
        null,
        'none',
      ])
      const sent = yield* entryId('Conta Nubank', 'TED ENVIADA RESERVA')
      const received = yield* entryId('Reserva', 'TED RECEBIDA CONTA')
      const relation = (yield* (yield* Reconciliation).relations).find(
        (found) => found.outflowEntryId === sent,
      )!
      assert.deepStrictEqual(
        [
          relation.inflowEntryId,
          relation.kind,
          relation.status,
          relation.origin,
        ],
        [received, 'internal_transfer', 'confirmed', 'person'],
      )
      // Imported decisions teach nothing new: the patterns came over already.
      assert.strictEqual((yield* (yield* KnowledgeStore).rows).length, 2)
    }).pipe(Effect.scoped, Effect.provide(MigrationTest)),
  )

  it.effect(
    'records typed-in transactions, informed balances, notes and positions again',
    () =>
      Effect.gen(function* () {
        const summary = yield* migrate(yield* v1Database)
        const checking = yield* accountId('Conta Nubank')
        const brokerage = yield* accountId('Corretora')
        const typed = (yield* (yield* Entries).entries(checking)).map(
          (entry) => [entry.bookedOn, entry.amountCents, entry.description],
        )
        const proof = yield* (yield* Entries).balanceProof(checking)
        const before = yield* (yield* Investments).snapshot('2026-10-04')
        yield* importStatements
        const review = yield* entryId('Conta Nubank', 'MERCADO CENTRAL')
        const consulta = yield* entryId('Conta Nubank', 'CONSULTA')
        const notes = yield* Notes
        const after = yield* (yield* Investments).snapshot('2026-10-04')
        assert.deepStrictEqual(
          {
            tallies: [
              summary.manualTransactions,
              summary.checkpoints,
              summary.positions,
              summary.notes,
              summary.investmentMovements,
            ].map((tally) => [tally.migrated, tally.skipped]),
            unmapped: summary.unmapped
              .filter((item) => item.kind === 'checkpoint')
              .map((item) => item.v1Id),
            typed,
            checkpoints: proof.supported
              ? proof.checkpoints.map((checkpoint) => [
                  checkpoint.asOf,
                  checkpoint.balanceCents,
                  checkpoint.sourceKind,
                ])
              : null,
            // The imported transaction's note waits for its statement.
            notesBefore: summary.pending.notes,
            notes: [yield* notes.of(review), yield* notes.of(consulta)],
            position: before.positions.map((position) => [
              position.accountId === brokerage,
              position.name,
              position.reserve,
              position.openingCents,
              position.contributedCents,
              position.currentCents,
              position.valuedOn,
              position.movements.map((movement) => movement.description),
            ]),
            reserve: after.summary.reserveBrlCents,
          },
          {
            tallies: [
              [2, 0],
              [1, 1],
              [1, 0],
              [2, 0],
              [1, 0],
            ],
            unmapped: ['card-informed'],
            typed: [['2026-09-15', -3000, 'CONSULTA']],
            checkpoints: [['2026-09-30', 120_000, 'manual']],
            notesBefore: { applied: 1, pending: 1, superseded: 0, refused: 0 },
            notes: ['Compra do mês', 'Dra. Ana'],
            position: [
              [
                true,
                'Tesouro Selic 2029',
                true,
                10_000,
                60_000,
                65_000,
                '2026-09-30',
                ['APORTE TESOURO'],
              ],
            ],
            reserve: 65_000,
          },
        )
      }).pipe(Effect.scoped, Effect.provide(MigrationTest)),
  )

  it.effect('keeps a decision the person already made in V2', () =>
    Effect.gen(function* () {
      const path = yield* v1Database
      // Accounts first, so the statements have somewhere to go.
      yield* migrate(path)
      yield* (yield* SqlClient.SqlClient)`DELETE FROM v1_import_category_decisions`
      yield* importStatements
      yield* (yield* Categorizer).decide(
        yield* entryId('Conta Nubank', 'LOJA X'),
        'leisure',
      )

      const summary = yield* migrate(path)

      // LOJA X, and the typed-in CONSULTA, decided by the first run.
      assert.deepStrictEqual(summary.pending.categories, {
        applied: 1,
        pending: 0,
        superseded: 2,
        refused: 0,
      })
      assert.deepStrictEqual(yield* inference('Conta Nubank', 'LOJA X'), [
        'leisure',
        'decision',
      ])
    }).pipe(Effect.scoped, Effect.provide(MigrationTest)),
  )

  it.effect('changes nothing when run again', () =>
    Effect.gen(function* () {
      const path = yield* v1Database
      yield* migrate(path)
      yield* importStatements
      const log = yield* EventLog
      const sql = yield* SqlClient.SqlClient
      const counts = sql<{ n: number }>`
        SELECT (SELECT count(*) FROM owners) + (SELECT count(*) FROM accounts)
          + (SELECT count(*) FROM categories) + (SELECT count(*) FROM category_patterns)
          + (SELECT count(*) FROM category_decisions) + (SELECT count(*) FROM relation_decisions)
          + (SELECT count(*) FROM v1_import_map) + (SELECT count(*) FROM v1_import_ledger_map)
          + (SELECT count(*) FROM transaction_observations)
          + (SELECT count(*) FROM balance_observations) + (SELECT count(*) FROM entry_notes)
          + (SELECT count(*) FROM investment_positions)
          + (SELECT count(*) FROM investment_movement_decisions)
          + (SELECT count(*) FROM investment_valuations) AS n
      `
      const before = [yield* log.latestSequence, (yield* counts)[0]!.n]

      const again = yield* migrate(path)
      yield* drain

      assert.deepStrictEqual(
        [yield* log.latestSequence, (yield* counts)[0]!.n],
        before,
      )
      assert.deepStrictEqual(
        [
          again.owners,
          again.accounts,
          again.cards,
          again.categories,
          again.knowledge,
          again.categoryDecisions,
          again.relationDecisions,
          again.manualTransactions,
          again.checkpoints,
          again.positions,
          again.notes,
          again.investmentMovements,
        ].map((tally) => tally.migrated),
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      )
      assert.deepStrictEqual(again.pending.categories.applied, 3)
      assert.deepStrictEqual(again.pending.notes.applied, 2)
      assert.deepStrictEqual(again.pending.investmentMovements.applied, 1)
      assert.deepStrictEqual(again.pending.relations.applied, 1)
    }).pipe(Effect.scoped, Effect.provide(MigrationTest)),
  )
})
