import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { Categorizer } from '../categories/Categorizer.ts'
import { today } from '../domain/LocalDate.ts'
import { EventLog } from '../events/EventLog.ts'
import { foldDescription } from '../imports/Statement.ts'
import { convert, rateTable } from '../rates/Conversion.ts'
import type { Converted } from '../rates/Conversion.ts'
import { ExchangeRates } from '../rates/ExchangeRates.ts'
import { LedgerReads } from './LedgerReads.ts'
import type { PlanningEntry } from './LedgerReads.ts'
import type { MonthRelation } from './Month.ts'
import {
  acceptedEntries,
  buildBook,
  detect,
  eligible,
  knownSignatures,
  linkCandidates,
  occurrenceId,
  planApproval,
} from './RecurrencePolicy.ts'
import type {
  BookRecurrence,
  LinkVerdict,
  OccurrenceVerdict,
  RecurrenceEntry,
  RecurrenceRule,
} from './RecurrencePolicy.ts'

export const recurrencesChanged = 'RecurrencesChanged'

export class RecurrenceError extends Schema.TaggedError<RecurrenceError>()(
  'RecurrenceError',
  {
    reason: Schema.Literals([
      'recurrence_not_found',
      'occurrence_not_found',
      /** Already matched or skipped. */
      'occurrence_resolved',
      /** Resume the recurrence before linking payments. */
      'recurrence_paused',
      'entry_not_found',
      /** Pending, another currency or direction, or a move between own accounts. */
      'entry_not_linkable',
      /** The person already linked this entry to another occurrence. */
      'already_linked',
      /** One payment per period; envelopes take several. */
      'single_payment',
      'match_not_found',
      /** Envelope periods close once at least one payment is linked. */
      'nothing_linked',
      /** Unlink the confirmed payments before deleting. */
      'has_confirmed_links',
      'category_not_assignable',
      'account_not_found',
      'currency_mismatch',
      'destination_required',
      'invalid_input',
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.detail ? `${this.reason}: ${this.detail}` : this.reason
  }
}

export const RecurrenceInput = Schema.Struct({
  name: Schema.String,
  groupName: Schema.optional(Schema.NullOr(Schema.String)),
  participantLabel: Schema.optional(Schema.NullOr(Schema.String)),
  accountId: Schema.NullOr(Schema.String),
  categoryId: Schema.String,
  amountCents: Schema.Int.check(Schema.isGreaterThan(0)),
  currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/)),
  direction: Schema.Literals(['income', 'expense']),
  amountMode: Schema.Literals(['fixed', 'variable']),
  matchMode: Schema.Literals(['single', 'aggregate']),
  destinationMode: Schema.Literals(['automatic', 'fixed']),
  frequency: Schema.Literals(['monthly', 'yearly']),
  nextDate: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
})
export type RecurrenceInput = typeof RecurrenceInput.Type

export interface OccurrenceRef {
  readonly recurrenceId: string
  readonly expectedDate: string
}
export interface MatchRef extends OccurrenceRef {
  readonly entryId: string
}

export interface ApprovalInput {
  readonly name: string
  readonly categoryId: string
  readonly amountCents: number
  readonly currency: string
  readonly direction: 'income' | 'expense'
  readonly amountMode: 'fixed' | 'variable'
  readonly frequency: 'monthly' | 'yearly'
  readonly nextDate: string
  readonly accountId: string | null
  readonly entryIds: ReadonlyArray<string>
}

const RuleRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  groupId: Schema.NullOr(Schema.String),
  participantLabel: Schema.NullOr(Schema.String),
  accountId: Schema.NullOr(Schema.String),
  categoryId: Schema.String,
  amountCents: Schema.Int,
  currency: Schema.String,
  direction: Schema.Literals(['income', 'expense']),
  amountMode: Schema.Literals(['fixed', 'variable']),
  matchMode: Schema.Literals(['single', 'aggregate']),
  destinationMode: Schema.Literals(['automatic', 'fixed']),
  frequency: Schema.Literals(['monthly', 'yearly']),
  startsOn: Schema.String,
  scheduleAnchor: Schema.String,
  dateToleranceDays: Schema.Int,
  amountToleranceBps: Schema.Int,
  autoMatch: Schema.BooleanFromBit,
  minimumConfirmations: Schema.Int,
  active: Schema.BooleanFromBit,
})

