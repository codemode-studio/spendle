/**
 * Recurrences as a projection: occurrences come from each schedule, their
 * status from the person's decisions, and payment matches from the entries.
 * Pure, so a better matcher reruns over the whole history.
 *
 * What the matcher learns about a recurrence (merchant signatures, accounts,
 * date offsets, amount range) comes only from links the person confirmed
 * and aliases they brought from V1; its own automatic matches never teach it.
 */
import { foldDescription } from '../imports/Statement.ts'
import {
  knowledgeExactPatterns,
  merchantSignature,
} from '../categories/Patterns.ts'
import {
  addPeriod,
  aggregateWindow,
  daysFrom,
  median,
  previousPeriod,
  scheduleDates,
} from './Schedule.ts'
import type { Frequency } from './Schedule.ts'

export type Direction = 'income' | 'expense'

/** A ledger entry as recurrence matching reads it. */
export interface RecurrenceEntry {
  readonly id: string
  readonly accountId: string
  readonly bookedOn: string
  readonly amountCents: number
  readonly currency: string
  readonly description: string
  readonly status: 'pending' | 'posted'
  /** The category the entry has now, if any. */
  readonly categoryId: string | null
  /** In a transfer or bill payment between the person's accounts. */
  readonly internal: boolean
  /** Belongs to a company owner: categories are not compared. */
  readonly company: boolean
}

export interface RecurrenceRule {
  readonly id: string
  readonly name: string
  readonly accountId: string | null
  readonly categoryId: string
  readonly amountCents: number
  readonly currency: string
  readonly direction: Direction
  readonly amountMode: 'fixed' | 'variable'
  readonly matchMode: 'single' | 'aggregate'
  readonly destinationMode: 'automatic' | 'fixed'
  readonly frequency: Frequency
  readonly startsOn: string
  readonly scheduleAnchor: string
  readonly dateToleranceDays: number
  readonly amountToleranceBps: number
  readonly autoMatch: boolean
  readonly minimumConfirmations: number
  readonly active: boolean
  /** Merchant signatures the person tied to it in V1. */
  readonly importedAliases: ReadonlyArray<string>
}

/** A person's verdict on an entry for one occurrence, already on the entry that holds it now. */
export interface LinkVerdict {
  readonly key: string
  readonly recurrenceId: string
  readonly expectedDate: string
  readonly entryId: string
  readonly decision: 'confirmed' | 'rejected'
  readonly revision: number
}

export interface OccurrenceVerdict {
  readonly recurrenceId: string
  readonly expectedDate: string
  readonly decision: 'skipped' | 'completed'
}

export type MatchStatus = 'suggested' | 'confirmed' | 'auto_confirmed'

export interface OccurrenceMatch {
  /** `<recurrenceId>|<expectedDate>|<entryId>`. */
  readonly id: string
  readonly occurrenceId: string
  readonly entryId: string
  readonly status: MatchStatus
  readonly score: number
  readonly reason: string
  /** The entry's category differs from the recurrence's. */
  readonly categoryConflict: boolean
}

export interface Occurrence {
  /** `<recurrenceId>|<expectedDate>`. */
  readonly id: string
  readonly recurrenceId: string
  readonly expectedDate: string
  readonly expectedAmountCents: number
  readonly status: 'expected' | 'matched' | 'skipped'
  readonly matches: ReadonlyArray<OccurrenceMatch>
}

export interface BookRecurrence {
  readonly rule: RecurrenceRule
  readonly nextDate: string
  /** Newest last. */
  readonly occurrences: ReadonlyArray<Occurrence>
  /** Merchant descriptions the person confirmed for it. */
  readonly learnedDescriptions: ReadonlyArray<string>
  /** Occurrences waiting past their date (or past their period, for envelopes). */
  readonly overdue: ReadonlyArray<Occurrence>
}

export const occurrenceId = (recurrenceId: string, expectedDate: string) =>
  `${recurrenceId}|${expectedDate}`

export const matchId = (
  recurrenceId: string,
  expectedDate: string,
  entryId: string,
) => `${recurrenceId}|${expectedDate}|${entryId}`

