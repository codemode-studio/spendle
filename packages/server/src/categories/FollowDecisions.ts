/** A category decision as stored, with the entries holding its observations now. */
export interface StoredCategoryDecision {
  readonly key: string
  readonly categoryId: string
  /** Order of decisions; the latest wins when merged entries carry several. */
  readonly revision: number
  /** Current entries holding the observations the entry had when decided. */
  readonly holders: ReadonlyArray<string>
}

export interface DecisionRef {
  readonly key: string
  readonly categoryId: string
  readonly revision: number
}

export interface EntryDecision extends DecisionRef {
  /** Older decisions about entries that merged into this one, for the explanation. */
  readonly superseded: ReadonlyArray<DecisionRef>
}

export interface FollowedCategoryDecisions {
  /** The winning decision of each entry its observations now sit in alone. */
  readonly byEntry: ReadonlyMap<string, EntryDecision>
  /**
   * Decisions whose observations now sit in several entries, by each of
   * those entries: a decision about the whole says nothing certain about
   * its parts, so the parts go to review with it as context.
   */
  readonly split: ReadonlyMap<string, ReadonlyArray<DecisionRef>>
  /** The current entries each stored decision covers, whether or not it wins. */
  readonly entriesOf: ReadonlyMap<string, ReadonlyArray<string>>
}

/**
 * Moves decisions onto the entries that hold their observations now: a
 * pending entry that posts or merges with a file's line keeps the person's
 * category under whatever id the entry has. A decision with no observation
 * held any more applies to nothing until its observations come back.
 */
export const followCategoryDecisions = (
  stored: ReadonlyArray<StoredCategoryDecision>,
  entryIds: ReadonlySet<string>,
): FollowedCategoryDecisions => {
  const direct = new Map<string, Array<DecisionRef>>()
  const split = new Map<string, Array<DecisionRef>>()
  const entriesOf = new Map<string, ReadonlyArray<string>>()
  for (const decision of [...stored].sort((a, b) => b.revision - a.revision)) {
    const current = [...new Set(decision.holders)]
      .filter((id) => entryIds.has(id))
      .sort()
    entriesOf.set(decision.key, current)
    const ref: DecisionRef = {
      key: decision.key,
      categoryId: decision.categoryId,
      revision: decision.revision,
    }
    const target = current.length === 1 ? direct : split
    for (const entryId of current) {
      const list = target.get(entryId) ?? []
      list.push(ref)
      target.set(entryId, list)
    }
  }
  const byEntry = new Map<string, EntryDecision>()
  for (const [entryId, [winner, ...superseded]] of direct) {
    byEntry.set(entryId, { ...winner!, superseded })
  }
  return { byEntry, split, entriesOf }
}
