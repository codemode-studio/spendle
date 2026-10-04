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
const compatible = (a: ObservedTransaction, b: ObservedTransaction) =>
  daysBetween(a.bookedOn, b.bookedOn) <= matchWindowDays &&
  (a.coverage === null ||
    b.coverage === null ||
    (covers(a.coverage, b.bookedOn) && covers(b.coverage, a.bookedOn)))

interface Building {
  readonly evidence: Array<ObservedTransaction>
}

// The evidence that speaks for the entry: the first posted report, else the first report.
const representative = (evidence: ReadonlyArray<ObservedTransaction>) =>
  evidence.find((observation) => observation.status === 'posted') ??
  evidence[0]!

/**
 * The allowed pairs between one source's reports of an amount and the
 * entries of that amount, with their cost. Entries are looked up by date,
 * so only those within the window of a report are ever examined, and
 * entries out of every report's reach never become part of the problem.
 */
export const pairings = (
  incoming: ReadonlyArray<ObservedTransaction>,
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
  const reachable = incoming.map((observation) => {
    const day = dayNumber(observation.bookedOn)
    const columns: Array<number> = []
    for (let offset = -matchWindowDays; offset <= matchWindowDays; offset++)
      for (const column of byEarliest.get(day + offset) ?? [])
        if (
          entries[column]!.evidence.every((evidence) =>
            compatible(evidence, observation),
          )
        )
          columns.push(column)
    return columns.sort((a, b) => a - b)
  })
  const { named, shares, similarity: similar } = wordCache()
  const reachedBy = new Map<number, number>()
  for (const columns of reachable)
    for (const column of columns)
      reachedBy.set(column, (reachedBy.get(column) ?? 0) + 1)

  return incoming.flatMap((observation, row) =>
    reachable[row]!.flatMap((column) => {
      const entry = entries[column]!
      const described = entry.evidence.some((evidence) =>
        shares(evidence.description, observation.description),
      )
      if (!described) {
        const sameDay = entry.evidence.some(
          (evidence) => evidence.bookedOn === observation.bookedOn,
        )
        const alone =
          reachable[row]!.length === 1 && reachedBy.get(column) === 1
        // Both name a counterparty and the names share nothing: two payees.
        const contradicted =
          named(observation.description).size > 0 &&
          entry.evidence.some(
            (evidence) => named(evidence.description).size > 0,
          )
        if (!sameDay || !alone || contradicted) return []
      }
      const distance = Math.min(
        ...entry.evidence.map((evidence) =>
          daysBetween(evidence.bookedOn, observation.bookedOn),
        ),
      )
      const similarity = Math.max(
        ...entry.evidence.map((evidence) =>
          similar(evidence.description, observation.description),
        ),
      )
      // Close dates first, then similar descriptions, then older entries.
      return [
        {
          row,
          column,
          cost:
            distance * 1000 + Math.round((1 - similarity) * 100) + column / 1e6,
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
 * first; null when no grouping beats `limit`. A group holds one report per
 * source, pairwise compatible, each report sharing a meaningful word with
 * an earlier one (taken in the order they were stored).
 */
const fewestGroups = (
  items: ReadonlyArray<ObservedTransaction>,
  limit: number,
): Array<Array<ObservedTransaction>> | null => {
  // A source reports a movement once, so its reports need separate entries.
  if (mostFromOneSource(items) >= limit) return null
  const sorted = [...items].sort(bySequence)
  const { shares, similarity } = wordCache()

  const pairCost = (a: number, b: number) =>
    daysBetween(sorted[a]!.bookedOn, sorted[b]!.bookedOn) * 1000 +
    Math.round(
      (1 - similarity(sorted[a]!.description, sorted[b]!.description)) * 100,
    )
  let best = null as { groups: Array<Array<number>>; cost: number } | null
  const groups: Array<Array<number>> = []
  const place = (index: number, cost: number) => {
    const most = best === null ? limit - 1 : best.groups.length
    if (groups.length > most) return
    if (best !== null && groups.length === most && cost >= best.cost) return
    if (index === sorted.length) {
      best = { groups: groups.map((group) => [...group]), cost }
      return
    }
    const item = sorted[index]!
    for (const group of groups) {
      const fits = group.every(
        (other) =>
          sorted[other]!.sourceId !== item.sourceId &&
          compatible(sorted[other]!, item),
      )
      const described = group.some((other) =>
        shares(sorted[other]!.description, item.description),
      )
      if (!fits || !described) continue
      const added = group.reduce(
        (sum, other) => sum + pairCost(other, index),
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
    : best.groups.map((group) => group.map((index) => sorted[index]!))
}

/**
 * Pairing source by source can commit early pairs that keep a later source
 * from completing movements. This revisits each entry with one or two
 * entries it could share a movement with and regroups their evidence when it
 * fits in fewer entries, until nothing changes. Each change removes an
 * entry, so it ends; entries are visited oldest first, so the result is
 * deterministic.
 */
const regroup = (built: ReadonlyArray<Building>): Array<Building> => {
  let current = [...built]
  let changed = true
  while (changed) {
    changed = false
    current.sort((a, b) => firstSequence(a) - firstSequence(b))
    const byDay = new Map<number, Array<Building>>()
    for (const entry of current)
      for (const day of new Set(
        entry.evidence.map((evidence) => dayNumber(evidence.bookedOn)),
      )) {
        const list = byDay.get(day) ?? []
        list.push(entry)
        byDay.set(day, list)
      }
    const rank = new Map(current.map((entry, index) => [entry, index]))
    const gone = new Set<Building>()
    const born: Array<Building> = []
    const linked = (a: Building, b: Building) =>
      a.evidence.some((x) =>
        b.evidence.some((y) => x.sourceId !== y.sourceId && compatible(x, y)),
      )
    for (const entry of current) {
      if (gone.has(entry)) continue
      const near = new Set<Building>()
      for (const evidence of entry.evidence) {
        const day = dayNumber(evidence.bookedOn)
        for (let offset = -matchWindowDays; offset <= matchWindowDays; offset++)
          for (const other of byDay.get(day + offset) ?? [])
            if (other !== entry && !gone.has(other)) near.add(other)
      }
      const neighbors = [...near]
        .filter((other) => linked(entry, other))
        .sort((a, b) => rank.get(a)! - rank.get(b)!)
      const sets: Array<Array<Building>> = []
      neighbors.forEach((first, index) => {
        sets.push([entry, first])
        for (const second of neighbors.slice(index + 1))
          sets.push([entry, first, second])
      })
      for (const set of sets) {
        const items = set.flatMap((member) => member.evidence)
        if (items.length > regroupLimit) continue
        const groups = fewestGroups(items, set.length)
        if (groups === null) continue
        for (const member of set) gone.add(member)
        born.push(...groups.map((evidence) => ({ evidence })))
        changed = true
        break
      }
    }
    current = [...current.filter((entry) => !gone.has(entry)), ...born]
  }
  return current
}

/**
 * Groups observations of one account into entries, one per real movement.
 *
 * Amounts are resolved independently. Within an amount, each source's
 * reports form one batch, taken in the order the sources first reported
 * that amount; a batch is paired with the entries built so far as a whole:
 * the pairing maximizes how many reports find their movement, then prefers
 * close dates and similar descriptions. When pairs made for an earlier
 * source keep a later one from completing movements, neighbouring entries
 * are regrouped into fewer. Reports of other amounts or from unrelated
 * sources cannot change the outcome. A source never reports one movement
 * twice, so identical lines from one source stay separate.
 *
 * A pair needs positive evidence, not just an equal amount nearby: the
 * descriptions share a meaningful word (not "pix", "compra"…), or both are
 * on the same day with no other candidate on either side and no conflicting
 * counterparty. An entry's evidence never spans more than `matchWindowDays`,
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
    // Map insertion order: the order each source first reported this amount.
    const bySource = new Map<string, Array<ObservedTransaction>>()
    for (const observation of group) {
      const batch = bySource.get(observation.sourceId) ?? []
      batch.push(observation)
      bySource.set(observation.sourceId, batch)
    }
    const built: Array<Building> = []
    for (const incoming of bySource.values()) {
      const chosen = assign(pairings(incoming, built))
      const existing = [...built]
      incoming.forEach((observation, row) => {
        const column = chosen.get(row)
        if (column === undefined) built.push({ evidence: [observation] })
        else existing[column]!.evidence.push(observation)
      })
    }
    entries.push(...regroup(built))
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
  entries: ReadonlyArray<
    Pick<ResolvedEntry, 'bookedOn' | 'amountCents' | 'status'> & {
      readonly evidence: ReadonlyArray<{
        readonly sourceId: string
        readonly bookedOn: string
        readonly status: 'pending' | 'posted'
      }>
    }
  >,
  checkpoints: ReadonlyArray<Checkpoint>,
): ReadonlyArray<BalanceInterval> => {
  const ordered = [...checkpoints].sort((a, b) => a.asOf.localeCompare(b.asOf))
  const posted = entries.filter((entry) => entry.status === 'posted')
  const included = (entry: (typeof posted)[number], checkpoint: Checkpoint) => {
    const own = entry.evidence.filter(
      (evidence) => evidence.sourceId === checkpoint.sourceId,
    )
    const booked = own.find((evidence) => evidence.status === 'posted')
    // The source still shows it pending: its balances do not hold it yet.
    if (booked === undefined && own.length > 0) return 0
    return (booked?.bookedOn ?? entry.bookedOn) <= checkpoint.asOf ? 1 : 0
  }
  return ordered.slice(1).map((end, index) => {
    const start = ordered[index]!
    const postedChangeCents = posted.reduce(
      (sum, entry) =>
        sum +
        entry.amountCents * (included(entry, end) - included(entry, start)),
      0,
    )
    const expectedChangeCents = end.balanceCents - start.balanceCents
    return {
      from: start.asOf,
      to: end.asOf,
      expectedChangeCents,
      postedChangeCents,
      differenceCents: expectedChangeCents - postedChangeCents,
    }
  })
}