const LinkRow = Schema.Struct({
  key: Schema.String,
  recurrenceId: Schema.String,
  expectedDate: Schema.String,
  decision: Schema.Literals(['confirmed', 'rejected']),
  origin: Schema.Literals(['person', 'approval', 'v1_import']),
  revision: Schema.Int,
})

/** A recurrence with its schedule as the web app shows it. */
export interface RecurrenceView {
  readonly id: string
  readonly name: string
  readonly groupId: string | null
  readonly participantLabel: string | null
  readonly accountId: string | null
  readonly categoryId: string
  readonly amountCents: number
  readonly currency: string
  readonly direction: 'income' | 'expense'
  readonly amountMode: 'fixed' | 'variable'
  readonly matchMode: 'single' | 'aggregate'
  readonly destinationMode: 'automatic' | 'fixed'
  readonly frequency: 'monthly' | 'yearly'
  readonly startsOn: string
  readonly scheduleAnchor: string
  readonly nextDate: string
  readonly active: boolean
  /** The amount in reais at the latest rate; null in reais or without a rate. */
  readonly converted: Converted | null
  /** Merchant descriptions the person confirmed for it. */
  readonly learnedDescriptions: ReadonlyArray<string>
  readonly occurrences: ReadonlyArray<{
    readonly id: string
    readonly expectedDate: string
    readonly expectedAmountCents: number
    readonly currency: string
    readonly status: 'expected' | 'matched' | 'skipped'
    readonly overdue: boolean
    readonly matches: ReadonlyArray<{
      readonly id: string
      readonly occurrenceId: string
      readonly entryId: string
      readonly status: 'suggested' | 'confirmed' | 'auto_confirmed'
      readonly score: number
      readonly reason: string
      readonly categoryConflict: boolean
      readonly entry: EntrySummary
    }>
  }>
}

export interface EntrySummary {
  readonly id: string
  readonly accountId: string
  readonly accountName: string
  readonly bookedOn: string
  readonly description: string
  readonly amountCents: number
  readonly currency: string
  readonly categoryId: string | null
}

const incomeBuckets = new Set(['income'])
const expenseBuckets = new Set(['essential', 'lifestyle', 'tax', 'business'])

