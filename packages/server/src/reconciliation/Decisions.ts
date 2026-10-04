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

export interface FollowedDecisions {
  /** Decisions keyed by current entry ids, as `matchRelations` takes them. */
  readonly decisions: ReadonlyMap<string, Decision>
  /** The stored decision each current key comes from. */
  readonly storedKeys: ReadonlyMap<string, string>
  /** Confirmations a side of which is now split across several entries. */
  readonly split: ReadonlySet<string>
}

/**
 * Moves decisions onto the entries that hold their observations now, so a
 * decision survives entries merging under another id. A side whose entry
 * still exists keeps it. Otherwise it follows its observations: to the one
 * entry holding them, or, when they are split across several, a rejection
 * covers each of them while a confirmation keeps the vanished id (and is
 * reported as orphaned) until the person resolves it.
 */
export const followDecisions = (
  stored: ReadonlyArray<StoredDecision>,
  entryIds: ReadonlySet<string>,
): FollowedDecisions => {
  const decisions = new Map<string, Decision>()
  const storedKeys = new Map<string, string>()
  const split = new Set<string>()
  for (const decision of [...stored].sort((a, b) => a.revision - b.revision)) {
    const { kind, outflowId, inflowId } = parseRelationKey(decision.key)
    const follow = (id: string, holders: ReadonlyArray<string>) => {
      if (entryIds.has(id)) return [id]
      const current = [...new Set(holders)].filter((holder) =>
        entryIds.has(holder),
      )
      if (current.length <= 1 || decision.decision === 'rejected')
        return current.length === 0 ? [id] : current
      split.add(decision.key)
      return [id]
    }
    for (const outflow of follow(outflowId, decision.outflowHolders)) {
      for (const inflow of follow(inflowId, decision.inflowHolders)) {
        const key = relationKey(kind as RelationKind, outflow, inflow)
        decisions.set(key, decision.decision)
        storedKeys.set(key, decision.key)
      }
    }
  }
  return { decisions, storedKeys, split }
}
