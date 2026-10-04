import { assert, describe, it } from '@effect/vitest'

import { assign, problemShapes } from './Assignment.ts'
import type { Edge } from './Assignment.ts'

const pairs = (chosen: Map<number, number>) =>
  [...chosen].sort(([a], [b]) => a - b)

describe('assign', () => {
  it('pairs as many rows as possible before minimizing cost', () => {
    // Row 0 alone would take column 0, stranding row 1.
    const edges: Array<Edge> = [
      { row: 0, column: 0, cost: 1 },
      { row: 0, column: 1, cost: 50 },
      { row: 1, column: 0, cost: 2 },
    ]
    assert.deepStrictEqual(pairs(assign(edges)), [
      [0, 1],
      [1, 0],
    ])
  })

  it('solves rectangular problems in either orientation', () => {
    const wide: Array<Edge> = [0, 1, 2].map((column) => ({
      row: 0,
      column,
      cost: 3 - column,
    }))
    assert.deepStrictEqual(pairs(assign(wide)), [[0, 2]])

    const tall: Array<Edge> = [0, 1, 2].map((row) => ({
      row,
      column: 0,
      cost: row + 1,
    }))
    assert.deepStrictEqual(pairs(assign(tall)), [[0, 0]])
  })

  it('solves one report against a long history without a square matrix', () => {
    const history: Array<Edge> = Array.from({ length: 2000 }, (_, column) => ({
      row: 0,
      column,
      cost: Math.abs(column - 1234),
    }))
    assert.deepStrictEqual(problemShapes(history), [[1, 2000]])
    assert.deepStrictEqual(pairs(assign(history)), [[0, 1234]])
    const transposed = history.map(({ row, column, cost }) => ({
      row: column,
      column: row,
      cost,
    }))
    assert.deepStrictEqual(problemShapes(transposed), [[1, 2000]])
    assert.deepStrictEqual(pairs(assign(transposed)), [[1234, 0]])
  })

  it('solves unconnected groups separately', () => {
    const edges: Array<Edge> = [
      { row: 0, column: 0, cost: 1 },
      { row: 1, column: 0, cost: 1 },
      { row: 2, column: 5, cost: 1 },
      { row: 2, column: 6, cost: 2 },
    ]
    assert.deepStrictEqual(problemShapes(edges), [
      [1, 2],
      [1, 2],
    ])
    assert.deepStrictEqual(pairs(assign(edges)), [
      [0, 0],
      [2, 5],
    ])
  })
})
