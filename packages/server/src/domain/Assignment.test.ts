import { assert, describe, it } from '@effect/vitest'

import { assign, assignment, problemShapes } from './Assignment.ts'
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

  it('leaves out the row whose pairing costs most when not every row can pair', () => {
    // Rows 0 and 1 both want only column 0; row 1 pairs more cheaply.
    const edges: Array<Edge> = [
      { row: 0, column: 0, cost: 10 },
      { row: 1, column: 0, cost: 1 },
      { row: 2, column: 1, cost: 1 },
      { row: 2, column: 2, cost: 2 },
    ]
    assert.deepStrictEqual(pairs(assign(edges)), [
      [1, 0],
      [2, 1],
    ])
  })

  it('solves a long chain of overlapping candidates with sparse work', () => {
    // 4,000 rows, each allowed the columns within three of it: one component.
    const size = 4000
    const edges: Array<Edge> = []
    for (let row = 0; row < size; row++)
      for (let column = row - 3; column <= row + 3; column++)
        if (column >= 0 && column < size)
          edges.push({ row, column, cost: Math.abs(row - column) })
    assert.deepStrictEqual(problemShapes(edges), [[size, size]])
    const { chosen, steps } = assignment(edges)
    assert.strictEqual(chosen.size, size)
    assert.isTrue([...chosen].every(([row, column]) => row === column))
    assert.isAtMost(steps, 4 * edges.length)
  })

  it('hands each edge to its own group once, however many groups there are', () => {
    // 3,000 unrelated movements, each with two candidates of its own.
    const size = 3000
    const edges: Array<Edge> = []
    for (let row = 0; row < size; row++)
      edges.push(
        { row, column: row * 2, cost: 1 },
        { row, column: row * 2 + 1, cost: 2 },
      )
    const { chosen, steps } = assignment(edges)
    assert.strictEqual(chosen.size, size)
    assert.isTrue([...chosen].every(([row, column]) => column === row * 2))
    assert.isAtMost(steps, 8 * edges.length)
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