/** What confirmed links taught about one recurrence. */
export interface Learning {
  readonly confirmedCount: number
  readonly aliases: ReadonlySet<string>
  readonly accountIds: ReadonlySet<string>
  readonly medianDateOffsetDays: number | undefined
  readonly dateSpreadDays: number | undefined
  readonly amountRangeCents:
    | { readonly min: number; readonly max: number }
    | undefined
  readonly rejectionCount: number
  readonly descriptions: ReadonlyArray<string>
}

const aliasesOf = (description: string) => [
  merchantSignature(description),
  ...knowledgeExactPatterns(description),
]

export const learn = (
  rule: RecurrenceRule,
  confirmed: ReadonlyArray<{
    readonly expectedDate: string
    readonly entry: RecurrenceEntry
  }>,
  rejectionCount: number,
): Learning => {
  const offsets = confirmed.map(({ expectedDate, entry }) =>
    daysFrom(expectedDate, entry.bookedOn),
  )
  const medianOffset = median(offsets)
  const amounts = confirmed.map(({ entry }) => Math.abs(entry.amountCents))
  return {
    confirmedCount: confirmed.length,
    aliases: new Set(
      [
        ...confirmed.flatMap(({ entry }) => aliasesOf(entry.description)),
        ...rule.importedAliases,
      ].filter((alias) => alias.length > 1),
    ),
    accountIds: new Set([
      ...(rule.accountId ? [rule.accountId] : []),
      ...confirmed.map(({ entry }) => entry.accountId),
    ]),
    medianDateOffsetDays: medianOffset,
    dateSpreadDays:
      medianOffset === undefined
        ? undefined
        : Math.max(...offsets.map((offset) => Math.abs(offset - medianOffset))),
    amountRangeCents: amounts.length
      ? { min: Math.min(...amounts), max: Math.max(...amounts) }
      : undefined,
    rejectionCount,
    descriptions: [...new Set(confirmed.map(({ entry }) => entry.description))],
  }
}

const expectedSign = (direction: Direction) =>
  direction === 'expense' ? -1 : 1

/** Whether an entry can be any recurrence's payment at all. */
export const eligible = (entry: RecurrenceEntry) =>
  entry.status === 'posted' && !entry.internal && entry.amountCents !== 0

export interface Candidate {
  readonly entryId: string
  readonly score: number
  readonly reason: string
  readonly autoConfirm: boolean
}

/**
 * Entries that look like the payment of one occurrence, best first. Only a
 * clear winner, of a recurrence the person confirmed often enough, with a
 * merchant and account they confirmed before, is matched automatically;
 * everything else waits as a suggestion.
 */
