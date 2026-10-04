import { assert, describe, it } from '@effect/vitest'

import { followDecisions } from './Decisions.ts'
import type { StoredDecision } from './Decisions.ts'
import { relationKey } from './Keys.ts'
import { matchRelations } from './Matching.ts'
import type { MatchableEntry } from './Matching.ts'

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
      [[...split.decisions.keys()], split.split, [...rejected.decisions]],
      [
        [],
        [
          {
            key: confirmed.key,
            missing: ['gone'],
            reserved: ['out', 'part-a', 'part-b'],
          },
        ],
        [
          [relationKey('internal_transfer', 'out', 'part-a'), 'rejected'],
          [relationKey('internal_transfer', 'out', 'part-b'), 'rejected'],
        ],
      ],
    )
  })

  it('treats a side as split even when one part kept the decided id', () => {
    // Two observations formed one outflow `out`; a correction separates them
    // and `out` keeps its id while `out-2` is new.
    const pix = (id: string, accountId: string, amountCents: number) => {
      const description =
        amountCents < 0 ? 'Pix enviado Donald' : 'Pix recebido Donald'
      return {
        id,
        accountId,
        accountKind: 'checking',
        bookedOn: '2026-09-10',
        amountCents,
        currency: 'BRL',
        status: 'posted',
        description,
        descriptions: [description],
      } satisfies MatchableEntry
    }
    const entries = [
      pix('out', 'nubank', -50000),
      pix('out-2', 'nubank', -50000),
      pix('in', 'inter', 50000),
      pix('in-2', 'btg', 50000),
    ]
    const ids = new Set(entries.map((entry) => entry.id))
    const decided = stored('out', 'in', { outflowHolders: ['out', 'out-2'] })
    const match = (decision: StoredDecision) => {
      const followed = followDecisions([decision], ids)
      return {
        followed,
        relations: matchRelations(
          entries,
          followed.decisions,
          new Set(followed.split.flatMap((split) => split.reserved)),
        ).relations.map((relation) => [relation.key, relation.status]),
      }
    }

    // A rejection blocks every resulting pair: `out-2` is never offered `in` again.
    const rejected = match({ ...decided, decision: 'rejected' })
    assert.deepStrictEqual(
      [...rejected.followed.decisions.keys()],
      [
        relationKey('internal_transfer', 'out', 'in'),
        relationKey('internal_transfer', 'out-2', 'in'),
      ],
    )
    assert.isFalse(
      rejected.relations.some(
        ([key]) => key === relationKey('internal_transfer', 'out-2', 'in'),
      ),
    )

    // A confirmation is reported split and reserves every holder, so no part
    // stays confirmed or auto-pairs elsewhere.
    const confirmed = match(decided)
    assert.deepStrictEqual(
      [confirmed.followed.split, confirmed.relations],
      [
        [{ key: decided.key, missing: [], reserved: ['out', 'out-2', 'in'] }],
        [],
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
