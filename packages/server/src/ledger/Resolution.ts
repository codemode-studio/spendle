import { assign } from '../domain/Assignment.ts'
import type { Edge } from '../domain/Assignment.ts'
import { daysBetween } from '../domain/LocalDate.ts'
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

/** Jaccard overlap of description words, 0 to 1. */
export const descriptionSimilarity = (a: string, b: string) => {
  const left = words(a)
  const right = words(b)
  if (left.size === 0 && right.size === 0) return 1
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  return shared / (left.size + right.size - shared)
}

const sharesMeaningfulWord = (a: string, b: string) => {
  const right = meaningfulWords(b)
  return [...meaningfulWords(a)].some((word) => right.has(word))
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
 * entries of that amount, with their cost. Entries out of every report's
 * reach never become part of the problem.
 */
export const pairings = (
  incoming: ReadonlyArray<ObservedTransaction>,
  entries: ReadonlyArray<{
    readonly evidence: ReadonlyArray<ObservedTransaction>
  }>,
): Array<Edge> => {
  const reachable = incoming.map((observation) =>
    entries.flatMap((entry, column) =>
      entry.evidence.every((evidence) => compatible(evidence, observation))
        ? [column]
        : [],
    ),
  )
  const reachedBy = new Map<number, number>()
  for (const columns of reachable)
    for (const column of columns)
      reachedBy.set(column, (reachedBy.get(column) ?? 0) + 1)

  return incoming.flatMap((observation, row) =>
    reachable[row]!.flatMap((column) => {
      const entry = entries[column]!
      const described = entry.evidence.some((evidence) =>
        sharesMeaningfulWord(evidence.description, observation.description),
      )
      if (!described) {
        const sameDay = entry.evidence.some(
          (evidence) => evidence.bookedOn === observation.bookedOn,
        )
        const alone =
          reachable[row]!.length === 1 && reachedBy.get(column) === 1
        // Both name a counterparty and the names share nothing: two payees.
        const contradicted =
          meaningfulWords(observation.description).size > 0 &&
          entry.evidence.some(
            (evidence) => meaningfulWords(evidence.description).size > 0,
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
          descriptionSimilarity(evidence.description, observation.description),
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

/**
 * Groups observations of one account into entries, one per real movement.
 *
 * Amounts are resolved independently. Within an amount, each source's
 * reports form one batch, taken in the order the sources first reported
 * that amount; a batch is paired with the entries built so far as a whole:
 * the pairing maximizes how many reports find their movement, then prefers
 * close dates and similar descriptions. Nothing is matched greedily, and
 * reports of other amounts or from unrelated sources cannot change the
 * outcome. A source never reports one movement twice, so identical lines
 * from one source stay separate.
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
    entries.push(...built)
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
 * source that only reported the entry as pending has not booked it, so the
 * entry's posted date applies. Each interval counts what is included at its
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
  const included = (entry: (typeof posted)[number], checkpoint: Checkpoint) =>
    (entry.evidence.find(
      (evidence) =>
        evidence.sourceId === checkpoint.sourceId &&
        evidence.status === 'posted',
    )?.bookedOn ?? entry.bookedOn) <= checkpoint.asOf
      ? 1
      : 0
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
