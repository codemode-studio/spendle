import { assert, describe, it } from '@effect/vitest'

import { assignment, problemShapes } from '../domain/Assignment.ts'
import { addDays, daysBetween } from '../domain/LocalDate.ts'
import {
  balanceProof,
  pairings,
  proveBalances,
  resolveEntries,
} from './Resolution.ts'
import type { ObservedTransaction } from './Resolution.ts'

let sequence = 0
const observed = (
  fields: Partial<ObservedTransaction> & Pick<ObservedTransaction, 'sourceId'>,
): ObservedTransaction => {
  sequence++
  return {
    anchorId: `obs-${String(sequence).padStart(3, '0')}`,
    sequence,
    externalId: `ext-${sequence}`,
    bookedOn: '2026-09-10',
    amountCents: -10000,
    description: 'Padaria São João',
    status: 'posted',
    previousEntryId: null,
    coverage: null,
    fileTransactionId: null,
    ...fields,
  }
}

const groups = (observations: ReadonlyArray<ObservedTransaction>) =>
  resolveEntries(observations).map((entry) =>
    entry.evidence.map((evidence) => evidence.anchorId),
  )

describe('resolveEntries', () => {
  it('merges the same movement reported by two sources a few days apart', () => {
    const pluggy = observed({
      sourceId: 'pluggy',
      description: 'PAG*Padaria Sao Joao',
    })
    const file = observed({
      sourceId: 'file',
      bookedOn: '2026-09-12',
      description: 'PADARIA SAO JOAO LTDA',
    })
    assert.deepStrictEqual(groups([pluggy, file]), [
      [pluggy.anchorId, file.anchorId],
    ])
  })

  it('keeps unrelated purchases of the same amount apart', () => {
    const bakery = observed({
      sourceId: 'sept',
      bookedOn: '2026-09-30',
      description: 'Padaria',
    })
    const pharmacy = observed({
      sourceId: 'oct',
      bookedOn: '2026-10-01',
      description: 'Drogaria',
    })
    assert.strictEqual(groups([bakery, pharmacy]).length, 2)
  })

  it('accepts a same-day match without shared words only when nothing else competes', () => {
    const card = observed({ sourceId: 'pluggy', description: 'PAG*XYZ 123' })
    const file = observed({ sourceId: 'file', description: 'COMPRA CARTAO' })
    assert.strictEqual(groups([card, file]).length, 1)

    const a = observed({ sourceId: 'pluggy', description: 'PAG*XYZ' })
    const b = observed({ sourceId: 'pluggy', description: 'PAG*ABC' })
    const c = observed({ sourceId: 'file', description: 'COMPRA CARTAO' })
    assert.strictEqual(groups([a, b, c]).length, 3)
  })

  it('never lets a group span more than the window', () => {
    const first = observed({ sourceId: 'a', bookedOn: '2026-09-01' })
    const second = observed({ sourceId: 'b', bookedOn: '2026-09-04' })
    const third = observed({ sourceId: 'c', bookedOn: '2026-09-07' })
    assert.deepStrictEqual(groups([first, second, third]), [
      [first.anchorId, second.anchorId],
      [third.anchorId],
    ])
  })

  it('pairs a whole batch so no movement is counted twice', () => {
    const a10 = observed({ sourceId: 'a', bookedOn: '2026-09-10' })
    const a13 = observed({ sourceId: 'a', bookedOn: '2026-09-13' })
    const b11 = observed({ sourceId: 'b', bookedOn: '2026-09-11' })
    const b09 = observed({ sourceId: 'b', bookedOn: '2026-09-09' })
    const result = groups([a10, a13, b11, b09])
    assert.strictEqual(result.length, 2)
    assert.isTrue(result.every((group) => group.length === 2))
  })

  it('keeps identical lines from one source apart and pairs them across sources', () => {
    const coffee = { amountCents: -500, description: 'Café Central' }
    const fileA = observed({ sourceId: 'file', ...coffee })
    const fileB = observed({ sourceId: 'file', ...coffee })
    const pluggyA = observed({ sourceId: 'pluggy', ...coffee })
    const pluggyB = observed({ sourceId: 'pluggy', ...coffee })
    const result = groups([fileA, fileB, pluggyA, pluggyB])
    assert.deepStrictEqual(
      result.map((group) => group.length),
      [2, 2],
    )
  })

  it('lets a posted report speak for an entry first seen as pending', () => {
    const pending = observed({
      sourceId: 'pluggy',
      status: 'pending',
      bookedOn: '2026-09-09',
    })
    const posted = observed({
      sourceId: 'file',
      bookedOn: '2026-09-10',
      description: 'PADARIA SAO JOAO',
    })
    const [entry] = resolveEntries([pending, posted])
    assert.deepStrictEqual(
      [entry?.id, entry?.status, entry?.bookedOn],
      [pending.anchorId, 'posted', '2026-09-10'],
    )
  })

  it('keeps the entry id after its first observation is removed', () => {
    const pending = observed({ sourceId: 'pluggy', status: 'pending' })
    const file = observed({ sourceId: 'file' })
    const [first] = resolveEntries([pending, file])
    const [after] = resolveEntries([{ ...file, previousEntryId: first!.id }])
    assert.strictEqual(after?.id, first?.id)
  })

  it('keeps equal purchases apart when each statement covers only its own date', () => {
    const purchase = { amountCents: -1000, description: 'PADARIA CENTRAL' }
    const september = observed({
      sourceId: 'sept',
      coverage: { start: '2026-09-01', end: '2026-09-30' },
      bookedOn: '2026-09-30',
      ...purchase,
    })
    const october = observed({
      sourceId: 'oct',
      coverage: { start: '2026-10-01', end: '2026-10-31' },
      bookedOn: '2026-10-01',
      ...purchase,
    })
    assert.strictEqual(groups([september, october]).length, 2)

    // Statements that both cover both dates may still date one movement apart.
    const early = observed({
      sourceId: 'early',
      coverage: { start: '2026-09-01', end: '2026-10-15' },
      bookedOn: '2026-09-30',
      ...purchase,
    })
    const late = observed({
      sourceId: 'late',
      coverage: { start: '2026-09-15', end: '2026-10-31' },
      bookedOn: '2026-10-01',
      ...purchase,
    })
    assert.strictEqual(groups([early, late]).length, 1)
  })

  it('keeps same-day reports apart when they name different payees', () => {
    const bakery = observed({ sourceId: 'pluggy', description: 'Padaria' })
    const pharmacy = observed({ sourceId: 'file', description: 'Drogaria' })
    assert.strictEqual(groups([bakery, pharmacy]).length, 2)
  })

  it('pairs each source as a whole even when another source reports in between', () => {
    const a10 = observed({ sourceId: 'a', bookedOn: '2026-09-10' })
    const a13 = observed({ sourceId: 'a', bookedOn: '2026-09-13' })
    const b11 = observed({ sourceId: 'b', bookedOn: '2026-09-11' })
    const c20 = observed({
      sourceId: 'c',
      bookedOn: '2026-09-20',
      amountCents: -2000,
    })
    const b09 = observed({ sourceId: 'b', bookedOn: '2026-09-09' })
    assert.deepStrictEqual(groups([a10, a13, b11, c20, b09]), [
      [a10.anchorId, b09.anchorId],
      [a13.anchorId, b11.anchorId],
      [c20.anchorId],
    ])
  })

  it('never gives two entries the same id when remembered ids collide', () => {
    // A and B once formed the entry with B's id; A's amount changed and they split.
    const a = observed({
      sourceId: 'pluggy',
      status: 'pending',
      amountCents: -12000,
      previousEntryId: 'obs-b',
    })
    const b = observed({
      sourceId: 'file',
      anchorId: 'obs-b',
      previousEntryId: 'obs-b',
    })
    const first = resolveEntries([a, b])
    const ids = first.map((entry) => entry.id)
    assert.deepStrictEqual([...ids].sort(), ['obs-b', 'obs-b~1'])

    // The next resolution keeps both.
    const entryOf = (observation: ObservedTransaction) =>
      first.find((entry) => entry.evidence.includes(observation))!.id
    const again = resolveEntries(
      [a, b].map((observation) => ({
        ...observation,
        previousEntryId: entryOf(observation),
      })),
    ).map((entry) => entry.id)
    assert.deepStrictEqual(again, ids)
  })

  it('poses only reachable entries to the pairing, however long the history', () => {
    const history = Array.from({ length: 2000 }, (_, day) =>
      observed({ sourceId: 'file', bookedOn: addDays('2021-01-01', day) }),
    )
    const incoming = observed({ sourceId: 'pluggy', bookedOn: '2023-06-01' })
    const entries = history.map((observation) => ({
      evidence: [observation],
    }))
    // Only the entries within the window of the incoming report.
    assert.deepStrictEqual(problemShapes(pairings([[incoming]], entries)), [
      [1, 2 * 3 + 1],
    ])
    const merged = resolveEntries([...history, incoming]).filter(
      (entry) => entry.evidence.length > 1,
    )
    assert.deepStrictEqual(
      merged.map((entry) => entry.bookedOn),
      ['2023-06-01'],
    )
  })

  it('regroups earlier pairs when a later source can complete more movements', () => {
    // Two R$10 debits in three overlapping statements: {A2, B3, C1} and {A3, B5, C6}.
    const debit = { amountCents: -1000 }
    const a2 = observed({ sourceId: 'a', bookedOn: '2026-09-02', ...debit })
    const a3 = observed({ sourceId: 'a', bookedOn: '2026-09-03', ...debit })
    const b3 = observed({ sourceId: 'b', bookedOn: '2026-09-03', ...debit })
    const b5 = observed({ sourceId: 'b', bookedOn: '2026-09-05', ...debit })
    const c1 = observed({ sourceId: 'c', bookedOn: '2026-09-01', ...debit })
    const c6 = observed({ sourceId: 'c', bookedOn: '2026-09-06', ...debit })
    assert.deepStrictEqual(groups([a2, a3, b3, b5, c1, c6]), [
      [a2.anchorId, b3.anchorId, c1.anchorId],
      [a3.anchorId, b5.anchorId, c6.anchorId],
    ])
  })

  it('regroups a whole run of movements when no pair or triple can repair it', () => {
    // Four R$10 bakery debits: Pluggy dates them 6-9 Sep; two September
    // exports without FITIDs date them 4/5/7/10 and 3/4/9/10.
    const debit = { amountCents: -1000, description: 'Padaria Central' }
    const september = { start: '2026-09-01', end: '2026-09-30' }
    const day = (n: number) => `2026-09-${String(n).padStart(2, '0')}`
    const report = (sourceId: string, n: number) =>
      observed({
        sourceId,
        bookedOn: day(n),
        coverage: sourceId === 'pluggy' ? null : september,
        ...debit,
      })
    const pluggy = [6, 7, 8, 9].map((n) => report('pluggy', n))
    const fileA = [4, 5, 7, 10].map((n) => report('a', n))
    const fileB = [3, 4, 9, 10].map((n) => report('b', n))
    const observations = [...pluggy, ...fileA, ...fileB]
    // Four movements, each reported once by every source within the window.
    const resolved = resolveEntries(observations)
    assert.strictEqual(resolved.length, 4)
    for (const entry of resolved) {
      const dates = entry.evidence.map((evidence) => evidence.bookedOn).sort()
      assert.deepStrictEqual(
        entry.evidence.map((evidence) => evidence.sourceId).sort(),
        ['a', 'b', 'pluggy'],
      )
      assert.isAtMost(daysBetween(dates[0]!, dates.at(-1)!), 3)
    }
    // Whatever order the observations come in.
    assert.deepStrictEqual(
      groups([...observations].reverse()),
      groups(observations),
    )
  })

  it('finds the fewest movements in a dense run of equal debits', () => {
    // 80 equal debits a day for two days, each reported by three sources
    // that date it a day apart: 160 movements, 480 reports.
    const debit = { amountCents: -1000, description: 'Padaria Central' }
    const days = ['2026-09-10', '2026-09-11']
    const observations = ['a', 'b', 'c'].flatMap((sourceId, shift) =>
      days.flatMap((day) =>
        Array.from({ length: 80 }, () =>
          observed({ sourceId, bookedOn: addDays(day, shift), ...debit }),
        ),
      ),
    )
    const resolved = resolveEntries(observations)
    assert.strictEqual(resolved.length, 160)
    assert.isTrue(resolved.every((entry) => entry.evidence.length === 3))
  })

  it('keeps equal same-day debits with unrelated payees apart in three sources', () => {
    // 80 equal debits on one day from each of three sources, every payee
    // named differently: nothing ties any two reports to one movement.
    const observations = ['a', 'b', 'c'].flatMap((sourceId) =>
      Array.from({ length: 80 }, (_, n) =>
        observed({
          sourceId,
          amountCents: -1000,
          description: `Pix enviado ${sourceId}${String(n).padStart(3, '0')}`,
        }),
      ),
    )
    const resolved = resolveEntries(observations)
    assert.strictEqual(resolved.length, 240)
    assert.isTrue(resolved.every((entry) => entry.evidence.length === 1))
  })

  it('pairs two continuous daily histories without a history-sized problem', () => {
    const days = 4000
    const daily = (sourceId: string) =>
      Array.from({ length: days }, (_, day) =>
        observed({ sourceId, bookedOn: addDays('2015-01-01', day) }),
      )
    const file = daily('file')
    const pluggy = daily('pluggy')
    const edges = pairings(
      pluggy.map((observation) => [observation]),
      file.map((observation) => ({ evidence: [observation] })),
    )
    assert.strictEqual(edges.length, days * 7 - 12)
    // Sparse work: a few steps per allowed pair, not rows × columns.
    assert.isAtMost(assignment(edges).steps, 4 * edges.length)

    const resolved = resolveEntries([...file, ...pluggy])
    assert.strictEqual(resolved.length, days)
    assert.isTrue(
      resolved.every(
        (entry) =>
          entry.evidence.length === 2 &&
          entry.evidence[0]!.bookedOn === entry.evidence[1]!.bookedOn,
      ),
    )
  })

  it('pairs reports the files identify as one transaction before similar descriptions', () => {
    const renamed = observed({
      sourceId: 'export-a',
      description: 'Amazon Marketplace',
      fileTransactionId: 'id:T-77',
    })
    const lookalike = observed({
      sourceId: 'export-a',
      description: 'AMZN Prime',
      fileTransactionId: 'id:T-78',
    })
    const later = observed({
      sourceId: 'export-b',
      description: 'AMZN Mktp',
      fileTransactionId: 'id:T-77',
    })
    assert.deepStrictEqual(groups([renamed, lookalike, later]), [
      [renamed.anchorId, later.anchorId],
      [lookalike.anchorId],
    ])
  })

  it('keeps lines two files identify as one together over an earlier pairing', () => {
    // Pluggy dates two equal debits on the 1st and 2nd; two overlapping
    // exports give them FITIDs T-0 and T-1 and date them differently.
    const debit = { amountCents: -1000, description: 'Padaria Central' }
    const p0 = observed({
      sourceId: 'pluggy',
      bookedOn: '2026-09-01',
      ...debit,
    })
    const p1 = observed({
      sourceId: 'pluggy',
      bookedOn: '2026-09-02',
      ...debit,
    })
    const line = (sourceId: string, bookedOn: string, fitid: string) =>
      observed({ sourceId, bookedOn, fileTransactionId: fitid, ...debit })
    const a0 = line('a', '2026-09-02', 'id:T-0')
    const a1 = line('a', '2026-09-02', 'id:T-1')
    const b0 = line('b', '2026-09-01', 'id:T-0')
    const b1 = line('b', '2026-09-05', 'id:T-1')
    assert.deepStrictEqual(groups([p0, p1, a0, a1, b0, b1]), [
      [p0.anchorId, a0.anchorId, b0.anchorId],
      [p1.anchorId, a1.anchorId, b1.anchorId],
    ])
    // Pluggy arriving after the files joins the same movements.
    const late = [p0, p1].map((report) =>
      observed({ sourceId: 'pluggy', bookedOn: report.bookedOn, ...debit }),
    )
    assert.deepStrictEqual(groups([a0, a1, b0, b1, ...late]), [
      [a0.anchorId, b0.anchorId, late[0]!.anchorId],
      [a1.anchorId, b1.anchorId, late[1]!.anchorId],
    ])
  })

  it('never puts lines with different file transaction ids in one entry', () => {
    // The descriptions agree and the dates fit, but the files say these are two movements.
    const a = observed({ sourceId: 'a', fileTransactionId: 'id:T-1' })
    const b = observed({ sourceId: 'b', fileTransactionId: 'id:T-2' })
    assert.deepStrictEqual(groups([a, b]), [[a.anchorId], [b.anchorId]])
  })

  it('depends only on what was observed, not on input order', () => {
    const observations = [
      observed({ sourceId: 'file' }),
      observed({ sourceId: 'pluggy', bookedOn: '2026-09-11' }),
      observed({
        sourceId: 'file',
        amountCents: -2000,
        description: 'Mercado',
      }),
      observed({
        sourceId: 'pluggy',
        amountCents: -2000,
        bookedOn: '2026-09-12',
        description: 'Mercado',
      }),
    ]
    assert.deepStrictEqual(
      groups([...observations].reverse()),
      groups(observations),
    )
  })
})

