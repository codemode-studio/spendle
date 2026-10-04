import { assign } from '../domain/Assignment.ts'
import type { Edge } from '../domain/Assignment.ts'
import { dayNumber, daysBetween } from '../domain/LocalDate.ts'
import { foldDescription } from '../imports/Statement.ts'

/** The period a source states it covers in full, inclusive. */
export interface Coverage {
  readonly start: string
  readonly end: string
}

/**
 * One observed transaction identity (source, account, external id) at its
 * latest version. `anchorId` is the id of its first version and `sequence`
 * the order in which that first version was stored; both never change.
 * `previousEntryId` is the entry this identity belonged to after the last
 * resolution, which lets an entry keep its id when its first observation
 * goes away.
 */
export interface ObservedTransaction {
  readonly anchorId: string
  readonly sequence: number
  readonly sourceId: string
  readonly externalId: string
  readonly bookedOn: string
  readonly amountCents: number
  readonly description: string
  readonly status: 'pending' | 'posted'
  readonly previousEntryId: string | null
  readonly coverage: Coverage | null
  /**
   * The transaction id the file itself gave this line (an OFX FITID),
   * without the occurrence suffix; null for other sources and for lines
   * identified by fingerprint. Ids are unique within the account at its
   * institution, so two files of the account that give a line the same id
   * and amount report the same movement, whatever its description says.
   */
  readonly fileTransactionId: string | null
}

/** A canonical transaction: one real movement of money, with every observation of it. */
export interface ResolvedEntry {
  readonly id: string
  readonly bookedOn: string
  readonly amountCents: number
  readonly description: string
  readonly status: 'pending' | 'posted'
  readonly evidence: ReadonlyArray<ObservedTransaction>
}

/** Banks and aggregators may date the same movement a few days apart; an entry never spans more. */
export const matchWindowDays = 3

// Words every bank uses, which say nothing about who was paid.
const genericWords = new Set([
  'pix',
  'ted',
  'doc',
  'tev',
  'compra',
  'compras',
  'pagamento',
  'pag',
  'pgto',
  'debito',
  'credito',
  'transf',
  'transferencia',
  'enviado',
  'enviada',
  'recebido',
  'recebida',
  'para',
  'com',
  'ltda',
  'cartao',
  'card',
  'visa',
  'master',
  'mastercard',
  'elo',
  'parcela',
  'parc',
  'saque',
  'deposito',
  'tarifa',
  'conta',
  'nacional',
  'internacional',
  'online',
  'pagto',
  'boleto',
])

const words = (description: string) =>
  new Set(
    foldDescription(description)
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 1),
  )

const meaningfulWords = (description: string) =>
  new Set(
    [...words(description)].filter(
      (word) => word.length >= 3 && !genericWords.has(word),
    ),
  )

const overlap = (left: Set<string>, right: Set<string>) => {
  if (left.size === 0 && right.size === 0) return 1
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  return shared / (left.size + right.size - shared)
}

/** Jaccard overlap of description words, 0 to 1. */
export const descriptionSimilarity = (a: string, b: string) =>
  overlap(words(a), words(b))

// Folds each description once per pairing or regrouping.
const wordCache = () => {
  const memo = (split: (description: string) => Set<string>) => {
    const cache = new Map<string, Set<string>>()
    return (description: string) => {
      let found = cache.get(description)
      if (found === undefined) {
        found = split(description)
        cache.set(description, found)
      }
      return found
    }
  }
  const wordsOf = memo(words)
  const named = memo(meaningfulWords)
  return {
    named,
    shares: (a: string, b: string) => {
      const right = named(b)
      return [...named(a)].some((word) => right.has(word))
    },
    similarity: (a: string, b: string) => overlap(wordsOf(a), wordsOf(b)),
  }
}

// A source that states the period it covers lists every movement in it, so
// a movement it covers but does not list on that date is not one it saw.
const covers = (coverage: Coverage | null, date: string) =>
  coverage === null || (coverage.start <= date && date <= coverage.end)

/**
 * Whether two reports may describe one movement: dated within the window,
 * and, when both sources state their coverage, each dated inside the
 * other's.
 */
const compatible = (
  a: Pick<ObservedTransaction, 'bookedOn' | 'coverage'>,
  b: Pick<ObservedTransaction, 'bookedOn' | 'coverage'>,
) =>
  daysBetween(a.bookedOn, b.bookedOn) <= matchWindowDays &&
  (a.coverage === null ||
    b.coverage === null ||
    (covers(a.coverage, b.bookedOn) && covers(b.coverage, a.bookedOn)))

