import { assert, describe, it } from '@effect/vitest'

import { relationKey } from '../reconciliation/Keys.ts'
import type { RelationKind } from '../reconciliation/Keys.ts'
import type { MatchedRelation } from '../reconciliation/Matching.ts'
import { relationScoreboard } from './RelationScoreboard.ts'

const relation = (
  kind: RelationKind,
  outflowId: string,
  inflowId: string,
  status: MatchedRelation['status'],
): MatchedRelation => ({
  key: relationKey(kind, outflowId, inflowId),
  kind,
  outflowId,
  inflowId,
  status,
  origin: 'auto',
  score: 90,
  reasons: [],
})

describe('relationScoreboard', () => {
  it('scores confirmations apart from suggestions, and a pair of the wrong kind as wrong and missed', () => {
    const board = relationScoreboard(
      [
        {
          id: 'transfers',
          tags: ['clear'],
          relations: [
            { kind: 'internal_transfer', outflowId: 'a', inflowId: 'b' },
            { kind: 'internal_transfer', outflowId: 'c', inflowId: 'd' },
            { kind: 'internal_transfer', outflowId: 'e', inflowId: 'f' },
          ],
        },
        { id: 'stranger', tags: ['coincidence'], relations: [] },
      ],
      new Map([
        [
          'transfers',
          [
            relation('internal_transfer', 'a', 'b', 'confirmed'),
            relation('internal_transfer', 'c', 'd', 'suggested'),
            relation('refund', 'e', 'f', 'confirmed'),
          ],
        ],
        ['stranger', [relation('internal_transfer', 'x', 'y', 'suggested')]],
      ]),
    )
    assert.deepStrictEqual(board.overall.counts, {
      auto_right: 1,
      auto_wrong: 1,
      suggested_right: 1,
      suggested_wrong: 1,
      missed: 1,
    })
    assert.strictEqual(board.overall.realPairs, 3)
    assert.strictEqual(board.overall.autoPrecision, 0.5)
    assert.strictEqual(board.overall.recall, 2 / 3)
    assert.strictEqual(board.byKind['refund']?.counts.auto_wrong, 1)
    assert.strictEqual(board.byTag['coincidence']?.counts.suggested_wrong, 1)
  })
})
