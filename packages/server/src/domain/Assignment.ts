/** An allowed pairing of `row` with `column`; pairs without an edge are forbidden. */
export interface Edge {
  readonly row: number
  readonly column: number
  readonly cost: number
}

/** A set of rows and columns linked by edges to each other and to nothing else. */
interface Component {
  readonly rows: ReadonlyArray<number>
  readonly columns: ReadonlyArray<number>
}

/**
 * Splits the pairing problem into independent parts: rows and columns are in
 * the same component when a chain of edges links them. Rows and columns
 * without edges belong to none. Components and their members are in
 * ascending order of their first row.
 */
const components = (edges: ReadonlyArray<Edge>): Array<Component> => {
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

// A binary heap of columns by tentative distance, ties by column index so
// equal-cost solutions come out the same every time.
class Frontier {
  private readonly items: Array<{ distance: number; column: number }> = []
  get size() {
    return this.items.length
  }
  private before(a: number, b: number) {
    const x = this.items[a]!
    const y = this.items[b]!
    return (
      x.distance < y.distance ||
      (x.distance === y.distance && x.column < y.column)
    )
  }
  private swap(a: number, b: number) {
    const item = this.items[a]!
    this.items[a] = this.items[b]!
    this.items[b] = item
  }
  push(distance: number, column: number) {
    this.items.push({ distance, column })
    let at = this.items.length - 1
    while (at > 0) {
      const parent = (at - 1) >> 1
      if (!this.before(at, parent)) break
      this.swap(at, parent)
      at = parent
    }
  }
  pop() {
    const top = this.items[0]!
    const last = this.items.pop()!
    if (this.items.length > 0) {
      this.items[0] = last
      let at = 0
      for (;;) {
        const left = at * 2 + 1
        const right = left + 1
        let first = at
        if (left < this.items.length && this.before(left, first)) first = left
        if (right < this.items.length && this.before(right, first))
          first = right
        if (first === at) break
        this.swap(at, first)
        at = first
      }
    }
    return top
  }
}

/**
 * Minimum-cost assignment of one component along its edges, in local
 * indices. Each row also has a private "unpaired" column costing more than
 * any set of real pairs, so every row is always placed: the fewest rows end
 * unpaired, then the real pairs cost least. Rows are placed one at a time
 * by the cheapest augmenting path from that row (Dijkstra on reduced costs
 * with dual potentials), which only visits the part of the graph the new
 * row competes for. Returns the column of each row (-1 when unpaired) and
 * the number of steps taken.
 */
const solve = (
  rowCount: number,
  columnCount: number,
  adjacency: ReadonlyArray<ReadonlyArray<{ column: number; cost: number }>>,
): { columnOf: Int32Array; steps: number } => {
  let lowest = Infinity
  let highest = -Infinity
  for (const list of adjacency)
    for (const { cost } of list) {
      lowest = Math.min(lowest, cost)
      highest = Math.max(highest, cost)
    }
  // Real costs are shifted to start at zero; any set of real pairs costs less than one unpaired row.
  const unpaired = (rowCount + 1) * (highest - lowest + 1)
  const nodes = columnCount + rowCount
  const costOf = (column: number, cost: number) =>
    column >= columnCount ? unpaired : cost - lowest

  // Dual potentials, all zero at first (shifted costs are never negative). A
  // column only moves once it is paired, so free columns always share one
  // potential and the nearest free column by reduced cost is the cheapest.
  const u = new Float64Array(rowCount)
  const v = new Float64Array(nodes)
  const rowOf = new Int32Array(nodes).fill(-1)
  const columnOf = new Int32Array(rowCount).fill(-1)

  const distance = new Float64Array(nodes)
  const via = new Int32Array(nodes)
  // Per-search stamps instead of clearing arrays: `reached` holds a
  // tentative distance, `settled` a final one.
  const reached = new Int32Array(nodes)
  const settled = new Int32Array(nodes)
  let steps = 0

  for (let start = 0; start < rowCount; start++) {
    const stamp = start + 1
    const frontier = new Frontier()
    const order: Array<number> = []
    const relax = (row: number, base: number) => {
      const edges = [
        ...adjacency[row]!,
        { column: columnCount + row, cost: unpaired },
      ]
      for (const { column, cost } of edges) {
        steps++
        if (settled[column] === stamp) continue
        const next = base + costOf(column, cost) - u[row]! - v[column]!
        if (reached[column] !== stamp || next < distance[column]!) {
          reached[column] = stamp
          distance[column] = next
          via[column] = row
          frontier.push(next, column)
        }
      }
    }
    relax(start, 0)
    let end = -1
    while (frontier.size > 0) {
      const { distance: at, column } = frontier.pop()
      steps++
      if (settled[column] === stamp || at !== distance[column]) continue
      settled[column] = stamp
      if (rowOf[column] === -1) {
        end = column
        break
      }
      order.push(column)
      relax(rowOf[column]!, at)
    }
    // The row's own unpaired column is always free, so a path always exists.
    const total = distance[end]!
    u[start] = u[start]! + total
    for (const column of order) {
      const slack = total - distance[column]!
      v[column] = v[column]! - slack
      u[rowOf[column]!] = u[rowOf[column]!]! + slack
    }
    let column = end
    for (;;) {
      const row = via[column]!
      const previous = columnOf[row]!
      columnOf[row] = column
      rowOf[column] = row
      if (row === start) break
      column = previous
    }
  }
  for (let row = 0; row < rowCount; row++)
    if (columnOf[row]! >= columnCount) columnOf[row] = -1
  return { columnOf, steps }
}

/**
 * Pairs rows with columns along the given edges, each at most once: as many
 * pairs as possible, then the lowest total cost; equal-cost ties resolve the
 * same way every time. Each component is solved on its own, from its smaller
 * side, and the work grows with the edges the new pairs compete for, never
 * with rows × columns. Also returns how many steps that took.
 */
export const assignment = (
  edges: ReadonlyArray<Edge>,
): { readonly chosen: Map<number, number>; readonly steps: number } => {
  const costOf = new Map<string, number>()
  for (const edge of edges) {
    const key = `${edge.row}:${edge.column}`
    costOf.set(key, Math.min(costOf.get(key) ?? Infinity, edge.cost))
  }
  const chosen = new Map<number, number>()
  let steps = 0
  const parts = components(edges)
  // Each edge goes to its component's problem once, by its row.
  const partOf = new Map<number, number>()
  parts.forEach(({ rows }, part) => {
    for (const row of rows) partOf.set(row, part)
  })
  const edgesOf = parts.map(
    (): Array<{ row: number; column: number; cost: number }> => [],
  )
  for (const [key, cost] of costOf) {
    steps++
    const [row, column] = key.split(':').map(Number) as [number, number]
    edgesOf[partOf.get(row)!]!.push({ row, column, cost })
  }
  parts.forEach(({ rows, columns }, part) => {
    const transposed = rows.length > columns.length
    const [short, long] = transposed ? [columns, rows] : [rows, columns]
    const position = new Map(long.map((id, index) => [id, index]))
    const adjacency = short.map(
      (): Array<{ column: number; cost: number }> => [],
    )
    const index = new Map(short.map((id, at) => [id, at]))
    for (const { row, column, cost } of edgesOf[part]!) {
      const [a, b] = transposed ? [column, row] : [row, column]
      adjacency[index.get(a)!]!.push({ column: position.get(b)!, cost })
    }
    for (const list of adjacency) list.sort((x, y) => x.column - y.column)
    const solved = solve(short.length, long.length, adjacency)
    steps += solved.steps
    solved.columnOf.forEach((to, at) => {
      if (to === -1) return
      const [row, column] = transposed
        ? [long[to]!, short[at]!]
        : [short[at]!, long[to]!]
      chosen.set(row, column)
    })
  })
  return { chosen, steps }
}

/**
 * Pairs rows with columns along the given edges, each at most once: as many
 * pairs as possible, then the lowest total cost. Returns the column chosen
 * for each paired row.
 */
export const assign = (edges: ReadonlyArray<Edge>): Map<number, number> =>
  assignment(edges).chosen