/**
 * Whether two reports from different files carry the same transaction id
 * the files gave them. Amounts are compared by the caller.
 */
const sameFileTransaction = (
  a: Pick<ObservedTransaction, 'sourceId' | 'fileTransactionId'>,
  b: Pick<ObservedTransaction, 'sourceId' | 'fileTransactionId'>,
) =>
  a.fileTransactionId !== null &&
  a.fileTransactionId === b.fileTransactionId &&
  a.sourceId !== b.sourceId

/**
 * Whether two reports carry different transaction ids the files gave them:
 * the institution says they are two movements, so no entry holds both.
 */
const conflicting = (
  a: Pick<ObservedTransaction, 'fileTransactionId'>,
  b: Pick<ObservedTransaction, 'fileTransactionId'>,
) =>
  a.fileTransactionId !== null &&
  b.fileTransactionId !== null &&
  a.fileTransactionId !== b.fileTransactionId

/** Whether every report of `a` may share an entry with every report of `b`. */
const fitTogether = (
  a: ReadonlyArray<ObservedTransaction>,
  b: ReadonlyArray<ObservedTransaction>,
) =>
  a.every((x) =>
    b.every(
      (y) =>
        x.sourceId !== y.sourceId && compatible(x, y) && !conflicting(x, y),
    ),
  )

/**
 * Reports placed together before any matching by dates and descriptions:
 * each file line with the lines of other files of the account that carry the
 * same transaction id (amounts are equal, as the caller groups by amount),
 * one per file and dated within the window of each other; every other
 * report alone. Units come in the order of their first report, which leads
 * them, and are never split, so no pairing made for an earlier source can
 * give one file's line a movement and its twin in another file another.
 */
const identityUnits = (
  ordered: ReadonlyArray<ObservedTransaction>,
): Array<Array<ObservedTransaction>> => {
  const units: Array<Array<ObservedTransaction>> = []
  const byTransaction = new Map<string, Array<Array<ObservedTransaction>>>()
  for (const observation of ordered) {
    const id = observation.fileTransactionId
    if (id === null) {
      units.push([observation])
      continue
    }
    const open = byTransaction.get(id) ?? []
    const unit = open.find((candidate) => fitTogether(candidate, [observation]))
    if (unit !== undefined) {
      unit.push(observation)
      continue
    }
    const started = [observation]
    open.push(started)
    byTransaction.set(id, open)
    units.push(started)
  }
  return units
}

interface Building {
  readonly evidence: Array<ObservedTransaction>
}

// The evidence that speaks for the entry: the first posted report, else the first report.
const representative = (evidence: ReadonlyArray<ObservedTransaction>) =>
  evidence.find((observation) => observation.status === 'posted') ??
  evidence[0]!

// More than any date distance and description difference can add, so a pair
// the files identify always costs less than one they do not.
const identifiedPremium = (matchWindowDays + 1) * 1000

/**
 * The allowed pairs between the units one source leads for an amount and
 * the entries of that amount, with their cost. Entries are looked up by
 * date, so only those within the window of a unit are ever examined, and
 * entries out of every unit's reach never become part of the problem.
 */
