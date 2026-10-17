import { assert, describe, it } from '@effect/vitest'

import { buildBook, detect, planApproval } from './RecurrencePolicy.ts'
import type {
  LinkVerdict,
  RecurrenceEntry,
  RecurrenceRule,
} from './RecurrencePolicy.ts'
import { addPeriod } from './Schedule.ts'

const rule = (overrides: Partial<RecurrenceRule> = {}): RecurrenceRule => ({
  id: 'rent',
  name: 'Aluguel Imobiliária Lar',
  accountId: 'checking',
  categoryId: 'housing',
  amountCents: 250_000,
  currency: 'BRL',
  direction: 'expense',
  amountMode: 'fixed',
  matchMode: 'single',
  destinationMode: 'automatic',
  frequency: 'monthly',
  startsOn: '2026-06-10',
  scheduleAnchor: '2026-06-10',
  dateToleranceDays: 15,
  amountToleranceBps: 500,
  autoMatch: true,
  minimumConfirmations: 3,
  active: true,
  importedAliases: [],
  ...overrides,
})

const entry = (
  id: string,
  bookedOn: string,
  amountCents: number,
  description = 'PIX IMOBILIARIA LAR',
  overrides: Partial<RecurrenceEntry> = {},
): RecurrenceEntry => ({
  id,
  accountId: 'checking',
  bookedOn,
  amountCents,
  currency: 'BRL',
  description,
  status: 'posted',
  categoryId: null,
  internal: false,
  company: false,
  ...overrides,
})

let revision = 0
const confirmed = (expectedDate: string, entryId: string): LinkVerdict => ({
  key: `k${++revision}`,
  recurrenceId: 'rent',
  expectedDate,
  entryId,
  decision: 'confirmed',
  revision,
})

describe('schedule', () => {
  it('keeps the anchor day and clamps it to short months', () => {
    assert.deepStrictEqual(
      [
        addPeriod('2026-01-31', 'monthly', '2026-01-31'),
        addPeriod('2026-02-28', 'monthly', '2026-01-31'),
        addPeriod('2026-12-15', 'monthly'),
        addPeriod('2024-02-29', 'yearly', '2024-02-29'),
      ],
      ['2026-02-28', '2026-03-31', '2027-01-15', '2025-02-28'],
    )
  })
})

