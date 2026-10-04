import { assert, describe, it } from '@effect/vitest'

import { followDecisions } from './Decisions.ts'
import type { StoredDecision } from './Decisions.ts'
import { relationKey } from './Matching.ts'

const stored = (
  outflowId: string,
  inflowId: string,
  fields: Partial<StoredDecision> = {},
): StoredDecision => ({
  key: relationKey('internal_transfer', outflowId, inflowId),
  decision: 'confirmed',
  revision: 1,
  outflowHolders: [outflowId],
  inflowHolders: [inflowId],
  ...fields,
})

describe('followDecisions', () => {
  it('moves a decision onto the entry its observations merged into', () => {
    const followed = followDecisions(
      [stored('out', 'gone', { inflowHolders: ['kept'] })],
      new Set(['out', 'kept']),
    )
    assert.deepStrictEqual(
      [...followed.decisions],
      [[relationKey('internal_transfer', 'out', 'kept'), 'confirmed']],
    )
  })

  it('reports a split confirmation instead of picking one entry, and rejects every part', () => {
    const entries = new Set(['out', 'part-a', 'part-b'])
    const confirmed = stored('out', 'gone', {
      inflowHolders: ['part-a', 'part-b'],
    })
    const rejected = followDecisions(
      [{ ...confirmed, decision: 'rejected' }],
      entries,
    )
    const split = followDecisions([confirmed], entries)
    assert.deepStrictEqual(
      [[...split.decisions.keys()], [...split.split], [...rejected.decisions]],
      [
        [confirmed.key],
        [confirmed.key],
        [
          [relationKey('internal_transfer', 'out', 'part-a'), 'rejected'],
          [relationKey('internal_transfer', 'out', 'part-b'), 'rejected'],
        ],
      ],
    )
  })

  it('lets the latest decision win when two end up about one pair', () => {
    const followed = followDecisions(
      [
        stored('out', 'kept', { decision: 'rejected', revision: 2 }),
        stored('out', 'gone', { inflowHolders: ['kept'] }),
      ],
      new Set(['out', 'kept']),
    )
    assert.deepStrictEqual([...followed.decisions.values()], ['rejected'])
  })
})