export const pairings = (
  incoming: ReadonlyArray<ReadonlyArray<ObservedTransaction>>,
  entries: ReadonlyArray<{
    readonly evidence: ReadonlyArray<ObservedTransaction>
  }>,
): Array<Edge> => {
  // An entry within the window of a report has all its evidence there, its
  // earliest date included.
  const byEarliest = new Map<number, Array<number>>()
  entries.forEach((entry, column) => {
    const earliest = Math.min(
      ...entry.evidence.map((evidence) => dayNumber(evidence.bookedOn)),
    )
    const list = byEarliest.get(earliest) ?? []
    list.push(column)
    byEarliest.set(earliest, list)
  })
  const reachable = incoming.map((unit) => {
    const day = dayNumber(unit[0]!.bookedOn)
    const columns: Array<number> = []
    for (let offset = -matchWindowDays; offset <= matchWindowDays; offset++)
      for (const column of byEarliest.get(day + offset) ?? [])
        if (fitTogether(entries[column]!.evidence, unit)) columns.push(column)
    return columns.sort((a, b) => a - b)
  })
  const { named, shares, similarity: similar } = wordCache()
  const reachedBy = new Map<number, number>()
  for (const columns of reachable)
    for (const column of columns)
      reachedBy.set(column, (reachedBy.get(column) ?? 0) + 1)

  return incoming.flatMap((unit, row) =>
    reachable[row]!.flatMap((column) => {
      const entry = entries[column]!
      const pairs = entry.evidence.flatMap((evidence) =>
        unit.map((observation) => [evidence, observation] as const),
      )
      // The files' own transaction id settles it, whatever the descriptions.
      const identified = pairs.some(([evidence, observation]) =>
        sameFileTransaction(evidence, observation),
      )
      const described =
        identified ||
        pairs.some(([evidence, observation]) =>
          shares(evidence.description, observation.description),
        )
      if (!described) {
        const sameDay = pairs.some(
          ([evidence, observation]) =>
            evidence.bookedOn === observation.bookedOn,
        )
        const alone =
          reachable[row]!.length === 1 && reachedBy.get(column) === 1
        // Both name a counterparty and the names share nothing: two payees.
        const contradicted =
          unit.some((observation) => named(observation.description).size > 0) &&
          entry.evidence.some(
            (evidence) => named(evidence.description).size > 0,
          )
        if (!sameDay || !alone || contradicted) return []
      }
      const distance = Math.min(
        ...pairs.map(([evidence, observation]) =>
          daysBetween(evidence.bookedOn, observation.bookedOn),
        ),
      )
      const similarity = Math.max(
        ...pairs.map(([evidence, observation]) =>
          similar(evidence.description, observation.description),
        ),
      )
      // The same file transaction id first, then close dates, then similar
      // descriptions, then older entries.
      return [
        {
          row,
          column,
          cost:
            (identified ? 0 : identifiedPremium) +
            distance * 1000 +
            Math.round((1 - similarity) * 100) +
            column / 1e6,
        },
      ]
    }),
  )
}

// A regrouping considers at most this many observations at once, so its
// exhaustive search stays small.
const regroupLimit = 12

const bySequence = (a: ObservedTransaction, b: ObservedTransaction) =>
  a.sequence - b.sequence

const mostFromOneSource = (items: ReadonlyArray<ObservedTransaction>) => {
  const count = new Map<string, number>()
  for (const item of items)
    count.set(item.sourceId, (count.get(item.sourceId) ?? 0) + 1)
  return Math.max(0, ...count.values())
}

const firstSequence = (entry: Building) =>
  Math.min(...entry.evidence.map((evidence) => evidence.sequence))

/**
 * The fewest entries `items` fit in, when fewer than `limit`, cheapest
 * first; null when no grouping beats `limit`. Identity units stay whole. A
 * group holds one report per source, pairwise compatible, no two file
 * transaction ids, each unit sharing a meaningful word or a file
 * transaction id with an earlier one (taken in the order they were stored).
 */
const fewestGroups = (
  items: ReadonlyArray<ObservedTransaction>,
  limit: number,
  unitOf: ReadonlyMap<ObservedTransaction, number>,
): Array<Array<ObservedTransaction>> | null => {
  // A source reports a movement once, so its reports need separate entries.
  if (mostFromOneSource(items) >= limit) return null
  const byUnit = new Map<number, Array<ObservedTransaction>>()
  for (const item of [...items].sort(bySequence)) {
    const key = unitOf.get(item)!
    byUnit.set(key, [...(byUnit.get(key) ?? []), item])
  }
  // Map insertion order: units by their first report.
  const units = [...byUnit.values()]
  const { shares, similarity } = wordCache()

  const pairCost = (a: ObservedTransaction, b: ObservedTransaction) =>
    daysBetween(a.bookedOn, b.bookedOn) * 1000 +
    Math.round((1 - similarity(a.description, b.description)) * 100)
  const unitCost = (a: number, b: number) =>
    units[a]!.reduce(
      (sum, x) => units[b]!.reduce((inner, y) => inner + pairCost(x, y), sum),
      0,
    )
  let best = null as { groups: Array<Array<number>>; cost: number } | null
  const groups: Array<Array<number>> = []
  const place = (index: number, cost: number) => {
    const most = best === null ? limit - 1 : best.groups.length
    if (groups.length > most) return
    if (best !== null && groups.length === most && cost >= best.cost) return
    if (index === units.length) {
      best = { groups: groups.map((group) => [...group]), cost }
      return
    }
    const unit = units[index]!
    for (const group of groups) {
      const fits = group.every((other) => fitTogether(units[other]!, unit))
      const described = group.some((other) =>
        units[other]!.some((x) =>
          unit.some(
            (y) =>
              sameFileTransaction(x, y) || shares(x.description, y.description),
          ),
        ),
      )
      if (!fits || !described) continue
      const added = group.reduce(
        (sum, other) => sum + unitCost(other, index),
        0,
      )
      group.push(index)
      place(index + 1, cost + added)
      group.pop()
    }
    if (groups.length < most) {
      groups.push([index])
      place(index + 1, cost)
      groups.pop()
    }
  }
  place(0, 0)
  return best === null
    ? null
    : best.groups.map((group) => group.flatMap((index) => units[index]!))
}