/**
 * Recurrences: the schedules the person keeps and their verdicts on
 * payments. Occurrences, matches and detected candidates are recomputed on
 * every read from those verdicts and the ledger.
 */
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const log = yield* EventLog
  const crypto = yield* Crypto.Crypto
  const reads = yield* LedgerReads
  const exchangeRates = yield* ExchangeRates
  const categorizer = yield* Categorizer
  const now = Effect.map(DateTime.now, DateTime.formatIso)
  const newId = crypto.randomUUIDv7.pipe(Effect.orDie)

  const findRules = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RuleRow,
    execute: () => sql`
      SELECT id, name, group_id AS groupId, participant_label AS participantLabel,
        account_id AS accountId, category_id AS categoryId, amount_cents AS amountCents, currency,
        direction, amount_mode AS amountMode, match_mode AS matchMode,
        destination_mode AS destinationMode, frequency, starts_on AS startsOn,
        schedule_anchor AS scheduleAnchor, date_tolerance_days AS dateToleranceDays,
        amount_tolerance_bps AS amountToleranceBps, auto_match AS autoMatch,
        minimum_confirmations AS minimumConfirmations, active
      FROM recurrences ORDER BY created_at, rowid
    `,
  })
  const findAliases = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      recurrenceId: Schema.String,
      pattern: Schema.String,
    }),
    execute: () =>
      sql`SELECT recurrence_id AS recurrenceId, pattern FROM recurrence_aliases`,
  })
  const findLinks = SqlSchema.findAll({
    Request: Schema.Void,
    Result: LinkRow,
    execute: () => sql`
      SELECT key, recurrence_id AS recurrenceId, expected_date AS expectedDate, decision, origin, revision
      FROM recurrence_link_decisions ORDER BY revision
    `,
  })
  // The entries now holding the observations each verdict's entry had.
  const findHolders = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ key: Schema.String, entryId: Schema.String }),
    execute: () => sql`
      SELECT DISTINCT p.key, e.id AS entryId
      FROM recurrence_link_endpoints p
      LEFT JOIN entry_evidence v ON v.source_id = p.source_id AND v.account_id = p.account_id
        AND v.external_id = p.external_id
      LEFT JOIN entry_identity i ON i.source_id = p.source_id AND i.account_id = p.account_id
        AND i.external_id = p.external_id
      JOIN ledger_entries e ON e.id = coalesce(v.entry_id, i.entry_id)
    `,
  })
  const findOccurrenceDecisions = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      recurrenceId: Schema.String,
      expectedDate: Schema.String,
      decision: Schema.Literals(['skipped', 'completed']),
    }),
    execute: () => sql`
      SELECT recurrence_id AS recurrenceId, expected_date AS expectedDate, decision
      FROM recurrence_occurrence_decisions
    `,
  })
  const findIgnores = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({
      signature: Schema.String,
      direction: Schema.String,
    }),
    execute: () =>
      sql`SELECT signature, direction FROM recurrence_detection_ignores`,
  })
  const findGroups = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ id: Schema.String, name: Schema.String }),
    execute: () =>
      sql`SELECT id, name FROM recurrence_groups ORDER BY name_key`,
  })

  /** Each verdict on the one entry that holds it now; split or vanished ones wait. */
  const verdicts = Effect.gen(function* () {
    const holders = new Map<string, Set<string>>()
    for (const row of yield* findHolders(undefined)) {
      const set = holders.get(row.key) ?? new Set<string>()
      set.add(row.entryId)
      holders.set(row.key, set)
    }
    return (yield* findLinks(undefined)).flatMap((row) => {
      const held = [...(holders.get(row.key) ?? [])]
      return held.length === 1
        ? [{ ...row, entryId: held[0]! } satisfies LinkVerdict]
        : []
    })
  })

  const rules = Effect.gen(function* () {
    const aliases = new Map<string, Array<string>>()
    for (const row of yield* findAliases(undefined)) {
      const list = aliases.get(row.recurrenceId) ?? []
      list.push(row.pattern)
      aliases.set(row.recurrenceId, list)
    }
    return (yield* findRules(undefined)).map((row) => ({
      row,
      rule: {
        ...row,
        importedAliases: aliases.get(row.id) ?? [],
      } satisfies RecurrenceRule,
    }))
  })

  /**
   * The book as of today. Callers that already read the ledger pass its
   * entries and relations so one read serves both.
   */
  const load = Effect.fn('Recurrences.load')(function* (ledger?: {
    readonly entries: ReadonlyArray<PlanningEntry>
    readonly relations: ReadonlyArray<MonthRelation>
  }) {
    const day = yield* today
    const entries = yield* reads.recurrenceEntries(
      ledger?.entries,
      ledger?.relations,
    )
    const ruleRows = yield* rules
    const links = yield* verdicts
    const occurrenceDecisions: ReadonlyArray<OccurrenceVerdict> =
      yield* findOccurrenceDecisions(undefined)
    const book = buildBook({
      today: day,
      rules: ruleRows.map(({ rule }) => rule),
      entries,
      links,
      occurrenceDecisions,
    })
    return { today: day, entries, ruleRows, links, book }
  })

  const summarize = (
    entry: RecurrenceEntry,
    accountNames: ReadonlyMap<string, string>,
  ): EntrySummary => ({
    id: entry.id,
    accountId: entry.accountId,
    accountName: accountNames.get(entry.accountId) ?? '',
    bookedOn: entry.bookedOn,
    description: entry.description,
    amountCents: entry.amountCents,
    currency: entry.currency,
    categoryId: entry.categoryId,
  })

  /** Every recurrence with its occurrences and matches, and the groups. */
  const view = Effect.fn('Recurrences.view')(function* () {
    const { entries, ruleRows, book } = yield* load()
    const accountNames = new Map(
      (yield* reads.accounts).map((account) => [account.id, account.name]),
    )
    const entryById = new Map(entries.map((entry) => [entry.id, entry]))
    const rowById = new Map(ruleRows.map(({ row }) => [row.id, row]))
    const day = yield* today
    const latest = yield* exchangeRates.on(
      book.map(({ rule }) => rule.currency),
      day,
    )
    const rates = rateTable(
      [...latest].map(([currency, rate]) => ({ currency, ...rate })),
    )
    const recurrences = book.map((recurrence): RecurrenceView => {
      const row = rowById.get(recurrence.rule.id)!
      const overdue = new Set(
        recurrence.overdue.map((occurrence) => occurrence.id),
      )
      return {
        id: row.id,
        name: row.name,
        groupId: row.groupId,
        participantLabel: row.participantLabel,
        accountId: row.accountId,
        categoryId: row.categoryId,
        amountCents: row.amountCents,
        currency: row.currency,
        direction: row.direction,
        amountMode: row.amountMode,
        matchMode: row.matchMode,
        destinationMode: row.destinationMode,
        frequency: row.frequency,
        startsOn: row.startsOn,
        scheduleAnchor: row.scheduleAnchor,
        nextDate: recurrence.nextDate,
        active: row.active,
        converted:
          convert(rates, row.amountCents, row.currency, day)?.converted ?? null,
        learnedDescriptions: recurrence.learnedDescriptions,
        occurrences: recurrence.occurrences.map((occurrence) => ({
          id: occurrence.id,
          expectedDate: occurrence.expectedDate,
          expectedAmountCents: occurrence.expectedAmountCents,
          currency: row.currency,
          status: occurrence.status,
          overdue: overdue.has(occurrence.id),
          matches: occurrence.matches.map((match) => ({
            id: match.id,
            occurrenceId: match.occurrenceId,
            entryId: match.entryId,
            status: match.status,
            score: match.score,
            reason: match.reason,
            categoryConflict: match.categoryConflict,
            entry: summarize(entryById.get(match.entryId)!, accountNames),
          })),
        })),
      }
    })
    return { groups: yield* findGroups(undefined), recurrences }
  })

  const groupId = Effect.fnUntraced(function* (
    name: string | null | undefined,
  ) {
    const trimmed = name?.trim()
    if (!trimmed) return null
    const key = foldDescription(trimmed)
    const id = yield* newId
    yield* sql`
      INSERT INTO recurrence_groups (id, name, name_key, created_at)
      VALUES (${id}, ${trimmed}, ${key}, ${yield* now})
      ON CONFLICT (name_key) DO NOTHING
    `
    const rows = yield* sql<{
      id: string
    }>`SELECT id FROM recurrence_groups WHERE name_key = ${key}`
    return rows[0]!.id
  })

  const validate = Effect.fnUntraced(function* (input: RecurrenceInput) {
    if (input.name.trim().length < 2)
      return yield* new RecurrenceError({
        reason: 'invalid_input',
        detail: 'name',
      })
    if (input.destinationMode === 'fixed' && input.accountId === null)
      return yield* new RecurrenceError({ reason: 'destination_required' })
    if (input.accountId !== null) {
      const account = (yield* reads.accounts).find(
        (found) => found.id === input.accountId,
      )
      if (!account)
        return yield* new RecurrenceError({
          reason: 'account_not_found',
          detail: input.accountId,
        })
      if (account.currency !== input.currency)
        return yield* new RecurrenceError({
          reason: 'currency_mismatch',
          detail: account.currency,
        })
    }
    const category = (yield* reads.categories).find(
      (found) => found.id === input.categoryId,
    )
    const allowed =
      input.direction === 'income' ? incomeBuckets : expenseBuckets
    if (
      !category ||
      !category.active ||
      category.system ||
      !allowed.has(category.bucket)
    )
      return yield* new RecurrenceError({
        reason: 'category_not_assignable',
        detail: input.categoryId,
      })
  })

  const changed = (recurrenceId: string, what: string) =>
    log.append([
      {
        type: recurrencesChanged,
        streamId: recurrenceId,
        payload: { recurrenceId, what },
      },
    ])

  const insertRule = Effect.fnUntraced(function* (
    input: RecurrenceInput,
    schedule: { readonly startsOn: string; readonly scheduleAnchor: string },
  ) {
    const id = yield* newId
    const group = yield* groupId(input.groupName)
    yield* sql`
      INSERT INTO recurrences (id, name, group_id, participant_label, account_id, category_id,
        amount_cents, currency, direction, amount_mode, match_mode, destination_mode, frequency,
        starts_on, schedule_anchor, created_at)
      VALUES (${id}, ${input.name.trim()}, ${group}, ${group ? input.participantLabel?.trim() || null : null},
        ${input.accountId}, ${input.categoryId}, ${input.amountCents}, ${input.currency},
        ${input.direction}, ${input.amountMode}, ${input.matchMode}, ${input.destinationMode},
        ${input.frequency}, ${schedule.startsOn}, ${schedule.scheduleAnchor}, ${yield* now})
    `
    yield* changed(id, 'created')
    return id
  })

  const create = Effect.fn('Recurrences.create')(function* (
    input: RecurrenceInput,
  ) {
    yield* validate(input)
    return yield* sql.withTransaction(
      insertRule(input, {
        startsOn: input.nextDate,
        scheduleAnchor: input.nextDate,
      }),
    )
  })

  const recurrenceOf = Effect.fnUntraced(function* (
    book: ReadonlyArray<BookRecurrence>,
    id: string,
  ) {
    const found = book.find((recurrence) => recurrence.rule.id === id)
    if (!found)
      return yield* new RecurrenceError({
        reason: 'recurrence_not_found',
        detail: id,
      })
    return found
  })

  /** Changing the next date or frequency restarts the schedule there; history stays with its verdicts. */
  const update = Effect.fn('Recurrences.update')(function* (
    id: string,
    input: RecurrenceInput,
  ) {
    yield* validate(input)
    const { book } = yield* load()
    const current = yield* recurrenceOf(book, id)
    const restart =
      input.nextDate !== current.nextDate ||
      input.frequency !== current.rule.frequency
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const group = yield* groupId(input.groupName)
        const startsOn = restart ? input.nextDate : current.rule.startsOn
        const anchor = restart ? input.nextDate : current.rule.scheduleAnchor
        yield* sql`
          UPDATE recurrences SET name = ${input.name.trim()}, group_id = ${group},
            participant_label = ${group ? input.participantLabel?.trim() || null : null},
            account_id = ${input.accountId}, category_id = ${input.categoryId},
            amount_cents = ${input.amountCents}, currency = ${input.currency},
            direction = ${input.direction}, amount_mode = ${input.amountMode},
            match_mode = ${input.matchMode}, destination_mode = ${input.destinationMode},
            frequency = ${input.frequency}, starts_on = ${startsOn}, schedule_anchor = ${anchor}
          WHERE id = ${id}
        `
        yield* changed(id, 'updated')
      }),
    )
    return id
  })

  const setActive = Effect.fn('Recurrences.setActive')(function* (
    id: string,
    active: boolean,
  ) {
    const { book } = yield* load()
    yield* recurrenceOf(book, id)
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE recurrences SET active = ${active ? 1 : 0} WHERE id = ${id}`
        yield* changed(id, active ? 'resumed' : 'paused')
      }),
    )
    return id
  })

  const remove = Effect.fn('Recurrences.remove')(function* (id: string) {
    const { book, links } = yield* load()
    yield* recurrenceOf(book, id)
    if (
      links.some(
        (link) => link.recurrenceId === id && link.decision === 'confirmed',
      )
    )
      return yield* new RecurrenceError({
        reason: 'has_confirmed_links',
        detail: id,
      })
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM recurrences WHERE id = ${id}`
        yield* changed(id, 'deleted')
      }),
    )
    return id
  })

  /**
   * Records the person's verdict on an entry for an occurrence. A verdict
   * that already covers exactly this entry is updated, so the latest one
   * wins; its observations are added, never replaced.
   */
  const writeLink = Effect.fnUntraced(function* (
    ref: MatchRef,
    decision: 'confirmed' | 'rejected',
    origin: 'person' | 'approval',
  ) {
    const existing = (yield* verdicts).filter(
      (link) =>
        link.recurrenceId === ref.recurrenceId &&
        link.expectedDate === ref.expectedDate &&
        link.entryId === ref.entryId,
    )
    const keys =
      existing.length > 0 ? existing.map((link) => link.key) : [yield* newId]
    const decidedAt = yield* now
    for (const key of keys) {
      yield* sql`
        INSERT INTO recurrence_link_decisions (key, recurrence_id, expected_date, decision, origin,
          decided_at, revision)
        VALUES (${key}, ${ref.recurrenceId}, ${ref.expectedDate}, ${decision}, ${origin}, ${decidedAt},
          (SELECT coalesce(max(revision), 0) + 1 FROM recurrence_link_decisions))
        ON CONFLICT (key) DO UPDATE SET decision = excluded.decision, origin = excluded.origin,
          decided_at = excluded.decided_at, revision = excluded.revision
      `
      yield* sql`
        INSERT OR IGNORE INTO recurrence_link_endpoints (key, source_id, account_id, external_id)
        SELECT ${key}, source_id, account_id, external_id FROM entry_evidence WHERE entry_id = ${ref.entryId}
      `
    }
  })

  /**
   * A confirmed payment carries the recurrence's category when the entry has
   * none applied yet: the person just said what it is. It goes through the
   * categorizer as their decision, after the link commits.
   */
  const categorize = Effect.fnUntraced(function* (
    rule: RecurrenceRule,
    entryIds: ReadonlyArray<string>,
  ) {
    const entries = new Map(
      (yield* reads.entries).map((entry) => [entry.id, entry]),
    )
    for (const entryId of entryIds) {
      const entry = entries.get(entryId)
      if (
        !entry ||
        entry.company ||
        entry.excludedFromSpending ||
        entry.categoryStatus === 'applied'
      )
        continue
      yield* categorizer
        .decide(entryId, rule.categoryId, { origin: 'review' })
        .pipe(Effect.catchTag('CategorizerError', () => Effect.void))
    }
  })

  const linkable = Effect.fnUntraced(function* (
    loaded: Effect.Success<ReturnType<typeof load>>,
    ref: OccurrenceRef,
    entryIds: ReadonlyArray<string>,
  ) {
    const recurrence = yield* recurrenceOf(loaded.book, ref.recurrenceId)
    if (!recurrence.rule.active)
      return yield* new RecurrenceError({ reason: 'recurrence_paused' })
    const occurrence = recurrence.occurrences.find(
      (found) => found.expectedDate === ref.expectedDate,
    )
    if (!occurrence)
      return yield* new RecurrenceError({
        reason: 'occurrence_not_found',
        detail: ref.expectedDate,
      })
    if (occurrence.status !== 'expected')
      return yield* new RecurrenceError({ reason: 'occurrence_resolved' })
    if (recurrence.rule.matchMode === 'single' && entryIds.length !== 1)
      return yield* new RecurrenceError({ reason: 'single_payment' })
    const entryById = new Map(loaded.entries.map((entry) => [entry.id, entry]))
    const sign = recurrence.rule.direction === 'expense' ? -1 : 1
    for (const entryId of entryIds) {
      const entry = entryById.get(entryId)
      if (!entry)
        return yield* new RecurrenceError({
          reason: 'entry_not_found',
          detail: entryId,
        })
      if (
        !eligible(entry) ||
        entry.currency !== recurrence.rule.currency ||
        Math.sign(entry.amountCents) !== sign
      )
        return yield* new RecurrenceError({
          reason: 'entry_not_linkable',
          detail: entryId,
        })
      const elsewhere = loaded.links.some(
        (link) =>
          link.entryId === entryId &&
          link.decision === 'confirmed' &&
          occurrenceId(link.recurrenceId, link.expectedDate) !== occurrence.id,
      )
      if (elsewhere)
        return yield* new RecurrenceError({
          reason: 'already_linked',
          detail: entryId,
        })
    }
    return recurrence
  })

  /** Links entries the person chose to an occurrence; a single-payment occurrence takes one. */
  const link = Effect.fn('Recurrences.link')(function* (
    ref: OccurrenceRef,
    entryIds: ReadonlyArray<string>,
  ) {
    const unique = [...new Set(entryIds)]
    const recurrence = yield* linkable(yield* load(), ref, unique)
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const entryId of unique)
          yield* writeLink({ ...ref, entryId }, 'confirmed', 'person')
        yield* changed(ref.recurrenceId, 'linked')
      }),
    )
    yield* categorize(recurrence.rule, unique)
    return unique.length
  })

  const matchOf = Effect.fnUntraced(function* (
    book: ReadonlyArray<BookRecurrence>,
    ref: MatchRef,
  ) {
    const recurrence = yield* recurrenceOf(book, ref.recurrenceId)
    const match = recurrence.occurrences
      .find((occurrence) => occurrence.expectedDate === ref.expectedDate)
      ?.matches.find((found) => found.entryId === ref.entryId)
    if (!match) return yield* new RecurrenceError({ reason: 'match_not_found' })
    return { recurrence, match }
  })

  /** Accepts a suggested match as the person's link. */
  const confirm = Effect.fn('Recurrences.confirm')(function* (ref: MatchRef) {
    const loaded = yield* load()
    const { match } = yield* matchOf(loaded.book, ref)
    if (match.status !== 'suggested')
      return yield* new RecurrenceError({ reason: 'occurrence_resolved' })
    const recurrence = yield* linkable(loaded, ref, [ref.entryId])
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* writeLink(ref, 'confirmed', 'person')
        yield* changed(ref.recurrenceId, 'confirmed')
      }),
    )
    yield* categorize(recurrence.rule, [ref.entryId])
  })

  /** The entry is not this occurrence's payment: never suggested for it again. */
  const reject = Effect.fn('Recurrences.reject')(function* (ref: MatchRef) {
    yield* matchOf((yield* load()).book, ref)
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* writeLink(ref, 'rejected', 'person')
        yield* changed(ref.recurrenceId, 'rejected')
      }),
    )
  })

  /** Undoes a confirmed or automatic match; the pair stays rejected, and the occurrence reopens. */
  const unlink = Effect.fn('Recurrences.unlink')(function* (ref: MatchRef) {
    const { match } = yield* matchOf((yield* load()).book, ref)
    if (match.status === 'suggested')
      return yield* new RecurrenceError({ reason: 'match_not_found' })
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* writeLink(ref, 'rejected', 'person')
        yield* changed(ref.recurrenceId, 'unlinked')
      }),
    )
  })

  const decideOccurrence = Effect.fnUntraced(function* (
    ref: OccurrenceRef,
    decision: 'skipped' | 'completed',
  ) {
    yield* sql`
      INSERT INTO recurrence_occurrence_decisions (recurrence_id, expected_date, decision, decided_at)
      VALUES (${ref.recurrenceId}, ${ref.expectedDate}, ${decision}, ${yield* now})
      ON CONFLICT (recurrence_id, expected_date) DO UPDATE SET decision = excluded.decision,
        decided_at = excluded.decided_at
    `
  })

  const openOccurrence = Effect.fnUntraced(function* (ref: OccurrenceRef) {
    const recurrence = yield* recurrenceOf(
      (yield* load()).book,
      ref.recurrenceId,
    )
    const occurrence = recurrence.occurrences.find(
      (found) => found.expectedDate === ref.expectedDate,
    )
    if (!occurrence)
      return yield* new RecurrenceError({
        reason: 'occurrence_not_found',
        detail: ref.expectedDate,
      })
    if (occurrence.status !== 'expected')
      return yield* new RecurrenceError({ reason: 'occurrence_resolved' })
    return { recurrence, occurrence }
  })

  /** The person says this occurrence will not happen. */
  const skip = Effect.fn('Recurrences.skip')(function* (ref: OccurrenceRef) {
    yield* openOccurrence(ref)
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* decideOccurrence(ref, 'skipped')
        yield* changed(ref.recurrenceId, 'skipped')
      }),
    )
  })

  /** Closes an envelope period with what was linked so far. */
  const complete = Effect.fn('Recurrences.complete')(function* (
    ref: OccurrenceRef,
  ) {
    const { occurrence } = yield* openOccurrence(ref)
    if (!occurrence.matches.some((match) => match.status !== 'suggested'))
      return yield* new RecurrenceError({ reason: 'nothing_linked' })
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* decideOccurrence(ref, 'completed')
        yield* changed(ref.recurrenceId, 'completed')
      }),
    )
  })

  /** Candidates detection offers, without the ones the person ignored. */
  const detected = Effect.fn('Recurrences.detected')(function* () {
    const { today: day, entries, book } = yield* load()
    const ignored = new Set(
      (yield* findIgnores(undefined)).map(
        (row) => `${row.signature}|${row.direction}`,
      ),
    )
    return detect({
      today: day,
      entries,
      excluded: new Set(acceptedEntries(book).keys()),
      known: knownSignatures(book),
      ignored,
    })
  })

  const ignore = Effect.fn('Recurrences.ignore')(function* (input: {
    readonly signature: string
    readonly direction: 'income' | 'expense'
  }) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO recurrence_detection_ignores (signature, direction, decided_at)
          VALUES (${input.signature}, ${input.direction}, ${yield* now})
          ON CONFLICT (signature, direction) DO NOTHING
        `
        yield* log.append([
          {
            type: recurrencesChanged,
            streamId: 'detection',
            payload: { ignored: input.signature },
          },
        ])
      }),
    )
  })

  /**
   * Turns a detected candidate into a recurrence: its earlier payments are
   * linked as the person's verdicts and past occurrences without one are
   * skipped, all in one step.
   */
  const approve = Effect.fn('Recurrences.approve')(function* (
    input: ApprovalInput,
  ) {
    const loaded = yield* load()
    const accepted = acceptedEntries(loaded.book)
    const entryById = new Map(loaded.entries.map((entry) => [entry.id, entry]))
    const sign = input.direction === 'expense' ? -1 : 1
    const available = [...new Set(input.entryIds)].flatMap((id) => {
      const entry = entryById.get(id)
      return entry &&
        eligible(entry) &&
        entry.currency === input.currency &&
        Math.sign(entry.amountCents) === sign &&
        !accepted.has(id)
        ? [entry]
        : []
    })
    if (available.length === 0)
      return yield* new RecurrenceError({ reason: 'nothing_linked' })
    const recurrenceInput: RecurrenceInput = {
      name: input.name,
      accountId: input.accountId,
      categoryId: input.categoryId,
      amountCents: input.amountCents,
      currency: input.currency,
      direction: input.direction,
      amountMode: input.amountMode,
      matchMode: 'single',
      destinationMode: 'automatic',
      frequency: input.frequency,
      nextDate: input.nextDate,
    }
    yield* validate(recurrenceInput)
    const plan = planApproval({
      nextDate: input.nextDate,
      frequency: input.frequency,
      today: loaded.today,
      entries: available,
    })
    const id = yield* sql.withTransaction(
      Effect.gen(function* () {
        const created = yield* insertRule(recurrenceInput, plan)
        for (const linkPlan of plan.links)
          yield* writeLink(
            {
              recurrenceId: created,
              expectedDate: linkPlan.expectedDate,
              entryId: linkPlan.entryId,
            },
            'confirmed',
            'approval',
          )
        for (const date of plan.skipped)
          yield* decideOccurrence(
            { recurrenceId: created, expectedDate: date },
            'skipped',
          )
        return created
      }),
    )
    const rule = (yield* rules).find(({ rule }) => rule.id === id)!.rule
    yield* categorize(
      rule,
      plan.links.map((linkPlan) => linkPlan.entryId),
    )
    return { id, linked: plan.links.length }
  })

  /** Entries the person may link to an occurrence by hand. */
  const candidates = Effect.fn('Recurrences.candidates')(function* (
    ref: OccurrenceRef,
  ) {
    const loaded = yield* load()
    const recurrence = yield* recurrenceOf(loaded.book, ref.recurrenceId)
    const occurrence = recurrence.occurrences.find(
      (found) => found.expectedDate === ref.expectedDate,
    )
    if (!occurrence)
      return yield* new RecurrenceError({
        reason: 'occurrence_not_found',
        detail: ref.expectedDate,
      })
    const accountNames = new Map(
      (yield* reads.accounts).map((account) => [account.id, account.name]),
    )
    const entryById = new Map(loaded.entries.map((entry) => [entry.id, entry]))
    const taken = new Set(
      [...acceptedEntries(loaded.book)]
        .filter(([, owner]) => owner.occurrence.id !== occurrence.id)
        .map(([entryId]) => entryId),
    )
    return linkCandidates({
      rule: recurrence.rule,
      expectedDate: ref.expectedDate,
      entries: loaded.entries,
      taken,
    }).map((candidate) => ({
      ...candidate,
      entry: summarize(entryById.get(candidate.entryId)!, accountNames),
    }))
  })

  return {
    load,
    view,
    create,
    update,
    setActive,
    remove,
    link,
    confirm,
    reject,
    unlink,
    skip,
    complete,
    detected,
    ignore,
    approve,
    candidates,
  }
})

export class Recurrences extends Context.Service<
  Recurrences,
  Effect.Success<typeof make>
>()('@spendle/server/planning/Recurrences') {
  static readonly layer = Layer.effect(Recurrences, make)
}