export const singleCandidates = (input: {
  readonly rule: RecurrenceRule
  readonly expectedDate: string
  readonly learning: Learning
  readonly entries: ReadonlyArray<RecurrenceEntry>
  readonly unavailable: ReadonlySet<string>
  readonly rejected: ReadonlySet<string>
}): ReadonlyArray<Candidate> => {
  const { rule, learning } = input
  const sign = expectedSign(rule.direction)
  const expectedSignature = merchantSignature(rule.name)
  const expectedWords = new Set(
    expectedSignature.split(' ').filter((word) => word.length >= 4),
  )
  const scored = input.entries.flatMap((entry) => {
    if (
      !eligible(entry) ||
      entry.currency !== rule.currency ||
      Math.sign(entry.amountCents) !== sign ||
      input.unavailable.has(entry.id) ||
      input.rejected.has(entry.id)
    )
      return []
    // A fixed destination accepts the registered account and the accounts
    // of confirmed payments: real history beats the form.
    if (
      rule.destinationMode === 'fixed' &&
      !learning.accountIds.has(entry.accountId)
    )
      return []
    const offset = daysFrom(input.expectedDate, entry.bookedOn)
    const learnedDistance = Math.abs(
      offset - (learning.medianDateOffsetDays ?? 0),
    )
    const tolerance = learning.confirmedCount
      ? Math.min(
          rule.dateToleranceDays,
          Math.max(2, (learning.dateSpreadDays ?? 0) + 2),
        )
      : rule.dateToleranceDays
    if (learnedDistance > tolerance) return []

    const absolute = Math.abs(entry.amountCents)
    const difference = Math.abs(absolute - rule.amountCents)
    const range = learning.amountRangeCents
    const padding = range
      ? Math.max(100, Math.round((range.max - range.min) * 0.25))
      : 0
    if (
      range &&
      (absolute < range.min - padding || absolute > range.max + padding)
    )
      return []
    const allowed = range
      ? Math.max(
          1,
          Math.abs(rule.amountCents - range.min) + padding,
          Math.abs(range.max - rule.amountCents) + padding,
        )
      : rule.amountMode === 'fixed'
        ? 1
        : Math.max(
            100,
            Math.round((rule.amountCents * rule.amountToleranceBps) / 10_000),
          )
    if (difference > allowed) return []

    const amountScore = Math.round(40 * (1 - difference / Math.max(1, allowed)))
    const dateScore = Math.round(
      25 * (1 - learnedDistance / Math.max(1, tolerance)),
    )
    const signature = merchantSignature(entry.description)
    const knownMerchant = aliasesOf(entry.description).some(
      (alias) => alias.length > 1 && learning.aliases.has(alias),
    )
    const similar =
      signature.length > 0 &&
      expectedSignature.length > 0 &&
      (signature.includes(expectedSignature) ||
        expectedSignature.includes(signature) ||
        signature.split(' ').some((word) => expectedWords.has(word)))
    const descriptionScore = knownMerchant ? 35 : similar ? 25 : 0
    const knownAccount = learning.accountIds.has(entry.accountId)
    const destinationScore = knownAccount ? 15 : 0
    const penalty = Math.min(12, learning.rejectionCount * 3)
    const score = Math.max(
      0,
      Math.min(
        100,
        amountScore + dateScore + descriptionScore + destinationScore,
      ) - penalty,
    )
    if (score < 75) return []
    const reason = [
      `valor ${difference === 0 ? 'exato' : 'compatível'}`,
      `data a ${Math.abs(offset)} dia(s)`,
      knownMerchant
        ? 'estabelecimento já confirmado'
        : descriptionScore
          ? 'descrição semelhante'
          : null,
      knownAccount ? 'destino já observado' : null,
    ]
      .filter(Boolean)
      .join(' · ')
    return [{ entryId: entry.id, score, reason, knownMerchant, knownAccount }]
  })
  scored.sort((a, b) => b.score - a.score || a.entryId.localeCompare(b.entryId))
  const ambiguous =
    scored.length > 1 && scored[0]!.score - scored[1]!.score < 10
  return scored.map((candidate, index) => ({
    entryId: candidate.entryId,
    score: candidate.score,
    reason: candidate.reason,
    autoConfirm:
      index === 0 &&
      !ambiguous &&
      rule.autoMatch &&
      learning.confirmedCount >= rule.minimumConfirmations &&
      candidate.score >= 95 &&
      candidate.knownMerchant &&
      candidate.knownAccount,
  }))
}

const conflictOf = (rule: RecurrenceRule, entry: RecurrenceEntry) =>
  !entry.company &&
  entry.categoryId !== null &&
  entry.categoryId !== 'uncategorized' &&
  entry.categoryId !== rule.categoryId

/**
 * The scheduled date after the latest resolved occurrence, or the start:
 * the occurrence the person expects next.
 */
const nextDateOf = (rule: RecurrenceRule, resolved: ReadonlyArray<string>) => {
  const latest = [...resolved].sort().at(-1)
  if (latest === undefined) return rule.startsOn
  const next = addPeriod(latest, rule.frequency, rule.scheduleAnchor)
  return next > rule.startsOn ? next : rule.startsOn
}

/**
 * Every recurrence with its occurrences, statuses and payment matches as of
 * `today`. Confirmed links claim their entries first; automatic matches
 * then claim what is left, recurrence by recurrence in date order, so an
 * entry pays one occurrence at most.
 */
