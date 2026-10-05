import { assert, describe, it } from '@effect/vitest'

import { categorize } from './Policy.ts'
import type { PolicyEntry, PolicyInput, PolicyRelation } from './Policy.ts'
import type { PatternRow } from './Store.ts'

const categories = [
  { id: 'groceries', bucket: 'essential', active: true, system: false },
  { id: 'restaurants', bucket: 'lifestyle', active: true, system: false },
  { id: 'shopping', bucket: 'lifestyle', active: true, system: false },
  { id: 'transport', bucket: 'essential', active: true, system: false },
  { id: 'reimbursements', bucket: 'income', active: true, system: false },
]

const providerMapping = (code: string, categoryId: string): PatternRow => ({
  id: `mapping-${code}`,
  kind: 'provider_category',
  pattern: `pluggy:${code}`,
  matchMode: 'exact',
  direction: 'any',
  categoryId,
  signature: `pluggy:${code}`,
  sampleDescription: code,
  source: 'provider_mapping',
  confirmations: 1,
  corrections: 0,
  lastLearnedAt: '2026-10-04T12:00:00.000Z',
})

const merchant = (pattern: string, categoryId: string): PatternRow => ({
  ...providerMapping(pattern, categoryId),
  id: `merchant-${pattern}`,
  kind: 'merchant',
  pattern,
  direction: 'expense',
  signature: pattern,
  source: 'transaction_list',
})

const entry = (
  id: string,
  amountCents: number,
  description: string,
  providerCategories: PolicyEntry['providerCategories'] = [],
): PolicyEntry => ({ id, amountCents, description, providerCategories })

const refund = (
  outflowEntryId: string,
  inflowEntryId: string,
): PolicyRelation => ({
  key: 'refund-1',
  kind: 'refund',
  outflowEntryId,
  inflowEntryId,
  status: 'confirmed',
  score: 100,
})

const run = (input: Partial<PolicyInput>) =>
  new Map(
    categorize({
      entries: [],
      relations: [],
      decisions: { byEntry: new Map(), split: new Map(), entriesOf: new Map() },
      store: [],
      categories,
      ...input,
    }).map((inference) => [inference.entryId, inference]),
  )

const outcome = (
  inference:
    { categoryId: string | null; origin: string; status: string } | undefined,
) => inference && [inference.categoryId, inference.origin, inference.status]

describe('categorize: provider categories', () => {
  it('sends an entry to review when its observations map to different categories', () => {
    const inferences = run({
      entries: [
        entry('e', -8000, 'Loja Central', [
          { id: '10000000', name: 'Groceries' },
          { id: '08000000', name: 'Shopping' },
        ]),
      ],
      store: [
        providerMapping('10000000', 'groceries'),
        providerMapping('08000000', 'shopping'),
      ],
    })
    const inference = inferences.get('e')!
    assert.deepStrictEqual(outcome(inference), [
      'groceries',
      'provider',
      'review',
    ])
    assert.include(inference.reasons, 'conflicting_provider_categories')
    assert.isTrue(
      inference.candidates.every((candidate) => candidate.status === 'review'),
    )
  })

  it('sends an entry to review when a mapping and a built-in suggestion from different observations disagree', () => {
    const inference = run({
      entries: [
        entry('e', -8000, 'Loja Central', [
          { id: '08000000', name: 'Shopping' },
          { id: '10000000', name: 'Groceries' },
        ]),
      ],
      store: [providerMapping('08000000', 'shopping')],
    }).get('e')!
    assert.deepStrictEqual(outcome(inference), [
      'shopping',
      'provider',
      'review',
    ])
  })

  it('applies a mapping when every observation agrees', () => {
    const inference = run({
      entries: [
        entry('e', -8000, 'Loja Central', [
          { id: '10000000', name: 'Groceries' },
          { id: null, name: 'Groceries' },
        ]),
      ],
      store: [providerMapping('10000000', 'groceries')],
    }).get('e')!
    assert.deepStrictEqual(outcome(inference), [
      'groceries',
      'provider',
      'applied',
    ])
    assert.notInclude(inference.reasons, 'conflicting_provider_categories')
  })

  it('lets the person’s mapping of an observation override the built-in map for it', () => {
    const inference = run({
      entries: [
        entry('e', -8000, 'Loja Central', [
          { id: '10000000', name: 'Groceries' },
        ]),
      ],
      store: [providerMapping('10000000', 'shopping')],
    }).get('e')!
    assert.deepStrictEqual(outcome(inference), [
      'shopping',
      'provider',
      'applied',
    ])
  })
})

describe('categorize: refunds', () => {
  const purchase = entry('purchase', -25000, 'Amazon Marketplace')
  const credit = entry('credit', 25000, 'Estorno Amazon Marketplace', [
    { id: '02030000', name: 'Refunds' },
  ])
  const store = [providerMapping('02030000', 'reimbursements')]

  it('leaves the credit of an uncategorised purchase without a category', () => {
    const inference = run({
      entries: [purchase, credit],
      relations: [refund('purchase', 'credit')],
      store,
    }).get('credit')!
    assert.deepStrictEqual(outcome(inference), [null, 'refund', 'none'])
    assert.strictEqual(inference.originRef, 'refund-1')
    assert.deepStrictEqual(
      inference.candidates.map((candidate) => candidate.categoryId),
      ['reimbursements'],
    )
  })

  it('gives the credit its purchase’s category', () => {
    const inference = run({
      entries: [purchase, credit],
      relations: [refund('purchase', 'credit')],
      store: [...store, merchant('amazon marketplace', 'shopping')],
    }).get('credit')!
    assert.deepStrictEqual(outcome(inference), [
      'shopping',
      'refund',
      'applied',
    ])
  })

  it('sends a credit refunding purchases of different categories to review', () => {
    const other = entry('other', -10000, 'Amazon Prime')
    const inference = run({
      entries: [purchase, other, credit],
      relations: [
        refund('purchase', 'credit'),
        { ...refund('other', 'credit'), key: 'refund-2' },
      ],
      store: [...store, merchant('amazon marketplace', 'shopping')],
    }).get('credit')!
    assert.deepStrictEqual(outcome(inference), ['shopping', 'refund', 'review'])
    assert.include(inference.reasons, 'conflicting_purchases')
  })

  it('lets the person’s decision on the credit win', () => {
    const inference = run({
      entries: [purchase, credit],
      relations: [refund('purchase', 'credit')],
      store,
      decisions: {
        byEntry: new Map([
          [
            'credit',
            {
              key: 'd1',
              categoryId: 'reimbursements',
              revision: 1,
              superseded: [],
            },
          ],
        ]),
        split: new Map(),
        entriesOf: new Map([['d1', ['credit']]]),
      },
    }).get('credit')!
    assert.deepStrictEqual(outcome(inference), [
      'reimbursements',
      'decision',
      'applied',
    ])
  })
})