// Two entries may share a movement: some reports of theirs from different
// sources are compatible and carry no conflicting file transaction ids.
const linked = (a: Building, b: Building) =>
  a.evidence.some((x) =>
    b.evidence.some(
      (y) =>
        x.sourceId !== y.sourceId && compatible(x, y) && !conflicting(x, y),
    ),
  )

// For each entry, the other entries with a report within the window of one of
// its own, found by date instead of by scanning every entry.
const nearby = (entries: ReadonlyArray<Building>) => {
  const byDay = new Map<number, Array<Building>>()
  for (const entry of entries)
    for (const day of new Set(
      entry.evidence.map((evidence) => dayNumber(evidence.bookedOn)),
    )) {
      const list = byDay.get(day) ?? []
      list.push(entry)
      byDay.set(day, list)
    }
  return (entry: Building) => {
    const near = new Set<Building>()
    for (const evidence of entry.evidence) {
      const day = dayNumber(evidence.bookedOn)
      for (let offset = -matchWindowDays; offset <= matchWindowDays; offset++)
        for (const other of byDay.get(day + offset) ?? [])
          if (other !== entry) near.add(other)
    }
    return near
  }
}

/**
 * Entries split into the sets that could trade evidence: two entries are in
 * the same set when a chain of linked entries joins them. Sets come in the
 * order of their first entry, members in the order given.
 */
const linkedSets = (
  entries: ReadonlyArray<Building>,
): Array<Array<Building>> => {
  const parent = entries.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root]!
    while (parent[index] !== root) {
      const next = parent[index]!
      parent[index] = root
      index = next
    }
    return root
  }
  const position = new Map(entries.map((entry, index) => [entry, index]))
  const near = nearby(entries)
  entries.forEach((entry, index) => {
    for (const other of near(entry)) {
      const at = position.get(other)!
      if (at < index || find(at) === find(index)) continue
      if (linked(entry, other)) parent[find(at)] = find(index)
    }
  })
  const sets = new Map<number, Array<Building>>()
  entries.forEach((entry, index) => {
    const root = find(index)
    const set = sets.get(root) ?? []
    set.push(entry)
    sets.set(root, set)
  })
  return [...sets.values()]
}

// Pairs the units source by source in `order`, each unit led by the first of
// its sources there, as `resolveEntries` does in order of appearance.
const buildInOrder = (
  units: ReadonlyArray<ReadonlyArray<ObservedTransaction>>,
  order: ReadonlyArray<string>,
): Array<Building> => {
  const position = new Map(order.map((sourceId, index) => [sourceId, index]))
  const batches = order.map((): Array<ReadonlyArray<ObservedTransaction>> => [])
  for (const unit of units)
    batches[
      Math.min(
        ...unit.map((observation) => position.get(observation.sourceId)!),
      )
    ]!.push(unit)
  const built: Array<Building> = []
  for (const incoming of batches) {
    const chosen = assign(pairings(incoming, built))
    const existing = [...built]
    incoming.forEach((unit, row) => {
      const column = chosen.get(row)
      if (column === undefined) built.push({ evidence: [...unit] })
      else existing[column]!.evidence.push(...unit)
    })
  }
  return built
}

// With this many sources or fewer, every order is tried.
const everyOrderUpTo = 4

const permutations = <A>(items: ReadonlyArray<A>): Array<Array<A>> =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, index) =>
        permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(
          (rest) => [item, ...rest],
        ),
      )

/**
 * The source orders a set of entries is rebuilt in, after the order of
 * appearance it was built in: every order for a few sources, else each
 * source leading once, followed by the others from the most reports down.
 */
