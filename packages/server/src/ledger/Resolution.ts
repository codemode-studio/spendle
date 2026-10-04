import { daysBetween } from '../domain/LocalDate.ts'
import { foldDescription } from '../imports/Statement.ts'

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

interface Building {
  readonly order: number
  readonly evidence: Array<ObservedTransaction>
}

// The evidence that speaks for the entry: the first posted report, else the first report.
const representative = (evidence: ReadonlyArray<ObservedTransaction>) =>
  evidence.find((observation) => observation.status === 'posted') ??
  evidence[0]!

/**
 * Minimum-cost assignment of rows to columns (Hungarian method, O(n²m)).
 * `cost[i][j]` may be `Infinity` for forbidden pairs; returns the column of
 * each row, or -1.
 */
const assign = (cost: ReadonlyArray<ReadonlyArray<number>>): Array<number> => {
  const rows = cost.length
  const columns = cost[0]?.length ?? 0
  if (rows === 0 || columns === 0) return Array.from({ length: rows }, () => -1)
  // Pad to a square with a large finite cost, so leaving a row unmatched is
  // always worse than any allowed match: cardinality comes first.
  const size = Math.max(rows, columns)
  const unmatched = 1e9
  const at = (i: number, j: number) => {
    const value = i < rows && j < columns ? cost[i]![j]! : unmatched
    return Number.isFinite(value) ? value : unmatched
  }
  const u = new Array<number>(size + 1).fill(0)
  const v = new Array<number>(size + 1).fill(0)
  const p = new Array<number>(size + 1).fill(0)
  const way = new Array<number>(size + 1).fill(0)
  for (let i = 1; i <= size; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Array<number>(size + 1).fill(Infinity)
    const used = new Array<boolean>(size + 1).fill(false)
    do {
      used[j0] = true
      const i0 = p[j0]!
      let delta = Infinity
      let j1 = 0
      for (let j = 1; j <= size; j++) {
        if (used[j]) continue
        const current = at(i0 - 1, j - 1) - u[i0]! - v[j]!
        if (current < minv[j]!) {
          minv[j] = current
          way[j] = j0
        }
        if (minv[j]! < delta) {
          delta = minv[j]!
          j1 = j
        }
      }
      for (let j = 0; j <= size; j++) {
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
  const result = Array.from({ length: rows }, () => -1)
  for (let j = 1; j <= size; j++) {
    const i = p[j]! - 1
    if (i < rows && j - 1 < columns && Number.isFinite(cost[i]![j - 1]!))
      result[i] = j - 1
  }
  return result
}

/**
 * Groups observations of one account into entries, one per real movement.
 *
 * Observations arrive in batches: consecutive reports of one source (a sync,
 * an imported file). Each batch is paired with the existing entries that
 * have no evidence from that source yet, per amount, as a whole: the pairing
 * maximizes how many observations find their movement, then prefers close
 * dates and similar descriptions. A batch is never matched greedily, so an
 * early choice cannot strand a later observation.
 *
 * A pair needs positive evidence, not just an equal amount nearby: the
 * descriptions share a meaningful word (not "pix", "compra"…), or both are on
 * the same day with no other candidate on either side. An entry's evidence
 * never spans more than `matchWindowDays`. A source never reports one
 * movement twice, so identical lines from one source stay separate.
 *
 * Ids: an entry keeps the id its evidence had in the previous resolution;
 * a new entry takes its first observation's id. The result depends only on
 * the stored observations and those previous ids.
 */
export const resolveEntries = (
  observations: ReadonlyArray<ObservedTransaction>,
): ReadonlyArray<ResolvedEntry> => {
  const ordered = [...observations].sort((a, b) => a.sequence - b.sequence)
  const entries: Array<Building> = []

  const batches: Array<Array<ObservedTransaction>> = []
  for (const observation of ordered) {
    const last = batches.at(-1)
    if (last && last[0]!.sourceId === observation.sourceId)
      last.push(observation)
    else batches.push([observation])
  }

  for (const batch of batches) {
    const sourceId = batch[0]!.sourceId
    const byAmount = new Map<number, Array<ObservedTransaction>>()
    for (const observation of batch) {
      const group = byAmount.get(observation.amountCents) ?? []
      group.push(observation)
      byAmount.set(observation.amountCents, group)
    }
    for (const [amount, incoming] of byAmount) {
      const candidates = entries.filter(
        (entry) =>
          representative(entry.evidence).amountCents === amount &&
          !entry.evidence.some((evidence) => evidence.sourceId === sourceId),
      )
      const near = (observation: ObservedTransaction, entry: Building) =>
        entry.evidence.every(
          (evidence) =>
            daysBetween(evidence.bookedOn, observation.bookedOn) <=
            matchWindowDays,
        )
      const cost = incoming.map((observation) =>
        candidates.map((entry) => {
          if (!near(observation, entry)) return Infinity
          const described = entry.evidence.some((evidence) =>
            sharesMeaningfulWord(evidence.description, observation.description),
          )
          const sameDay = entry.evidence.some(
            (evidence) => evidence.bookedOn === observation.bookedOn,
          )
          const alone =
            candidates.filter((other) => near(observation, other)).length ===
              1 && incoming.filter((other) => near(other, entry)).length === 1
          if (!described && !(sameDay && alone)) return Infinity
          const distance = Math.min(
            ...entry.evidence.map((evidence) =>
              daysBetween(evidence.bookedOn, observation.bookedOn),
            ),
          )
          const similarity = Math.max(
            ...entry.evidence.map((evidence) =>
              descriptionSimilarity(
                evidence.description,
                observation.description,
              ),
            ),
          )
          // Close dates first, then similar descriptions, then older entries.
          return (
            distance * 1000 +
            Math.round((1 - similarity) * 100) +
            entry.order / 1e6
          )
        }),
      )
      const chosen = assign(cost)
      incoming.forEach((observation, index) => {
        const column = chosen[index]!
        if (column >= 0) candidates[column]!.evidence.push(observation)
        else entries.push({ order: entries.length, evidence: [observation] })
      })
    }
  }

  // Each entry keeps the id its evidence carried before; the oldest entry
  // wins a contested id, and a new entry takes its first observation's id.
  const taken = new Set<string>()
  const ids = [...entries]
    .sort((a, b) => a.evidence[0]!.sequence - b.evidence[0]!.sequence)
    .map((entry) => {
      const previous = [...entry.evidence]
        .sort((a, b) => a.sequence - b.sequence)
        .map((evidence) => evidence.previousEntryId)
        .find((id): id is string => id !== null && !taken.has(id))
      const id = previous ?? entry.evidence[0]!.anchorId
      taken.add(id)
      return [entry, id] as const
    })
  const idOf = new Map(ids)

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
 * the date that source gave it, so a credit a statement books on the 30th
 * counts in that statement's close even if another source says the 1st.
 * Pending entries never count.
 */
export const proveBalances = (
  entries: ReadonlyArray<
    Pick<ResolvedEntry, 'bookedOn' | 'amountCents' | 'status'> & {
      readonly evidence: ReadonlyArray<{
        readonly sourceId: string
        readonly bookedOn: string
      }>
    }
  >,
  checkpoints: ReadonlyArray<Checkpoint>,
): ReadonlyArray<BalanceInterval> => {
  const ordered = [...checkpoints].sort((a, b) => a.asOf.localeCompare(b.asOf))
  const posted = entries.filter((entry) => entry.status === 'posted')
  const dateFor = (entry: (typeof posted)[number], sourceId: string) =>
    entry.evidence.find((evidence) => evidence.sourceId === sourceId)
      ?.bookedOn ?? entry.bookedOn
  return ordered.slice(1).map((end, index) => {
    const start = ordered[index]!
    const postedChangeCents = posted
      .filter(
        (entry) =>
          dateFor(entry, start.sourceId) > start.asOf &&
          dateFor(entry, end.sourceId) <= end.asOf,
      )
      .reduce((sum, entry) => sum + entry.amountCents, 0)
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
