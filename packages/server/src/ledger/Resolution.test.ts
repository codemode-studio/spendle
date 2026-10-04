import { assert, describe, it } from '@effect/vitest'

import { proveBalances, resolveEntries } from './Resolution.ts'
import type { ObservedTransaction } from './Resolution.ts'

let seen = 0
const observed = (
  fields: Partial<ObservedTransaction> & Pick<ObservedTransaction, 'sourceId'>,
) => {
  seen++
  return {
    anchorId: `obs-${String(seen).padStart(3, '0')}`,
    firstSeen: `2026-10-01T00:00:${String(seen).padStart(2, '0')}Z`,
    externalId: `ext-${seen}`,
    bookedOn: '2026-09-10',
    amountCents: -10000,
    description: 'Padaria',
    status: 'posted' as const,
    ...fields,
  }
}

const shape = (observations: ReadonlyArray<ObservedTransaction>) =>
  resolveEntries(observations).map((entry) => [
    entry.id,
    entry.evidence.map((evidence) => evidence.anchorId),
  ])

describe('resolveEntries', () => {
  it('merges the same movement reported by two sources a few days apart', () => {
    const pluggy = observed({ sourceId: 'pluggy', bookedOn: '2026-09-10' })
    const file = observed({
      sourceId: 'file',
      bookedOn: '2026-09-12',
      description: 'PADARIA SAO JOAO',
    })
    const [entry] = resolveEntries([pluggy, file])
    assert.deepStrictEqual(
      [
        resolveEntries([pluggy, file]).length,
        entry?.id,
        entry?.evidence.length,
      ],
      [1, pluggy.anchorId, 2],
    )
  })

  it('keeps identical lines from one source apart and pairs them across sources', () => {
    const coffee = { amountCents: -500, description: 'Café' }
    const fileA = observed({ sourceId: 'file', ...coffee })
    const fileB = observed({ sourceId: 'file', ...coffee })
    const pluggyA = observed({ sourceId: 'pluggy', ...coffee })
    const pluggyB = observed({ sourceId: 'pluggy', ...coffee })
    assert.deepStrictEqual(shape([fileA, fileB, pluggyA, pluggyB]), [
      [fileA.anchorId, [fileA.anchorId, pluggyA.anchorId]],
      [fileB.anchorId, [fileB.anchorId, pluggyB.anchorId]],
    ])
  })

  it('never merges different amounts or dates beyond the window', () => {
    const base = observed({ sourceId: 'pluggy', bookedOn: '2026-02-27' })
    const otherAmount = observed({
      sourceId: 'file',
      bookedOn: '2026-02-27',
      amountCents: -10001,
    })
    const tooLate = observed({ sourceId: 'file', bookedOn: '2026-03-03' })
    const inWindow = observed({ sourceId: 'file', bookedOn: '2026-03-02' })
    assert.deepStrictEqual(shape([base, otherAmount, tooLate]).length, 3)
    assert.deepStrictEqual(shape([base, inWindow]).length, 1)
  })

  it('prefers the closest date, then the most similar description', () => {
    // Candidates share a source so they stay separate entries.
    const near = observed({
      sourceId: 'a',
      bookedOn: '2026-09-10',
      description: 'Uber',
    })
    const far = observed({
      sourceId: 'a',
      bookedOn: '2026-09-08',
      description: 'Padaria',
    })
    const incoming = observed({
      sourceId: 'c',
      bookedOn: '2026-09-10',
      description: 'Padaria',
    })
    assert.deepStrictEqual(shape([near, far, incoming])[0]?.[1], [
      near.anchorId,
      incoming.anchorId,
    ])

    const uber = observed({
      sourceId: 'a',
      bookedOn: '2026-09-10',
      description: 'Uber trip',
    })
    const bakery = observed({
      sourceId: 'a',
      bookedOn: '2026-09-10',
      description: 'Padaria Sao Joao',
    })
    const report = observed({
      sourceId: 'c',
      bookedOn: '2026-09-10',
      description: 'PADARIA SÃO JOÃO',
    })
    assert.deepStrictEqual(shape([uber, bakery, report])[1]?.[1], [
      bakery.anchorId,
      report.anchorId,
    ])
  })

  it('lets a posted report speak for an entry first seen as pending', () => {
    const pending = observed({
      sourceId: 'pluggy',
      status: 'pending',
      bookedOn: '2026-09-09',
      description: 'PAG*Padaria',
    })
    const posted = observed({
      sourceId: 'file',
      bookedOn: '2026-09-10',
      description: 'Padaria São João',
    })
    const [entry] = resolveEntries([pending, posted])
    assert.deepStrictEqual(
      [entry?.id, entry?.status, entry?.bookedOn, entry?.description],
      [pending.anchorId, 'posted', '2026-09-10', 'Padaria São João'],
    )
  })

  it('depends only on what was observed, not on input order', () => {
    const observations = [
      observed({ sourceId: 'file' }),
      observed({ sourceId: 'pluggy', bookedOn: '2026-09-11' }),
      observed({ sourceId: 'file', amountCents: -2000 }),
      observed({
        sourceId: 'pluggy',
        amountCents: -2000,
        bookedOn: '2026-09-12',
      }),
    ]
    assert.deepStrictEqual(
      shape([...observations].reverse()),
      shape(observations),
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
  })

  it('proves an interval whose posted entries explain the balance change', () => {
    const intervals = proveBalances(
      [
        entry('2026-09-01', 999_00),
        entry('2026-09-05', 1000_00),
        entry('2026-09-30', -100_00),
        entry('2026-09-30', -1, 'pending'),
      ],
      [
        { asOf: '2026-09-30', balanceCents: 900_00 },
        { asOf: '2026-09-01', balanceCents: 0 },
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

  it('reports the amount a gap leaves unexplained', () => {
    const [interval] = proveBalances(
      [entry('2026-09-05', 1000_00)],
      [
        { asOf: '2026-09-01', balanceCents: 0 },
        { asOf: '2026-09-30', balanceCents: 900_00 },
      ],
    )
    assert.strictEqual(interval?.differenceCents, -100_00)
  })
})