const sourceOrders = (
  evidence: ReadonlyArray<ObservedTransaction>,
): Array<Array<string>> => {
  const count = new Map<string, number>()
  for (const item of evidence)
    count.set(item.sourceId, (count.get(item.sourceId) ?? 0) + 1)
  // Map insertion order: evidence comes by sequence, so order of appearance.
  const appearance = [...count.keys()]
  if (appearance.length <= everyOrderUpTo)
    return permutations(appearance).slice(1)
  const byCount = [...appearance].sort((a, b) => count.get(b)! - count.get(a)!)
  return byCount.map((lead) => [
    lead,
    ...byCount.filter((sourceId) => sourceId !== lead),
  ])
}

/**
 * For each entry, the entries sharing a meaningful word or a file
 * transaction id with one of its reports, found through an index of those
 * keys and remembered.
 */
const talkers = (entries: ReadonlyArray<Building>) => {
  const { named } = wordCache()
  const keysOf = (entry: Building) =>
    new Set(
      entry.evidence.flatMap((evidence) => [
        ...[...named(evidence.description)].map((word) => `word:${word}`),
        ...(evidence.fileTransactionId === null
          ? []
          : [`file:${evidence.fileTransactionId}`]),
      ]),
    )
  const byKey = new Map<string, Array<Building>>()
  for (const entry of entries)
    for (const key of keysOf(entry)) {
      const list = byKey.get(key) ?? []
      list.push(entry)
      byKey.set(key, list)
    }
  const memo = new Map<Building, Set<Building>>()
  return (entry: Building) => {
    let found = memo.get(entry)
    if (found === undefined) {
      found = new Set<Building>()
      for (const key of keysOf(entry))
        for (const other of byKey.get(key) ?? [])
          if (other !== entry) found.add(other)
      memo.set(entry, found)
    }
    return found
  }
}

// The neighbours after `index` that may complete a triple with `entry` and
// the neighbour at `index`, in order: all of them when those two talk, else
// those that talk to either, found through who they talk to.
const seconds = (
  neighbors: ReadonlyArray<Building>,
  position: ReadonlyMap<Building, number>,
  index: number,
  toEntry: ReadonlySet<Building>,
  toFirst: ReadonlySet<Building>,
) => {
  if (toEntry.has(neighbors[index]!)) return neighbors.slice(index + 1)
  const after = new Set<number>()
  for (const talkers of [toEntry, toFirst])
    for (const other of talkers) {
      const at = position.get(other)
      if (at !== undefined && at > index) after.add(at)
    }
  return [...after].sort((a, b) => a - b).map((at) => neighbors[at]!)
}

/**
 * Revisits each entry with one or two entries it could share a movement with
 * and regroups their evidence when it fits in fewer entries, until nothing
 * changes or `bound` entries remain. Each change removes an entry, so it
 * ends; entries are visited oldest first, so the result is deterministic.
 * A regrouping only succeeds when some two of its entries share a
 * meaningful word or a file transaction id (each new entry's reports are
 * chained by them), so sets without such a pair are skipped untried.
 */
const regroupLocally = (
  built: ReadonlyArray<Building>,
  unitOf: ReadonlyMap<ObservedTransaction, number>,
  bound: number,
): Array<Building> => {
  let current = [...built]
  let changed = true
  while (changed && current.length > bound) {
    changed = false
    current.sort((a, b) => firstSequence(a) - firstSequence(b))
    const near = nearby(current)
    const rank = new Map(current.map((entry, index) => [entry, index]))
    const gone = new Set<Building>()
    const born: Array<Building> = []
    const talking = talkers(current)
    // Replaces `set` with fewer entries when its evidence fits in them.
    const tryRegroup = (set: Array<Building>) => {
      const items = set.flatMap((member) => member.evidence)
      if (items.length > regroupLimit) return false
      const groups = fewestGroups(items, set.length, unitOf)
      if (groups === null) return false
      for (const member of set) gone.add(member)
      born.push(...groups.map((evidence) => ({ evidence })))
      return true
    }
    for (const entry of current) {
      if (current.length - gone.size + born.length <= bound) break
      if (gone.has(entry)) continue
      const neighbors = [...near(entry)]
        .filter((other) => !gone.has(other) && linked(entry, other))
        .sort((a, b) => rank.get(a)! - rank.get(b)!)
      const position = new Map(neighbors.map((other, at) => [other, at]))
      const toEntry = talking(entry)
      search: for (const [index, first] of neighbors.entries()) {
        if (toEntry.has(first) && tryRegroup([entry, first])) {
          changed = true
          break
        }
        for (const second of seconds(
          neighbors,
          position,
          index,
          toEntry,
          talking(first),
        ))
          if (tryRegroup([entry, first, second])) {
            changed = true
            break search
          }
      }
    }
    current = [...current.filter((entry) => !gone.has(entry)), ...born]
  }
  return current
}

