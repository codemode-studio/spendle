import { assert, describe, it } from '@effect/vitest'

import { applyEdit, learn } from './Store.ts'
import type { PatternRow, StoreEdit } from './Store.ts'

let ids = 0
const clock = () => ({ now: '2026-10-04T12:00:00.000Z', newId: `p${++ids}` })

const teach = (
  rows: ReadonlyArray<PatternRow>,
  description: string,
  categoryId: string,
  amountCents = -1000,
) =>
  learn(
    rows,
    { description, amountCents, categoryId, source: 'review' },
    clock(),
  )?.rows ?? rows

const edit = (rows: ReadonlyArray<PatternRow>, change: StoreEdit) => {
  const result = applyEdit(rows, change, clock())
  if (!result.ok) throw new Error(result.reason)
  return result.rows
}

const summary = (rows: ReadonlyArray<PatternRow>) =>
  rows.map((row) => [
    row.pattern,
    row.matchMode,
    row.categoryId,
    row.confirmations,
    row.corrections,
  ])

describe('learn', () => {
  it('confirms a reaffirmed merchant and counts a changed one as a correction', () => {
    let rows = teach([], 'Padaria Real', 'groceries')
    rows = teach(rows, 'PADARIA REAL', 'groceries')
    assert.deepStrictEqual(summary(rows), [
      ['padaria real', 'exact', 'groceries', 2, 0],
    ])
    rows = teach(rows, 'Padaria Real', 'restaurants')
    assert.deepStrictEqual(summary(rows), [
      ['padaria real', 'exact', 'restaurants', 1, 1],
    ])
  })

  it('keeps directions apart and learns nothing from a nameless movement', () => {
    let rows = teach([], 'Joao da Silva', 'family')
    rows = teach(rows, 'Joao da Silva', 'services_income', 5000)
    assert.deepStrictEqual(
      rows.map((row) => [row.direction, row.categoryId]),
      [
        ['expense', 'family'],
        ['income', 'services_income'],
      ],
    )
    assert.isNull(
      learn(
        [],
        {
          description: 'PIX 12345678',
          amountCents: -1,
          categoryId: 'family',
          source: 'review',
        },
        clock(),
      ),
    )
  })

  it('reaffirms a covering prefix of the same category and drops the exception', () => {
    let rows = teach([], 'Ifd*Pizzaria Bella', 'delivery')
    rows = edit(rows, { _tag: 'PromoteToPrefix', id: rows[0]!.id })
    assert.deepStrictEqual(summary(rows), [['ifd', 'prefix', 'delivery', 1, 0]])
    // An exception for one restaurant, then the person changes their mind.
    rows = teach(rows, 'Ifd*Sushi Bar', 'restaurants')
    assert.strictEqual(rows.length, 2)
    rows = teach(rows, 'Ifd*Sushi Bar', 'delivery')
    assert.deepStrictEqual(summary(rows), [['ifd', 'prefix', 'delivery', 2, 0]])
  })
})

describe('applyEdit', () => {
  it('absorbs exact patterns of the same category into a new prefix', () => {
    let rows = teach([], 'Ifd*Pizzaria Bella', 'delivery')
    rows = teach(rows, 'Ifd*Sushi Bar', 'delivery')
    rows = teach(rows, 'Ifd*Mercado Sao Jorge', 'groceries')
    rows = edit(rows, { _tag: 'PromoteToPrefix', id: rows[0]!.id })
    assert.deepStrictEqual(summary(rows), [
      ['ifd', 'prefix', 'delivery', 2, 0],
      ['ifd mercado sao jorge', 'exact', 'groceries', 1, 0],
    ])
  })

  it('refuses patterns that are too short, taken or not an aggregator’s', () => {
    let rows = teach([], 'Padaria Real', 'groceries')
    rows = teach(rows, 'Mercado Bom', 'groceries')
    const reason = (change: StoreEdit) => {
      const result = applyEdit(rows, change, clock())
      return result.ok ? 'ok' : result.reason
    }
    assert.strictEqual(
      reason({
        _tag: 'EditPattern',
        id: rows[0]!.id,
        pattern: 'pa',
        matchMode: 'exact',
      }),
      'invalid_pattern',
    )
    assert.strictEqual(
      reason({
        _tag: 'EditPattern',
        id: rows[0]!.id,
        pattern: ' Mercado  BOM ',
        matchMode: 'exact',
      }),
      'pattern_taken',
    )
    assert.strictEqual(
      reason({ _tag: 'PromoteToPrefix', id: rows[0]!.id }),
      'no_prefix_candidate',
    )
    assert.strictEqual(
      reason({ _tag: 'Remove', id: 'missing' }),
      'pattern_not_found',
    )
  })

  it('maps a provider category once for both directions', () => {
    let rows = edit([], {
      _tag: 'SetProviderMapping',
      provider: 'pluggy',
      providerCategory: '11010000',
      categoryId: 'restaurants',
    })
    rows = edit(rows, {
      _tag: 'SetProviderMapping',
      provider: 'pluggy',
      providerCategory: '11010000',
      categoryId: 'delivery',
    })
    assert.deepStrictEqual(
      rows.map((row) => [
        row.kind,
        row.pattern,
        row.direction,
        row.categoryId,
        row.corrections,
      ]),
      [['provider_category', 'pluggy:11010000', 'any', 'delivery', 1]],
    )
    assert.strictEqual(
      applyEdit(rows, { _tag: 'PromoteToPrefix', id: rows[0]!.id }, clock()).ok,
      false,
    )
  })
})
