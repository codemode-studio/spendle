import { assert, describe, it } from '@effect/vitest'

import { policyOutcomes } from './PolicyReplay.ts'
import {
  calibrationError,
  combineOutcomes,
  modelOutcomes,
  recommendThreshold,
  scoreboard,
} from './Scoreboard.ts'
import type { EvalItem, ModelAnswer } from './Scoreboard.ts'

const item = (
  id: string,
  expectedCategoryId: string | null,
  overrides: Partial<EvalItem> = {},
): EvalItem => ({
  id,
  description: id,
  amountCents: -1000,
  expectedCategoryId,
  guessable: true,
  ...overrides,
})

const answers = (
  entries: ReadonlyArray<
    readonly [id: string, categoryId: string | null, probability: number]
  >,
) =>
  new Map<string, ModelAnswer>(
    entries.map(([id, categoryId, probability]) => [
      id,
      { categoryId, probability },
    ]),
  )

describe('Scoreboard', () => {
  it('counts only applied categories as confident, and an applied transfer as a miss', () => {
    const exam = [
      item('a', 'groceries'),
      item('b', 'groceries'),
      item('c', 'health', { guessable: false }),
      item('t', null),
    ]
    const board = scoreboard(
      exam,
      modelOutcomes(
        answers([
          ['a', 'groceries', 0.99],
          ['b', 'groceries', 0.8],
          ['c', 'shopping', 0.98],
          ['t', 'shopping', 0.99],
        ]),
        0.95,
        0.5,
      ),
    )
    assert.deepStrictEqual(board.guessable, {
      items: 2,
      accuracyWhenConfident: 1,
      coverage: 0.5,
      correctAndConfident: 0.5,
      accuracyAnyConfidence: 1,
    })
    assert.strictEqual(board.personalConvention.accuracyWhenConfident, 0)
    assert.deepStrictEqual(board.movementsApplied, { applied: 1, of: 1 })
    assert.deepStrictEqual(
      board.misses.map((miss) => miss.id),
      ['c', 't'],
    )
  })

  it('recommends the lowest threshold from which every higher one meets the target', () => {
    const exam = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => item(id, 'x'))
    const given = answers([
      ['a', 'x', 0.99],
      ['b', 'x', 0.98],
      ['c', 'x', 0.95],
      ['d', 'y', 0.9],
      // A right answer below a wrong one does not make 0.8 safe again.
      ['e', 'x', 0.8],
      ['f', 'x', 0.6],
    ])
    assert.strictEqual(
      recommendThreshold(exam, given, { accuracy: 1, minApplied: 2 }, 0.5)
        ?.threshold,
      0.95,
    )
    // Thresholds resting on too few answers are not offered.
    assert.isNull(
      recommendThreshold(exam, given, { accuracy: 1, minApplied: 4 }, 0.5),
    )
    assert.strictEqual(
      recommendThreshold(exam, given, { accuracy: 0.75, minApplied: 4 }, 0.5)
        ?.threshold,
      0.6,
    )
  })

  it("keeps the policy's applied category over the model's, and lets the model fill the rest", () => {
    const combined = combineOutcomes(
      new Map([
        ['a', { categoryId: 'groceries', applied: true }],
        ['b', { categoryId: null, applied: false }],
        ['c', { categoryId: 'shopping', applied: false }],
      ]),
      new Map([
        ['a', { categoryId: 'health', applied: true }],
        ['b', { categoryId: 'health', applied: true }],
        ['c', { categoryId: null, applied: false }],
      ]),
    )
    assert.deepStrictEqual(Object.fromEntries(combined), {
      a: { categoryId: 'groceries', applied: true },
      b: { categoryId: 'health', applied: true },
      c: { categoryId: 'shopping', applied: false },
    })
  })

  it('replays the policy with the store taught by the context split', () => {
    const outcomes = policyOutcomes(
      [item('Padaria Real', 'groceries'), item('Pix enviado MESMA', null)],
      [
        item('PADARIA REAL', 'groceries'),
        item('Loja Nova', 'shopping'),
        item('Pix enviado MESMA', null),
      ],
      [
        { id: 'groceries', bucket: 'essential', active: true, system: false },
        { id: 'shopping', bucket: 'lifestyle', active: true, system: false },
      ],
    )
    assert.deepStrictEqual(Object.fromEntries(outcomes), {
      'PADARIA REAL': { categoryId: 'groceries', applied: true },
      'Loja Nova': { categoryId: null, applied: false },
      'Pix enviado MESMA': { categoryId: null, applied: false },
    })
  })

  it('measures calibration error as the gap between stated probability and how often answers are right', () => {
    const exam = [
      item('a', 'groceries'),
      item('b', 'groceries'),
      item('c', 'groceries'),
      item('d', 'groceries'),
      item('t', null),
    ]
    // Four answers at 0.9, three right: off by 0.15 each on average. A
    // transfer given a category at 0.6 is off by 0.6.
    const error = calibrationError(
      exam,
      answers([
        ['a', 'groceries', 0.9],
        ['b', 'groceries', 0.9],
        ['c', 'groceries', 0.9],
        ['d', 'health', 0.9],
        ['t', 'groceries', 0.6],
      ]),
    )
    assert.closeTo(error ?? -1, (4 * 0.15 + 0.6) / 5, 1e-9)
  })
})
