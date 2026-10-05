import { assert, describe, it } from '@effect/vitest'

import { planDecisions, recognise } from './Plan.ts'
import type { Movement } from './Plan.ts'
import type { V1Snapshot, V1Transaction } from './V1Database.ts'

const movement = (fields: Partial<Movement> = {}): Movement => ({
  v1TransactionId: 't',
  accountId: 'a',
  bookedOn: '2026-09-10',
  amountCents: -1500,
  descriptionKey: 'padaria',
  description: 'PADARIA',
  uniqueByDescription: true,
  uniqueByAmount: true,
  ...fields,
})

const entry = (id: string, description: string, fields: object = {}) => ({
  id,
  accountId: 'a',
  bookedOn: '2026-09-10',
  amountCents: -1500,
  description,
  ...fields,
})

const transaction = (
  id: string,
  fields: Partial<V1Transaction> = {},
): V1Transaction => ({
  id,
  accountId: 'checking',
  cardId: null,
  categoryId: null,
  sourceKey: `file:${id}`,
  postedAt: '2026-09-10',
  description: id.toUpperCase(),
  amountCents: -1000,
  currency: 'BRL',
  baseAmountCents: null,
  baseCurrency: 'BRL',
  status: 'confirmed',
  ...fields,
})

const snapshot = (fields: Partial<V1Snapshot>): V1Snapshot => ({
  owners: [],
  accounts: [],
  cards: [],
  categories: [],
  knowledge: [],
  transactions: [],
  evidence: [],
  groups: [],
  links: [],
  statementPayments: [],
  uncovered: {
    splits: 0,
    recurrences: 0,
    cardInstruments: 0,
    budgets: 0,
    goals: 0,
    investmentPositions: 0,
    categorizationRules: 0,
  },
  ...fields,
})

const plan = (fields: Partial<V1Snapshot>) =>
  planDecisions({
    snapshot: snapshot(fields),
    targets: new Map([
      ['account:checking', { accountId: 'v2-checking', currency: 'BRL' }],
      ['account:savings', { accountId: 'v2-savings', currency: 'BRL' }],
    ]),
    store: [],
    categories: [
      { id: 'groceries', bucket: 'essential', active: true, system: false },
      { id: 'transfer', bucket: 'excluded', active: true, system: true },
    ],
  })

describe('recognise', () => {
  it('takes the only entry with the same day, amount and description', () => {
    assert.deepStrictEqual(
      recognise(movement(), [entry('x', 'Padaria'), entry('y', 'Mercado')]),
      { _tag: 'Entry', entryId: 'x' },
    )
  })

  it('falls back to day and amount when the source words it differently', () => {
    assert.deepStrictEqual(
      recognise(movement(), [entry('x', 'PAG*PADARIA 123')]),
      {
        _tag: 'Entry',
        entryId: 'x',
      },
    )
    // V1 had another movement that day for the same amount: no guessing.
    assert.deepStrictEqual(
      recognise(movement({ uniqueByAmount: false }), [
        entry('x', 'PAG*PADARIA 123'),
      ]),
      { _tag: 'Ambiguous' },
    )
  })

  it('waits while V2 has two identical candidates or none', () => {
    assert.deepStrictEqual(
      recognise(movement(), [entry('x', 'Padaria'), entry('y', 'Padaria')]),
      { _tag: 'Ambiguous' },
    )
    assert.deepStrictEqual(
      recognise(movement(), [
        entry('x', 'Padaria', { bookedOn: '2026-09-11' }),
      ]),
      { _tag: 'Missing' },
    )
  })
})

describe('planDecisions', () => {
  it('flags movements V1 could not tell apart', () => {
    const result = plan({
      transactions: [
        transaction('a', { categoryId: 'groceries', description: 'PADARIA' }),
        transaction('b', { categoryId: 'groceries', description: 'PADARIA' }),
      ],
      evidence: ['a', 'b'].map((id) => ({
        transactionId: id,
        matchKind: 'created',
        suggestionSource: 'manual',
        suggestedCategoryId: 'groceries',
      })),
    })
    assert.deepStrictEqual(
      [...result.movements.values()].map((found) => [
        found.uniqueByDescription,
        found.uniqueByAmount,
      ]),
      [
        [false, false],
        [false, false],
      ],
    )
  })

  it("leaves V1's own reconciliation verdicts and reconciliation categories to V2", () => {
    const result = plan({
      transactions: [
        transaction('out', { amountCents: -500, categoryId: 'transfer' }),
        transaction('in', { accountId: 'savings', amountCents: 500 }),
      ],
      evidence: [
        {
          transactionId: 'out',
          matchKind: 'created',
          suggestionSource: 'manual',
          suggestedCategoryId: 'transfer',
        },
      ],
      groups: [
        {
          id: 'auto',
          type: 'transfer',
          status: 'confirmed',
          reason: 'Contas vinculadas por uma confirmação manual anterior.',
        },
        { id: 'fx', type: 'fx_transfer', status: 'confirmed', reason: null },
      ],
      links: [
        { groupId: 'auto', transactionId: 'out', previousCategoryId: null },
        { groupId: 'auto', transactionId: 'in', previousCategoryId: null },
      ],
    })
    assert.deepStrictEqual(result.relations, [])
    assert.deepStrictEqual(result.categories, [])
    assert.deepStrictEqual(
      result.unmapped.map((item) => [item.kind, item.v1Id]),
      [
        ['category_decision', 'out'],
        ['relation_decision', 'fx'],
      ],
    )
  })

  it('reports a decision whose account did not move', () => {
    const result = plan({
      transactions: [
        transaction('lost', { accountId: 'gone', categoryId: 'groceries' }),
      ],
      evidence: [
        {
          transactionId: 'lost',
          matchKind: 'created',
          suggestionSource: 'manual',
          suggestedCategoryId: 'groceries',
        },
      ],
    })
    assert.deepStrictEqual(
      result.unmapped.map((item) => [item.kind, item.reason]),
      [['category_decision', 'its account or card was not migrated']],
    )
  })
})