export const buildBook = (input: {
  readonly today: string
  readonly rules: ReadonlyArray<RecurrenceRule>
  readonly entries: ReadonlyArray<RecurrenceEntry>
  readonly links: ReadonlyArray<LinkVerdict>
  readonly occurrenceDecisions: ReadonlyArray<OccurrenceVerdict>
}): ReadonlyArray<BookRecurrence> => {
  const entryById = new Map(input.entries.map((entry) => [entry.id, entry]))
  const rules = [...input.rules].sort((a, b) => a.id.localeCompare(b.id))
  const ruleIds = new Set(rules.map((rule) => rule.id))

  // The latest verdict per pair; a confirmed entry belongs to one occurrence.
  const latest = new Map<string, LinkVerdict>()
  for (const link of [...input.links].sort((a, b) => a.revision - b.revision)) {
    if (!ruleIds.has(link.recurrenceId) || !entryById.has(link.entryId))
      continue
    latest.set(
      matchId(link.recurrenceId, link.expectedDate, link.entryId),
      link,
    )
  }
  const claimed = new Map<string, string>()
  const confirmedOf = new Map<string, Array<LinkVerdict>>()
  const rejectedOf = new Map<string, Set<string>>()
  const rejectionCount = new Map<string, number>()
  for (const link of [...latest.values()].sort(
    (a, b) => b.revision - a.revision,
  )) {
    const occurrence = occurrenceId(link.recurrenceId, link.expectedDate)
    if (link.decision === 'rejected') {
      const set = rejectedOf.get(occurrence) ?? new Set<string>()
      set.add(link.entryId)
      rejectedOf.set(occurrence, set)
      rejectionCount.set(
        link.recurrenceId,
        (rejectionCount.get(link.recurrenceId) ?? 0) + 1,
      )
      continue
    }
    if (claimed.has(link.entryId)) continue
    claimed.set(link.entryId, occurrence)
    const list = confirmedOf.get(occurrence) ?? []
    list.push(link)
    confirmedOf.set(occurrence, list)
  }
  const verdictOf = new Map(
    input.occurrenceDecisions.map((verdict) => [
      occurrenceId(verdict.recurrenceId, verdict.expectedDate),
      verdict.decision,
    ]),
  )

  const book: Array<BookRecurrence> = []
  for (const rule of rules) {
    const confirmedForRule = [...confirmedOf.entries()].flatMap(([, links]) =>
      links
        .filter((link) => link.recurrenceId === rule.id)
        .map((link) => ({
          expectedDate: link.expectedDate,
          entry: entryById.get(link.entryId)!,
        })),
    )
    const learning = learn(
      rule,
      confirmedForRule,
      rejectionCount.get(rule.id) ?? 0,
    )

    // Scheduled dates, plus any date the person decided about.
    const decided = new Set<string>([
      ...input.occurrenceDecisions
        .filter((verdict) => verdict.recurrenceId === rule.id)
        .map((verdict) => verdict.expectedDate),
      ...[...latest.values()]
        .filter(
          (link) =>
            link.recurrenceId === rule.id && link.decision === 'confirmed',
        )
        .map((link) => link.expectedDate),
    ])
    const resolvedByDecision = [...decided].filter((date) => {
      const id = occurrenceId(rule.id, date)
      return (
        verdictOf.has(id) ||
        (rule.matchMode === 'single' && (confirmedOf.get(id)?.length ?? 0) > 0)
      )
    })
    let nextDate = nextDateOf(rule, resolvedByDecision)
    const dates = new Set([
      ...scheduleDates(rule, input.today > nextDate ? input.today : nextDate),
      ...decided,
    ])

    const occurrences: Array<Occurrence> = []
    for (const date of [...dates].sort()) {
      const id = occurrenceId(rule.id, date)
      const verdict = verdictOf.get(id)
      const confirmed = (confirmedOf.get(id) ?? []).map(
        (link): OccurrenceMatch => {
          const entry = entryById.get(link.entryId)!
          return {
            id: matchId(rule.id, date, entry.id),
            occurrenceId: id,
            entryId: entry.id,
            status: 'confirmed',
            score: 100,
            reason: 'vinculado pela pessoa',
            categoryConflict: conflictOf(rule, entry),
          }
        },
      )
      const matches: Array<OccurrenceMatch> = [...confirmed]
      let status: Occurrence['status'] =
        verdict === 'skipped'
          ? 'skipped'
          : verdict === 'completed' ||
              (rule.matchMode === 'single' && confirmed.length > 0)
            ? 'matched'
            : 'expected'
      if (status === 'expected' && rule.active) {
        const rejected = rejectedOf.get(id) ?? new Set<string>()
        if (rule.matchMode === 'single') {
          const candidates = singleCandidates({
            rule,
            expectedDate: date,
            learning,
            entries: input.entries,
            unavailable: new Set(claimed.keys()),
            rejected,
          }).slice(0, 3)
          const auto = candidates.find((candidate) => candidate.autoConfirm)
          for (const candidate of auto ? [auto] : candidates) {
            const entry = entryById.get(candidate.entryId)!
            matches.push({
              id: matchId(rule.id, date, entry.id),
              occurrenceId: id,
              entryId: entry.id,
              status: auto ? 'auto_confirmed' : 'suggested',
              score: candidate.score,
              reason: candidate.reason,
              categoryConflict: conflictOf(rule, entry),
            })
          }
          if (auto) {
            claimed.set(auto.entryId, id)
            status = 'matched'
          }
        } else {
          const window = aggregateWindow(date, rule)
          for (const entry of input.entries) {
            if (
              !eligible(entry) ||
              entry.currency !== rule.currency ||
              Math.sign(entry.amountCents) !== expectedSign(rule.direction) ||
              claimed.has(entry.id) ||
              rejected.has(entry.id) ||
              entry.bookedOn < window.start ||
              entry.bookedOn >= window.end
            )
              continue
            const knownMerchant = aliasesOf(entry.description).some(
              (alias) => alias.length > 1 && learning.aliases.has(alias),
            )
            const sameCategory = entry.categoryId === rule.categoryId
            if (!knownMerchant && !sameCategory) continue
            const auto = knownMerchant && rule.autoMatch
            matches.push({
              id: matchId(rule.id, date, entry.id),
              occurrenceId: id,
              entryId: entry.id,
              status: auto ? 'auto_confirmed' : 'suggested',
              score: auto ? 95 : 60,
              reason: knownMerchant
                ? 'estabelecimento já confirmado neste envelope'
                : 'mesma categoria no período',
              categoryConflict: conflictOf(rule, entry),
            })
            if (auto) claimed.set(entry.id, id)
          }
          // A period that ended with payments is complete.
          if (
            window.end <= input.today &&
            matches.some((match) => match.status !== 'suggested')
          )
            status = 'matched'
        }
      }
      occurrences.push({
        id,
        recurrenceId: rule.id,
        expectedDate: date,
        expectedAmountCents: rule.amountCents,
        status,
        matches:
          status === 'expected'
            ? matches
            : matches.filter((match) => match.status !== 'suggested'),
      })
    }
    // Automatic matches resolve occurrences too.
    nextDate = nextDateOf(
      rule,
      occurrences
        .filter((occurrence) => occurrence.status !== 'expected')
        .map((o) => o.expectedDate),
    )
    // The occurrence the person expects next is always listed.
    if (!occurrences.some((occurrence) => occurrence.expectedDate === nextDate))
      occurrences.push({
        id: occurrenceId(rule.id, nextDate),
        recurrenceId: rule.id,
        expectedDate: nextDate,
        expectedAmountCents: rule.amountCents,
        status: 'expected',
        matches: [],
      })
    const overdue = rule.active
      ? occurrences.filter(
          (occurrence) =>
            occurrence.status === 'expected' &&
            (rule.matchMode === 'aggregate'
              ? aggregateWindow(occurrence.expectedDate, rule).end <=
                input.today
              : occurrence.expectedDate < input.today),
        )
      : []
    book.push({
      rule,
      nextDate,
      occurrences,
      learnedDescriptions: learning.descriptions,
      overdue,
    })
  }
  return book
}

