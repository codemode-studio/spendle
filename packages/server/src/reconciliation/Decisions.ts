import { parseRelationKey, relationKey } from './Matching.ts'
import type { Decision, RelationKind } from './Matching.ts'

/** A person's decision as stored, with where its entries' observations are now. */
export interface StoredDecision {
  readonly key: string
  readonly decision: Decision
  /** Order of decisions; the latest wins when two end up about one pair. */
  readonly revision: number
  /** Current entries holding the observations the outflow had when decided. */
  readonly outflowHolders: ReadonlyArray<string>
  /** Current entries holding the observations the inflow had when decided. */
  readonly inflowHolders: ReadonlyArray<string>
}

/** A confirmation a side of which is now split across several entries. */
export interface SplitDecision {
  readonly key: string
  /** Decided entry ids that no longer exist. */
  readonly missing: ReadonlyArray<string>
  /** Every current entry holding its observations, none of which pairs automatically. */
  readonly reserved: ReadonlyArray<string>
}

export interface FollowedDecisions {
  /** Decisions keyed by current entry ids, as `matchRelations` takes them. */
  readonly decisions: ReadonlyMap<string, Decision>
  /** The stored decision each current key comes from. */
  readonly storedKeys: ReadonlyMap<string, string>
  /** The current keys each stored decision applies to, whether or not it wins. */
  readonly currentKeys: ReadonlyMap<string, ReadonlyArray<string>>
  /** Confirmations left out of `decisions` until the person resolves them. */
  readonly split: ReadonlyArray<SplitDecision>
}

/**
 * Moves decisions onto the entries that hold their observations now, so a
 * decision survives entries merging under another id. Each side follows its
 * observations: to the one entry holding them, or, when they are split
 * across several (even if one kept the decided id), a rejection covers each
 * resulting pair while a confirmation is reported as split, reserving every
 * holder, until the person resolves it. A side with no observations held
 * keeps its id.
 */
export const followDecisions = (
  stored: ReadonlyArray<StoredDecision>,
  entryIds: ReadonlySet<string>,
): FollowedDecisions => {
  const decisions = new Map<string, Decision>()
  const storedKeys = new Map<string, string>()
  const currentKeys = new Map<string, Array<string>>()
  const split: Array<SplitDecision> = []
  const follow = (id: string, holders: ReadonlyArray<string>) => {
    const current = [...new Set(holders)].filter((holder) =>
      entryIds.has(holder),
    )
    return current.length === 0 ? [id] : current
  }
  for (const decision of [...stored].sort((a, b) => a.revision - b.revision)) {
    const { kind, outflowId, inflowId } = parseRelationKey(decision.key)
    const outflows = follow(outflowId, decision.outflowHolders)
    const inflows = follow(inflowId, decision.inflowHolders)
    if (
      decision.decision === 'confirmed' &&
      (outflows.length > 1 || inflows.length > 1)
    ) {
      split.push({
        key: decision.key,
        missing: [outflowId, inflowId].filter((id) => !entryIds.has(id)),
        reserved: [...outflows, ...inflows].filter((id) => entryIds.has(id)),
      })
      continue
    }
    const keys: Array<string> = []
    for (const outflow of outflows) {
      for (const inflow of inflows) {
        const key = relationKey(kind as RelationKind, outflow, inflow)
        decisions.set(key, decision.decision)
        storedKeys.set(key, decision.key)
        keys.push(key)
      }
    }
    currentKeys.set(decision.key, keys)
  }
  return { decisions, storedKeys, currentKeys, split }
}
