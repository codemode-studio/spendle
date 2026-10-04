/** An allowed pairing of `row` with `column`; pairs without an edge are forbidden. */
export interface Edge {
  readonly row: number
  readonly column: number
  readonly cost: number
}

/** A set of rows and columns linked by edges to each other and to nothing else. */
export interface Component {
  readonly rows: ReadonlyArray<number>
  readonly columns: ReadonlyArray<number>
}

/**
 * Splits the pairing problem into independent parts: rows and columns are in
 * the same component when a chain of edges links them. Rows and columns
 * without edges belong to none. Components and their members are in
 * ascending order of their first row.
 */
export const components = (edges: ReadonlyArray<Edge>): Array<Component> => {
  // Union-find over rows (`r<n>`) and columns (`c<n>`).
  const parent = new Map<string, string>()
  const find = (key: string): string => {
    let root = key
    while (parent.get(root) !== root) root = parent.get(root)!
    let node = key
    while (node !== root) {
      const next = parent.get(node)!
      parent.set(node, root)
      node = next
    }
    return root
  }
  const add = (key: string) => {
    if (!parent.has(key)) parent.set(key, key)
  }
  for (const edge of edges) {
    const row = `r${edge.row}`
    const column = `c${edge.column}`
    add(row)
    add(column)
    const a = find(row)
    const b = find(column)
    if (a !== b) parent.set(b, a)
  }
  const byRoot = new Map<string, { rows: Set<number>; columns: Set<number> }>()
  for (const edge of edges) {
    const root = find(`r${edge.row}`)
    const part = byRoot.get(root) ?? { rows: new Set(), columns: new Set() }
    part.rows.add(edge.row)
    part.columns.add(edge.column)
    byRoot.set(root, part)
  }
  return [...byRoot.values()]
    .map((part) => ({
      rows: [...part.rows].sort((a, b) => a - b),
      columns: [...part.columns].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.rows[0]! - b.rows[0]!)
}

/**
 * The dense problems `assign` solves, as `[smaller, larger]` dimensions: one
 * per component, never padded to a square.
 */
export const problemShapes = (
  edges: ReadonlyArray<Edge>,
): Array<readonly [number, number]> =>
  components(edges).map(({ rows, columns }) => [
    Math.min(rows.length, columns.length),
    Math.max(rows.length, columns.length),
  ])

// A forbidden pair costs more than any set of allowed ones, so the solution
// first maximizes how many rows are paired, then minimizes cost.
const forbidden = 1e9

/**
 * Minimum-cost assignment for `rows <= columns` (Hungarian method,
 * O(rows² · columns)). Returns the column of each row.
 */
const solve = (cost: ReadonlyArray<ReadonlyArray<number>>): Array<number> => {
  const rows = cost.length
  const columns = cost[0]!.length
  const u = new Array<number>(rows + 1).fill(0)
  const v = new Array<number>(columns + 1).fill(0)
  const p = new Array<number>(columns + 1).fill(0)
  const way = new Array<number>(columns + 1).fill(0)
  for (let i = 1; i <= rows; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Array<number>(columns + 1).fill(Infinity)
    const used = new Array<boolean>(columns + 1).fill(false)
    do {
      used[j0] = true
      const i0 = p[j0]!
      let delta = Infinity
      let j1 = 0
      for (let j = 1; j <= columns; j++) {
        if (used[j]) continue
        const current = cost[i0 - 1]![j - 1]! - u[i0]! - v[j]!
        if (current < minv[j]!) {
          minv[j] = current
          way[j] = j0
        }
        if (minv[j]! < delta) {
          delta = minv[j]!
          j1 = j
        }
      }
      for (let j = 0; j <= columns; j++) {
        if (used[j]) {
          u[p[j]!] = u[p[j]!]! + delta
          v[j] = v[j]! - delta
        } else minv[j] = minv[j]! - delta
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0]!
      p[j0] = p[j1]!
      j0 = j1
    } while (j0)
  }
  const result = new Array<number>(rows).fill(-1)
  for (let j = 1; j <= columns; j++) if (p[j]! > 0) result[p[j]! - 1] = j - 1
  return result
}

/**
 * Pairs rows with columns along the given edges, each at most once: as many
 * pairs as possible, then the lowest total cost. Each component is solved on
 * its own, oriented so the dense matrix is only as large as the component.
 * Returns the column chosen for each paired row.
 */
export const assign = (edges: ReadonlyArray<Edge>): Map<number, number> => {
  const costOf = new Map<string, number>()
  for (const edge of edges) {
    const key = `${edge.row}:${edge.column}`
    costOf.set(key, Math.min(costOf.get(key) ?? Infinity, edge.cost))
  }
  const chosen = new Map<number, number>()
  for (const { rows, columns } of components(edges)) {
    const transposed = rows.length > columns.length
    const [short, long] = transposed ? [columns, rows] : [rows, columns]
    const matrix = short.map((a) =>
      long.map(
        (b) => costOf.get(transposed ? `${b}:${a}` : `${a}:${b}`) ?? forbidden,
      ),
    )
    solve(matrix).forEach((index, position) => {
      const a = short[position]!
      const b = long[index]!
      const [row, column] = transposed ? [b, a] : [a, b]
      if (costOf.has(`${row}:${column}`)) chosen.set(row, column)
    })
  }
  return chosen
}