/** The entries the book already counts as some occurrence's payment. */
export const acceptedEntries = (book: ReadonlyArray<BookRecurrence>) =>
  new Map(
    book.flatMap((recurrence) =>
      recurrence.occurrences.flatMap((occurrence) =>
        occurrence.matches
          .filter((match) => match.status !== 'suggested')
          .map((match) => [match.entryId, { recurrence, occurrence }] as const),
      ),
    ),
  )

/** An entry offered when the person links a payment by hand. */
export interface LinkCandidate {
  readonly entryId: string
  readonly sameCategory: boolean
  readonly amountDifferenceCents: number
  readonly daysApart: number
  readonly rank: number
}

/** Posted entries that could pay the occurrence, most plausible first. */
/**
 * Whether an entry can pay the occurrence of `expectedDate`. An envelope
 * period only sums what was booked inside it; a single payment may come
 * early or late.
 */
export const withinPeriod = (
  rule: RecurrenceRule,
  expectedDate: string,
  entry: RecurrenceEntry,
) => {
  if (rule.matchMode === 'single') return true
  const window = aggregateWindow(expectedDate, rule)
  return entry.bookedOn >= window.start && entry.bookedOn < window.end
}

export const linkCandidates = (input: {
  readonly rule: RecurrenceRule
  readonly expectedDate: string
  readonly entries: ReadonlyArray<RecurrenceEntry>
  readonly taken: ReadonlySet<string>
}): ReadonlyArray<LinkCandidate> => {
  const { rule } = input
  return input.entries
    .flatMap((entry) => {
      if (
        !eligible(entry) ||
        entry.currency !== rule.currency ||
        Math.sign(entry.amountCents) !== expectedSign(rule.direction) ||
        !withinPeriod(rule, input.expectedDate, entry) ||
        input.taken.has(entry.id)
      )
        return []
      const amountDifferenceCents = Math.abs(
        Math.abs(entry.amountCents) - rule.amountCents,
      )
      const daysApart = Math.abs(daysFrom(input.expectedDate, entry.bookedOn))
      const sameCategory = entry.categoryId === rule.categoryId
      const rank =
        rule.matchMode === 'aggregate'
          ? (sameCategory ? 0 : 500) + daysApart
          : (amountDifferenceCents / Math.max(rule.amountCents, 1)) * 100 +
            daysApart
      return [
        {
          entryId: entry.id,
          sameCategory,
          amountDifferenceCents,
          daysApart,
          rank,
        },
      ]
    })
    .sort((a, b) => a.rank - b.rank || a.entryId.localeCompare(b.entryId))
}