describe('proveBalances', () => {
  const entry = (
    bookedOn: string,
    amountCents: number,
    status: 'pending' | 'posted' = 'posted',
  ) => ({
    bookedOn,
    amountCents,
    status,
    evidence: [],
  })

  it('proves an interval whose posted entries explain the balance change', () => {
    const intervals = proveBalances(
      [
        entry('2026-09-05', 1000_00),
        entry('2026-09-30', -100_00),
        entry('2026-09-30', -1, 'pending'),
      ],
      [
        { asOf: '2026-09-30', balanceCents: 900_00, sourceId: 'file' },
        { asOf: '2026-09-01', balanceCents: 0, sourceId: 'file' },
      ],
    )
    assert.deepStrictEqual(intervals, [
      {
        from: '2026-09-01',
        to: '2026-09-30',
        expectedChangeCents: 900_00,
        postedChangeCents: 900_00,
        differenceCents: 0,
      },
    ])
  })

  it('places an entry by the date the checkpoint source gave it', () => {
    // The statement books a credit on 30 September; Pluggy says 1 October.
    const credit = {
      bookedOn: '2026-10-01',
      amountCents: 100_00,
      status: 'posted' as const,
      evidence: [
        {
          sourceId: 'pluggy',
          bookedOn: '2026-10-01',
          status: 'posted' as const,
        },
        {
          sourceId: 'statement',
          bookedOn: '2026-09-30',
          status: 'posted' as const,
        },
      ],
    }
    const [interval] = proveBalances(
      [credit],
      [
        { asOf: '2026-09-30', balanceCents: 1000_00, sourceId: 'statement' },
        { asOf: '2026-10-03', balanceCents: 1000_00, sourceId: 'pluggy' },
      ],
    )
    assert.strictEqual(interval?.differenceCents, 0)
  })

  it('dates an entry by its posted report, not by a pending one from the checkpoint source', () => {
    // Pluggy saw a hold on 1 October; the statement shows it posted on the 3rd.
    const debit = {
      bookedOn: '2026-10-03',
      amountCents: -10_00,
      status: 'posted' as const,
      evidence: [
        {
          sourceId: 'pluggy',
          bookedOn: '2026-10-01',
          status: 'pending' as const,
        },
        { sourceId: 'file', bookedOn: '2026-10-03', status: 'posted' as const },
      ],
    }
    const [interval] = proveBalances(
      [debit],
      [
        { asOf: '2026-10-02', balanceCents: 1000_00, sourceId: 'pluggy' },
        { asOf: '2026-10-03', balanceCents: 990_00, sourceId: 'file' },
      ],
    )
    assert.strictEqual(interval?.differenceCents, 0)
  })

  it('counts a movement once across intervals whose sources date it differently', () => {
    const credit = {
      bookedOn: '2026-09-30',
      amountCents: 10_00,
      status: 'posted' as const,
      evidence: [
        { sourceId: 'file', bookedOn: '2026-09-30', status: 'posted' as const },
        {
          sourceId: 'pluggy',
          bookedOn: '2026-10-02',
          status: 'posted' as const,
        },
      ],
    }
    const intervals = proveBalances(
      [credit],
      [
        { asOf: '2026-09-29', balanceCents: 0, sourceId: 'file' },
        { asOf: '2026-09-30', balanceCents: 10_00, sourceId: 'file' },
        { asOf: '2026-10-01', balanceCents: 0, sourceId: 'pluggy' },
        { asOf: '2026-10-02', balanceCents: 10_00, sourceId: 'pluggy' },
      ],
    )
    assert.deepStrictEqual(
      intervals.map((interval) => [
        interval.postedChangeCents,
        interval.differenceCents,
      ]),
      [
        [10_00, 0],
        [-10_00, 0],
        [10_00, 0],
      ],
    )
  })

  it('leaves out of a source balance an entry that source still reports as pending', () => {
    // The file posts the debit on 1 October; the bank still shows it pending.
    const debit = {
      bookedOn: '2026-10-01',
      amountCents: -10_00,
      status: 'posted' as const,
      evidence: [
        { sourceId: 'file', bookedOn: '2026-10-01', status: 'posted' as const },
        {
          sourceId: 'bank',
          bookedOn: '2026-10-02',
          status: 'pending' as const,
        },
      ],
    }
    const intervals = proveBalances(
      [debit],
      [
        { asOf: '2026-09-30', balanceCents: 1000_00, sourceId: 'bank' },
        { asOf: '2026-10-01', balanceCents: 1000_00, sourceId: 'bank' },
        { asOf: '2026-10-02', balanceCents: 1000_00, sourceId: 'bank' },
      ],
    )
    assert.deepStrictEqual(
      intervals.map((interval) => interval.differenceCents),
      [0, 0],
    )
  })

  it('proves long daily histories without work growing with entries times checkpoints', () => {
    // Ten movements a day, each reported by the bank and a statement (the
    // statement a day later), and an end-of-day balance from each daily.
    const history = (days: number) => {
      const entries = []
      const checkpoints = []
      let balance = 0
      for (let day = 0; day < days; day++) {
        const date = addDays('2020-01-01', day)
        for (let n = 0; n < 10; n++) {
          const amountCents = n % 2 === 0 ? 10_00 : -7_00
          entries.push({
            bookedOn: date,
            amountCents,
            status: 'posted' as const,
            evidence: [
              { sourceId: 'bank', bookedOn: date, status: 'posted' as const },
              {
                sourceId: 'file',
                bookedOn: addDays(date, 1),
                status: 'posted' as const,
              },
            ],
          })
          balance += amountCents
        }
        checkpoints.push(
          { asOf: date, balanceCents: balance, sourceId: 'bank' },
          { asOf: addDays(date, 1), balanceCents: balance, sourceId: 'file' },
        )
      }
      return balanceProof(entries, checkpoints)
    }
    const year = history(365)
    const decade = history(3650)
    assert.isTrue(
      decade.intervals.every((interval) => interval.differenceCents === 0),
    )
    // Ten times the history: about ten times the work (plus a log factor),
    // not a hundred.
    assert.isBelow(decade.steps / year.steps, 15)
  })

  it('reports the amount a gap leaves unexplained', () => {
    const [interval] = proveBalances(
      [entry('2026-09-05', 1000_00)],
      [
        { asOf: '2026-09-01', balanceCents: 0, sourceId: 'file' },
        { asOf: '2026-09-30', balanceCents: 900_00, sourceId: 'file' },
      ],
    )
    assert.strictEqual(interval?.differenceCents, -100_00)
  })
})
