import { foldDescription } from '../imports/Statement.ts'

/**
 * One observed transaction identity (source, account, external id) at its
 * latest version. `anchorId` is the id of its first version and `firstSeen`
 * when it was first observed; both never change, which keeps entry ids stable.
 */
export interface ObservedTransaction {
  readonly anchorId: string
  readonly firstSeen: string
  readonly sourceId: string
  readonly externalId: string
  readonly bookedOn: string
  readonly amountCents: number
  readonly description: string
  readonly status: 'pending' | 'posted'
}

/** A canonical transaction: one real movement of money, with every observation of it. */
export interface ResolvedEntry {
  /** The anchor id of the entry's earliest observation. */
  readonly id: string
  readonly bookedOn: string
  readonly amountCents: number
  readonly description: string
  readonly status: 'pending' | 'posted'
  readonly evidence: ReadonlyArray<ObservedTransaction>
}

/** Banks and aggregators may date the same movement a few days apart. */
export const matchWindowDays = 3

const dayNumber = (date: string) => {
  const [year, month, day] = date.split('-').map(Number) as [
    number,
    number,
    number,
  ]
  // Days since a fixed epoch via the civil-from-days inverse; exact for the Gregorian calendar.
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yearOfEra = y - era * 400
  const dayOfYear =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear
  return era * 146097 + dayOfEra
}

const daysApart = (a: string, b: string) =>
  Math.abs(dayNumber(a) - dayNumber(b))

const tokens = (description: string) =>
  new Set(
    foldDescription(description)
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 1),
  )

/** Jaccard overlap of description words, 0 to 1. Only breaks ties between equal candidates. */
export const descriptionSimilarity = (a: string, b: string) => {
  const left = tokens(a)
  const right = tokens(b)
  if (left.size === 0 && right.size === 0) return 1
  let shared = 0
  for (const token of left) if (right.has(token)) shared++
  return shared / (left.size + right.size - shared)
}

interface Building {
  readonly id: string
  readonly evidence: Array<ObservedTransaction>
}

// The evidence that speaks for the entry: the first posted report, else the first report.
const representative = (evidence: ReadonlyArray<ObservedTransaction>) =>
  evidence.find((observation) => observation.status === 'posted') ??
  evidence[0]!

/**
 * Groups observations of one account into entries. Observations are taken in
 * the order they were first seen. Each joins the closest existing entry with
 * the same amount within the date window that has no evidence from its own
 * source yet: a source never reports one movement twice, so two identical
 * lines from one source stay two entries. Ties go to the closest date, then
 * the most similar description, then the older entry.
 *
 * The result depends only on the stored observations, so rebuilding
 * reproduces the same entries with the same ids.
 */
export const resolveEntries = (
  observations: ReadonlyArray<ObservedTransaction>,
): ReadonlyArray<ResolvedEntry> => {
  const ordered = [...observations].sort(
    (a, b) =>
      a.firstSeen.localeCompare(b.firstSeen) ||
      a.anchorId.localeCompare(b.anchorId),
  )
  const entries: Array<Building> = []
  for (const observation of ordered) {
    let best:
      { entry: Building; distance: number; similarity: number } | undefined
    for (const entry of entries) {
      const anchor = representative(entry.evidence)
      if (anchor.amountCents !== observation.amountCents) continue
      if (
        entry.evidence.some(
          (evidence) => evidence.sourceId === observation.sourceId,
        )
      )
        continue
      const distance = Math.min(
        ...entry.evidence.map((evidence) =>
          daysApart(evidence.bookedOn, observation.bookedOn),
        ),
      )
      if (distance > matchWindowDays) continue
      const similarity = descriptionSimilarity(
        anchor.description,
        observation.description,
      )
      if (
        best === undefined ||
        distance < best.distance ||
        (distance === best.distance && similarity > best.similarity)
      ) {
        best = { entry, distance, similarity }
      }
    }
    if (best) best.entry.evidence.push(observation)
    else entries.push({ id: observation.anchorId, evidence: [observation] })
  }
  return entries.map((entry) => {
    const speaker = representative(entry.evidence)
    return {
      id: entry.id,
      bookedOn: speaker.bookedOn,
      amountCents: speaker.amountCents,
      description: speaker.description,
      status: entry.evidence.some((evidence) => evidence.status === 'posted')
        ? 'posted'
        : 'pending',
      evidence: entry.evidence,
    }
  })
}

export interface Checkpoint {
  readonly asOf: string
  readonly balanceCents: number
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
 * its day. Pending entries never count.
 */
export const proveBalances = (
  entries: ReadonlyArray<
    Pick<ResolvedEntry, 'bookedOn' | 'amountCents' | 'status'>
  >,
  checkpoints: ReadonlyArray<Checkpoint>,
): ReadonlyArray<BalanceInterval> => {
  const ordered = [...checkpoints].sort((a, b) => a.asOf.localeCompare(b.asOf))
  const posted = entries.filter((entry) => entry.status === 'posted')
  return ordered.slice(1).map((end, index) => {
    const start = ordered[index]!
    const postedChangeCents = posted
      .filter(
        (entry) => entry.bookedOn > start.asOf && entry.bookedOn <= end.asOf,
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