/**
 * Where a detected recurrence starts and which past occurrence each of its
 * payments settles: the nearest still open. Past occurrences no payment
 * settles are skipped, so approving never leaves invented debts behind.
 */
export const planApproval = (input: {
  readonly nextDate: string
  readonly frequency: Frequency
  readonly today: string
  readonly entries: ReadonlyArray<{
    readonly id: string
    readonly bookedOn: string
  }>
}) => {
  const ordered = [...input.entries].sort(
    (a, b) => a.bookedOn.localeCompare(b.bookedOn) || a.id.localeCompare(b.id),
  )
  let startsOn = input.nextDate
  const earliest = ordered[0]?.bookedOn
  while (earliest !== undefined && startsOn > earliest)
    startsOn = previousPeriod(startsOn, input.frequency, input.nextDate)
  const open = new Set(
    scheduleDates(
      { startsOn, scheduleAnchor: input.nextDate, frequency: input.frequency },
      input.today > input.nextDate ? input.today : input.nextDate,
    ),
  )
  const links: Array<{
    readonly expectedDate: string
    readonly entryId: string
  }> = []
  for (const entry of ordered) {
    const nearest = [...open].sort(
      (a, b) =>
        Math.abs(daysFrom(a, entry.bookedOn)) -
          Math.abs(daysFrom(b, entry.bookedOn)) || a.localeCompare(b),
    )[0]
    if (nearest === undefined) break
    open.delete(nearest)
    links.push({ expectedDate: nearest, entryId: entry.id })
  }
  const skipped = [...open].filter((date) => date < input.today).sort()
  return { startsOn, scheduleAnchor: input.nextDate, links, skipped }
}