/**
 * Pairing source by source can commit early pairs that keep a later source
 * from completing movements. Each set of entries that could trade evidence
 * is checked against its lower bound, the most reports one source has in it
 * (a source reports a movement once). A set above it is rebuilt from its
 * identity units in other source orders, each source paired as a whole with
 * every report already in an entry, and the fewest entries kept (the first
 * order wins a tie, so nothing changes without a gain); then pairs and
 * triples of neighbouring entries are regrouped exhaustively. Every step
 * keeps one report per source per entry, units whole, the window, coverage,
 * description and file transaction id rules, and depends only on the
 * observations, so the result is deterministic.
 */
const regroup = (
  built: ReadonlyArray<Building>,
  unitOf: ReadonlyMap<ObservedTransaction, number>,
): Array<Building> => {
  const evidenceOf = (entries: ReadonlyArray<Building>) =>
    entries.flatMap((entry) => entry.evidence).sort(bySequence)
  // Each set at its bound when the whole is: no set can be above it.
  if (built.length <= mostFromOneSource(evidenceOf(built))) return [...built]
  return linkedSets(built).flatMap((set) => {
    const evidence = evidenceOf(set)
    const bound = mostFromOneSource(evidence)
    if (set.length <= bound) return set
    const byUnit = new Map<number, Array<ObservedTransaction>>()
    for (const item of evidence) {
      const key = unitOf.get(item)!
      byUnit.set(key, [...(byUnit.get(key) ?? []), item])
    }
    // Map insertion order: units by their first report.
    const units = [...byUnit.values()]
    let best: Array<Building> = set
    for (const order of sourceOrders(evidence)) {
      if (best.length <= bound) break
      const candidate = buildInOrder(units, order)
      if (candidate.length < best.length) best = candidate
    }
    return regroupLocally(best, unitOf, bound)
  })
}

/**
 * Groups observations of one account into entries, one per real movement.
 *
 * Amounts are resolved independently. Within an amount, lines from two
 * files of the account that carry the same transaction id the files gave
 * them are first joined into one unit, which is never split; no entry ever
 * holds two different such ids. Each source's units (led by their first
 * report) form one batch, taken in the order the sources first led a unit
 * of that amount; a batch is paired with the entries built so far as a whole:
 * the pairing maximizes how many reports find their movement, then prefers
 * close dates and similar descriptions. When pairs made for an earlier
 * source keep a later one from completing movements, the entries that could
 * trade evidence are rebuilt in other source orders and regrouped into
 * fewer. Reports of other amounts or from unrelated
 * sources cannot change the outcome. A source never reports one movement
 * twice, so identical lines from one source stay separate.
 *
 * A pair needs positive evidence, not just an equal amount nearby: the
 * descriptions share a meaningful word (not "pix", "compra"…), or both are
 * on the same day with no other candidate on either side and no conflicting
 * counterparty. A unit of file lines is the same movement whatever their
 * descriptions, and pairs the files identify come first. An entry's
 * evidence never spans more than `matchWindowDays`,
 * and a source that states its coverage rules out movements it covers but
 * listed on another date. Uncertain pairs stay separate.
 *
 * Ids: an entry keeps the id its evidence had in the previous resolution
 * (the oldest entry wins a contested id); a new entry takes the first anchor
 * of its evidence that no other entry holds or remembers, else an id derived
 * from it. Ids are unique. The result depends only on the stored
 * observations and those previous ids.
 */