describe('recurrence book', () => {
  it('resolves an occurrence the person linked and moves the next date past it', () => {
    const [recurrence] = buildBook({
      today: '2026-07-20',
      rules: [rule()],
      entries: [
        entry('jun', '2026-06-10', -250_000),
        entry('jul', '2026-07-11', -250_000),
      ],
      links: [confirmed('2026-06-10', 'jun')],
      occurrenceDecisions: [],
    })
    assert.deepStrictEqual(
      recurrence!.occurrences.map((occurrence) => [
        occurrence.expectedDate,
        occurrence.status,
        occurrence.matches.map((match) => [match.entryId, match.status]),
      ]),
      [
        ['2026-06-10', 'matched', [['jun', 'confirmed']]],
        // One confirmation is not enough to match by itself: July waits for the person.
        ['2026-07-10', 'expected', [['jul', 'suggested']]],
      ],
    )
    assert.strictEqual(recurrence!.nextDate, '2026-07-10')
    assert.deepStrictEqual(
      recurrence!.overdue.map((o) => o.expectedDate),
      ['2026-07-10'],
    )
  })

  it('matches by itself only after enough of the person’s confirmations, never from its own matches', () => {
    const entries = [
      entry('m6', '2026-06-10', -250_000),
      entry('m7', '2026-07-10', -250_000),
      entry('m8', '2026-08-10', -250_000),
      entry('m9', '2026-09-10', -250_000),
      entry('m10', '2026-10-10', -250_000),
    ]
    const book = (links: ReadonlyArray<LinkVerdict>) =>
      buildBook({
        today: '2026-10-15',
        rules: [rule()],
        entries,
        links,
        occurrenceDecisions: [],
      })[0]!
    const twice = book([
      confirmed('2026-06-10', 'm6'),
      confirmed('2026-07-10', 'm7'),
    ])
    assert.deepStrictEqual(
      twice.occurrences.slice(2).map((o) => o.matches.map((m) => m.status)),
      [['suggested'], ['suggested'], ['suggested']],
    )
    const thrice = book([
      confirmed('2026-06-10', 'm6'),
      confirmed('2026-07-10', 'm7'),
      confirmed('2026-08-10', 'm8'),
    ])
    assert.deepStrictEqual(
      thrice.occurrences.map((o) => [
        o.expectedDate,
        o.status,
        o.matches.map((m) => m.status),
      ]),
      [
        ['2026-06-10', 'matched', ['confirmed']],
        ['2026-07-10', 'matched', ['confirmed']],
        ['2026-08-10', 'matched', ['confirmed']],
        ['2026-09-10', 'matched', ['auto_confirmed']],
        ['2026-10-10', 'matched', ['auto_confirmed']],
        ['2026-11-10', 'expected', []],
      ],
    )
    // Only the person's three links taught it.
    assert.deepStrictEqual(thrice.learnedDescriptions, ['PIX IMOBILIARIA LAR'])
  })

  it('never suggests a payment the person rejected for that occurrence', () => {
    const [recurrence] = buildBook({
      today: '2026-06-20',
      rules: [rule()],
      entries: [entry('jun', '2026-06-10', -250_000)],
      links: [{ ...confirmed('2026-06-10', 'jun'), decision: 'rejected' }],
      occurrenceDecisions: [],
    })
    assert.deepStrictEqual(recurrence!.occurrences[0]!.matches, [])
  })

  it('skips an occurrence and leaves transfers between own accounts out', () => {
    const [recurrence] = buildBook({
      today: '2026-07-20',
      rules: [rule()],
      entries: [
        entry('t', '2026-07-10', -250_000, 'TED MESMA TITULARIDADE', {
          internal: true,
        }),
      ],
      links: [],
      occurrenceDecisions: [
        {
          recurrenceId: 'rent',
          expectedDate: '2026-06-10',
          decision: 'skipped',
        },
      ],
    })
    assert.deepStrictEqual(
      recurrence!.occurrences.map((o) => [
        o.expectedDate,
        o.status,
        o.matches.length,
      ]),
      [
        ['2026-06-10', 'skipped', 0],
        ['2026-07-10', 'expected', 0],
      ],
    )
  })

  it('fills an envelope with payments in its period and closes it once the period ends', () => {
    const market = rule({
      id: 'market',
      name: 'Mercado',
      categoryId: 'groceries',
      amountCents: 100_000,
      amountMode: 'variable',
      matchMode: 'aggregate',
      startsOn: '2026-08-01',
      scheduleAnchor: '2026-08-01',
    })
    const [recurrence] = buildBook({
      today: '2026-09-05',
      rules: [market],
      entries: [
        entry('a', '2026-08-03', -30_000, 'SUPERMERCADO BOM', {
          categoryId: 'groceries',
        }),
        entry('b', '2026-08-20', -45_000, 'PADARIA', {
          categoryId: 'groceries',
        }),
        entry('c', '2026-09-02', -10_000, 'SUPERMERCADO BOM', {
          categoryId: 'groceries',
        }),
      ],
      links: [{ ...confirmed('2026-08-01', 'a'), recurrenceId: 'market' }],
      occurrenceDecisions: [],
    })
    assert.deepStrictEqual(
      recurrence!.occurrences.map((o) => [
        o.expectedDate,
        o.status,
        o.matches.map((m) => [m.entryId, m.status]),
      ]),
      [
        ['2026-08-01', 'matched', [['a', 'confirmed']]],
        [
          '2026-09-01',
          'expected',
          // A merchant the person confirmed counts by itself; the same category only suggests.
          [['c', 'auto_confirmed']],
        ],
      ],
    )
  })
})

describe('detection and approval', () => {
  it('offers a steady monthly payment and plans its approval without inventing debts', () => {
    const entries = [
      entry('a', '2026-06-05', -5_990, 'NETFLIX.COM'),
      entry('b', '2026-07-05', -5_990, 'NETFLIX.COM'),
      entry('c', '2026-08-06', -5_990, 'NETFLIX.COM'),
      entry('x', '2026-08-07', -12_000, 'LOJA QUALQUER'),
    ]
    const [found, ...rest] = detect({
      today: '2026-08-20',
      entries,
      excluded: new Set(),
      known: new Set(),
      ignored: new Set(),
    })
    assert.strictEqual(rest.length, 0)
    assert.deepStrictEqual(
      [
        found!.signature,
        found!.frequency,
        found!.amountMode,
        found!.typicalAmountCents,
        found!.nextExpectedDate,
      ],
      ['netflix com', 'monthly', 'fixed', 5_990, '2026-09-05'],
    )
    assert.deepStrictEqual(
      detect({
        today: '2026-08-20',
        entries,
        excluded: new Set(),
        known: new Set(),
        ignored: new Set(['netflix com|expense']),
      }),
      [],
    )
    const plan = planApproval({
      nextDate: '2026-09-05',
      frequency: 'monthly',
      today: '2026-08-20',
      entries: [entries[0]!, entries[2]!],
    })
    assert.deepStrictEqual(plan, {
      startsOn: '2026-06-05',
      scheduleAnchor: '2026-09-05',
      links: [
        { expectedDate: '2026-06-05', entryId: 'a' },
        { expectedDate: '2026-08-05', entryId: 'c' },
      ],
      skipped: ['2026-07-05'],
    })
  })
})