// ─── Detection ────────────────────────────────────────────────────────────

export interface DetectedRecurrence {
  /** `<signature>|<direction>|<currency>`. */
  readonly key: string
  readonly signature: string
  readonly name: string
  readonly direction: Direction
  readonly currency: string
  readonly frequency: Frequency
  readonly amountMode: 'fixed' | 'variable'
  readonly typicalAmountCents: number
  readonly minAmountCents: number
  readonly maxAmountCents: number
  readonly accountId: string | null
  readonly categoryId: string | null
  readonly nextExpectedDate: string
  /** 0–100; grows with payments and regularity. */
  readonly confidence: number
  readonly entries: ReadonlyArray<{
    readonly id: string
    readonly bookedOn: string
    readonly amountCents: number
  }>
}

const mostFrequent = <T>(values: ReadonlyArray<T>): T | null => {
  const counts = new Map<T, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best: T | null = null
  let bestCount = 0
  for (const [value, count] of counts)
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  return best
}

/** A readable name from the group's most common description. */
export const displayName = (descriptions: ReadonlyArray<string>) => {
  const chosen =
    mostFrequent(
      descriptions.map((value) =>
        value
          .replace(/^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}\*/, '')
          .replace(/\s+-\s+parcela\s+\d+\/\d+$/i, '')
          .trim(),
      ),
    ) ?? ''
  if (chosen !== chosen.toUpperCase() || !/[A-Z]/.test(chosen)) return chosen
  return chosen
    .toLowerCase()
    .replace(
      /(^|[\s(/-])([a-zà-ú])/g,
      (_, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`,
    )
}

const cadences = [
  {
    frequency: 'monthly' as const,
    min: 24,
    max: 37,
    spread: 7,
    staleAfter: 75,
  },
  {
    frequency: 'yearly' as const,
    min: 350,
    max: 380,
    spread: 20,
    staleAfter: 400,
  },
]

/** Categories that never form a recurrence. */
const neverRecurring = new Set(['transfer', 'card_payment'])

/**
 * Candidates for the person to review: merchants paid at a steady monthly
 * or yearly cadence with a stable amount. Nothing is created from them.
 */
export const detect = (input: {
  readonly today: string
  readonly entries: ReadonlyArray<RecurrenceEntry>
  /** Entries already counted as some occurrence's payment. */
  readonly excluded: ReadonlySet<string>
  /** Signatures of existing recurrences: names and learned merchants. */
  readonly known: ReadonlySet<string>
  /** `<signature>|<direction>` the person ignored. */
  readonly ignored: ReadonlySet<string>
}): ReadonlyArray<DetectedRecurrence> => {
  type Row = RecurrenceEntry & {
    readonly signature: string
    readonly direction: Direction
  }
  const rows: Array<Row> = []
  for (const entry of input.entries) {
    if (!eligible(entry) || input.excluded.has(entry.id)) continue
    if (entry.categoryId !== null && neverRecurring.has(entry.categoryId))
      continue
    const signature = merchantSignature(entry.description)
    if (signature.length < 3 || !/[a-z]/.test(signature)) continue
    rows.push({
      ...entry,
      signature,
      direction: entry.amountCents < 0 ? 'expense' : 'income',
    })
  }
  // A bank fee and its cashback show as same-day pairs in and out under one
  // description; they are not the family's recurrences.
  const days = new Map<string, Set<Direction>>()
  for (const row of rows) {
    const key = `${row.signature}|${row.currency}|${row.bookedOn}`
    const set = days.get(key) ?? new Set<Direction>()
    set.add(row.direction)
    days.set(key, set)
  }
  const pairs = new Map<string, number>()
  for (const [key, directions] of days)
    if (directions.size > 1) {
      const signature = key.split('|')[0]!
      pairs.set(signature, (pairs.get(signature) ?? 0) + 1)
    }
  const groups = new Map<string, Array<Row>>()
  for (const row of rows) {
    if ((pairs.get(row.signature) ?? 0) >= 2) continue
    if (input.known.has(row.signature)) continue
    if (input.ignored.has(`${row.signature}|${row.direction}`)) continue
    const key = `${row.signature}|${row.direction}|${row.currency}`
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  }

  const detected: Array<DetectedRecurrence> = []
  for (const [key, items] of groups) {
    items.sort(
      (a, b) =>
        a.bookedOn.localeCompare(b.bookedOn) || a.id.localeCompare(b.id),
    )
    if (items.length < 2) continue
    if (new Set(items.map((item) => item.bookedOn.slice(0, 7))).size < 2)
      continue
    const gaps = items
      .slice(1)
      .map((item, index) => daysFrom(items[index]!.bookedOn, item.bookedOn))
    const medianGap = median(gaps) ?? 0
    const cadence = cadences.find(
      (candidate) =>
        medianGap >= candidate.min &&
        medianGap <= candidate.max &&
        gaps.every((gap) => Math.abs(gap - medianGap) <= candidate.spread),
    )
    if (!cadence) continue
    const amounts = items.map((item) => Math.abs(item.amountCents))
    const typical = Math.round(median(amounts) ?? 0)
    const variation =
      typical > 0
        ? Math.max(...amounts.map((amount) => Math.abs(amount - typical))) /
          typical
        : 1
    if (variation > 0.25) continue
    const amountMode = variation <= 0.02 ? 'fixed' : 'variable'
    const last = items.at(-1)!
    if (daysFrom(last.bookedOn, input.today) > cadence.staleAfter) continue
    const maxDeviation = Math.max(
      ...gaps.map((gap) => Math.abs(gap - medianGap)),
    )
    const confidence = Math.max(
      30,
      Math.min(
        100,
        50 +
          15 * Math.min(items.length - 2, 3) +
          (amountMode === 'fixed' ? 5 : 0) -
          Math.max(0, maxDeviation - 2) * 2,
      ),
    )
    const anchorDay = Math.round(
      median(items.map((item) => Number(item.bookedOn.slice(8, 10)))) ?? 1,
    )
    const anchor = `${last.bookedOn.slice(0, 8)}${String(anchorDay).padStart(2, '0')}`
    let nextExpectedDate = addPeriod(last.bookedOn, cadence.frequency, anchor)
    while (daysFrom(nextExpectedDate, input.today) > 45)
      nextExpectedDate = addPeriod(nextExpectedDate, cadence.frequency, anchor)
    const [signature, direction] = key.split('|') as [string, Direction]
    detected.push({
      key,
      signature,
      name: displayName(items.map((item) => item.description)),
      direction,
      currency: last.currency,
      frequency: cadence.frequency,
      amountMode,
      typicalAmountCents: typical,
      minAmountCents: Math.min(...amounts),
      maxAmountCents: Math.max(...amounts),
      accountId: mostFrequent(items.map((item) => item.accountId)),
      categoryId:
        mostFrequent(
          items
            .map((item) => item.categoryId)
            .filter(
              (value): value is string =>
                value !== null && value !== 'uncategorized',
            ),
        ) ?? null,
      nextExpectedDate,
      confidence,
      entries: items.map((item) => ({
        id: item.id,
        bookedOn: item.bookedOn,
        amountCents: item.amountCents,
      })),
    })
  }
  return detected.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      b.typicalAmountCents - a.typicalAmountCents ||
      foldDescription(a.name).localeCompare(foldDescription(b.name)),
  )
}

/** Signatures detection should treat as already covered. */
export const knownSignatures = (book: ReadonlyArray<BookRecurrence>) => {
  const known = new Set<string>()
  for (const recurrence of book) {
    known.add(merchantSignature(recurrence.rule.name))
    for (const description of recurrence.learnedDescriptions)
      known.add(merchantSignature(description))
    for (const alias of recurrence.rule.importedAliases) known.add(alias)
  }
  known.delete('')
  return known
}