export const resolveEntries = (
  observations: ReadonlyArray<ObservedTransaction>,
): ReadonlyArray<ResolvedEntry> => {
  const ordered = [...observations].sort((a, b) => a.sequence - b.sequence)
  const byAmount = new Map<number, Array<ObservedTransaction>>()
  for (const observation of ordered) {
    const group = byAmount.get(observation.amountCents) ?? []
    group.push(observation)
    byAmount.set(observation.amountCents, group)
  }

  const entries: Array<Building> = []
  for (const group of byAmount.values()) {
    const units = identityUnits(group)
    const unitOf = new Map(
      units.flatMap((unit, index) =>
        unit.map((observation) => [observation, index] as const),
      ),
    )
    // Map insertion order: the order each source first led a unit of this amount.
    const bySource = new Map<string, Array<Array<ObservedTransaction>>>()
    for (const unit of units) {
      const batch = bySource.get(unit[0]!.sourceId) ?? []
      batch.push(unit)
      bySource.set(unit[0]!.sourceId, batch)
    }
    const built: Array<Building> = []
    for (const incoming of bySource.values()) {
      const chosen = assign(pairings(incoming, built))
      const existing = [...built]
      incoming.forEach((unit, row) => {
        const column = chosen.get(row)
        if (column === undefined) built.push({ evidence: [...unit] })
        else existing[column]!.evidence.push(...unit)
      })
    }
    entries.push(...regroup(built, unitOf))
  }

  const idOf = assignIds(entries)
  return entries
    .map((entry) => {
      const evidence = [...entry.evidence].sort(
        (a, b) => a.sequence - b.sequence,
      )
      const speaker = representative(evidence)
      return {
        id: idOf.get(entry)!,
        bookedOn: speaker.bookedOn,
        amountCents: speaker.amountCents,
        description: speaker.description,
        status: evidence.some((item) => item.status === 'posted')
          ? ('posted' as const)
          : ('pending' as const),
        evidence,
      }
    })
    .sort(
      (a, b) =>
        a.bookedOn.localeCompare(b.bookedOn) || a.id.localeCompare(b.id),
    )
}

const assignIds = (entries: ReadonlyArray<Building>) => {
  const oldestFirst = entries
    .map((entry) => ({
      entry,
      evidence: [...entry.evidence].sort((a, b) => a.sequence - b.sequence),
    }))
    .sort((a, b) => a.evidence[0]!.sequence - b.evidence[0]!.sequence)
  const remembered = new Set(
    entries.flatMap((entry) =>
      entry.evidence.flatMap((evidence) =>
        evidence.previousEntryId === null ? [] : [evidence.previousEntryId],
      ),
    ),
  )
  const anchors = new Set(
    entries.flatMap((entry) =>
      entry.evidence.map((evidence) => evidence.anchorId),
    ),
  )
  const taken = new Set<string>()
  const idOf = new Map<Building, string>()

  // Previous ids first, so no new entry can take one an older entry keeps.
  for (const { entry, evidence } of oldestFirst) {
    const previous = evidence
      .map((item) => item.previousEntryId)
      .find((id): id is string => id !== null && !taken.has(id))
    if (previous === undefined) continue
    taken.add(previous)
    idOf.set(entry, previous)
  }
  // Then each remaining entry takes an anchor of its own that nobody holds
  // or remembers, else an id derived from its first anchor.
  for (const { entry, evidence } of oldestFirst) {
    if (idOf.has(entry)) continue
    const free = (id: string) => !taken.has(id) && !remembered.has(id)
    let id = evidence.map((item) => item.anchorId).find(free)
    if (id === undefined) {
      const base = evidence[0]!.anchorId
      let n = 1
      while (!free(`${base}~${n}`) || anchors.has(`${base}~${n}`)) n++
      id = `${base}~${n}`
    }
    taken.add(id)
    idOf.set(entry, id)
  }
  return idOf
}

export interface Checkpoint {
  readonly asOf: string
  readonly balanceCents: number
  /** The source that reported it; its own dating of entries decides inclusion. */
  readonly sourceId: string
}

/** The proof for one interval between consecutive checkpoints. */
export interface BalanceInterval {
  readonly from: string
  readonly to: string
  readonly expectedChangeCents: number
  readonly postedChangeCents: number
  /** Expected minus posted. Zero proves the interval; anything else is a gap to explain. */
  readonly differenceCents: number
}

type ProofEntry = Pick<ResolvedEntry, 'bookedOn' | 'amountCents' | 'status'> & {
  readonly evidence: ReadonlyArray<{
    readonly sourceId: string
    readonly bookedOn: string
    readonly status: 'pending' | 'posted'
  }>
}

// Sums of amounts included by each date: amounts sorted by the date they
// become included, with running totals, read by binary search.
class IncludedSums {
  private readonly dates: Array<string> = []
  private readonly totals: Array<number> = []
  private readonly count: () => void
  constructor(
    items: Array<{ readonly date: string; readonly amountCents: number }>,
    count: () => void,
  ) {
    this.count = count
    items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    let total = 0
    for (const item of items) {
      count()
      total += item.amountCents
      this.dates.push(item.date)
      this.totals.push(total)
    }
  }
  /** The total of amounts included on or before `date`. */
  through(date: string) {
    let low = 0
    let high = this.dates.length
    while (low < high) {
      this.count()
      const middle = (low + high) >> 1
      if (this.dates[middle]! <= date) low = middle + 1
      else high = middle
    }
    return low === 0 ? 0 : this.totals[low - 1]!
  }
}

