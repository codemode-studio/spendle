import { assert, describe, it } from '@effect/vitest'

import { proveBalances, resolveEntries } from './Resolution.ts'
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
        { sourceId: 'pluggy', bookedOn: '2026-10-01' },
        { sourceId: 'statement', bookedOn: '2026-09-30' },
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