/**
 * `proveBalances`, with the number of steps it took. Each entry is placed
 * once per checkpoint source on the date that source's balances start to
 * hold it, and each checkpoint reads running totals by binary search, so the
 * work grows with (entries + checkpoints) × log, never with their product.
 */
export const balanceProof = (
  entries: ReadonlyArray<ProofEntry>,
  checkpoints: ReadonlyArray<Checkpoint>,
): {
  readonly intervals: ReadonlyArray<BalanceInterval>
  readonly steps: number
} => {
  let steps = 0
  const count = () => {
    steps++
  }
  const ordered = [...checkpoints].sort((a, b) => a.asOf.localeCompare(b.asOf))
  const sources = new Set(ordered.map((checkpoint) => checkpoint.sourceId))
  const posted = entries.filter((entry) => entry.status === 'posted')

  // Without its own report, a source holds an entry from its posted date.
  // Entries a source reported are taken back out of that default and placed
  // by its own report instead: on the date it posted them, or never while it
  // still shows them pending.
  const byDefault = new IncludedSums(
    posted.map((entry) => ({
      date: entry.bookedOn,
      amountCents: entry.amountCents,
    })),
    count,
  )
  const reported = new Map<
    string,
    {
      readonly instead: Array<{ date: string; amountCents: number }>
      readonly own: Array<{ date: string; amountCents: number }>
    }
  >()
  for (const entry of posted) {
    const seen = new Set<string>()
    for (const evidence of entry.evidence) {
      count()
      if (!sources.has(evidence.sourceId) || seen.has(evidence.sourceId))
        continue
      seen.add(evidence.sourceId)
      const booked = entry.evidence.find(
        (other) =>
          other.sourceId === evidence.sourceId && other.status === 'posted',
      )
      const list = reported.get(evidence.sourceId) ?? { instead: [], own: [] }
      list.instead.push({
        date: entry.bookedOn,
        amountCents: entry.amountCents,
      })
      if (booked !== undefined)
        list.own.push({ date: booked.bookedOn, amountCents: entry.amountCents })
      reported.set(evidence.sourceId, list)
    }
  }
  const bySource = new Map(
    [...reported].map(([sourceId, { instead, own }]) => [
      sourceId,
      {
        instead: new IncludedSums(instead, count),
        own: new IncludedSums(own, count),
      },
    ]),
  )
  const included = (checkpoint: Checkpoint) => {
    const sums = bySource.get(checkpoint.sourceId)
    const base = byDefault.through(checkpoint.asOf)
    return sums === undefined
      ? base
      : base -
          sums.instead.through(checkpoint.asOf) +
          sums.own.through(checkpoint.asOf)
  }

  const intervals = ordered.slice(1).map((end, index) => {
    const start = ordered[index]!
    const postedChangeCents = included(end) - included(start)
    const expectedChangeCents = end.balanceCents - start.balanceCents
    return {
      from: start.asOf,
      to: end.asOf,
      expectedChangeCents,
      postedChangeCents,
      differenceCents: expectedChangeCents - postedChangeCents,
    }
  })
  return { intervals, steps }
}

/**
 * Checks `balance(t1) = balance(t0) + posted entries in (t0, t1]` for each
 * pair of consecutive checkpoints. A checkpoint is the balance at the end of
 * its day, as its source dates things: an entry is on a checkpoint's side by
 * the date that source posted it, so a credit a statement books on the 30th
 * counts in that statement's close even if another source says the 1st. A
 * source that reports the entry only as pending has not booked it, so its
 * balances leave it out; a source with no report of the entry is judged by
 * the entry's posted date. Each interval counts what is included at its
 * end and not at its start (and takes back the reverse), so consecutive
 * intervals add up to the change between their outer checkpoints. Pending
 * entries never count.
 */
export const proveBalances = (
  entries: ReadonlyArray<ProofEntry>,
  checkpoints: ReadonlyArray<Checkpoint>,
): ReadonlyArray<BalanceInterval> =>
  balanceProof(entries, checkpoints).intervals
