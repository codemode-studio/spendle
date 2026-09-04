export interface CanonicalIdentity {
  externalId?: string | null
  fingerprint: string
}

export type DuplicateReason = 'external_id' | 'fingerprint_overlap' | null

export interface StatementValue {
  postedAt: string
  amountCents: number
  currency: string
  externalId?: string | null
}

export function statementIdentitiesCompatible(
  observation: Pick<StatementValue, 'externalId'>,
  transaction: Pick<StatementValue, 'externalId'>,
) {
  const observationExternalId = observation.externalId ?? null
  const transactionExternalId = transaction.externalId ?? null
  return (
    observationExternalId === null ||
    transactionExternalId === null ||
    observationExternalId === transactionExternalId
  )
}

export function statementLinkIsCompatible(
  observation: Pick<StatementValue, 'externalId'>,
  transaction: Pick<StatementValue, 'externalId'> & { id?: string },
  stagedObservations: ReadonlyArray<Pick<StatementValue, 'externalId'>>,
  ledgerTransactions: ReadonlyArray<
    Pick<StatementValue, 'externalId'> & { id?: string }
  > = [],
) {
  if (!statementIdentitiesCompatible(observation, transaction)) return false

  // An ID-less observation cannot take a transaction whose id is claimed by
  // another row of the same statement.
  if (
    !observation.externalId &&
    transaction.externalId &&
    stagedObservations.some(
      (candidate) => candidate.externalId === transaction.externalId,
    )
  ) {
    return false
  }

  // An identified observation cannot take an ID-less transaction when another
  // canonical transaction already owns that id (ADR 001: identity first).
  if (
    observation.externalId &&
    !transaction.externalId &&
    ledgerTransactions.some(
      (candidate) =>
        candidate.externalId === observation.externalId &&
        candidate.id !== transaction.id,
    )
  ) {
    return false
  }
  return true
}

export function identifyDuplicateReasons(
  incoming: CanonicalIdentity[],
  existing: CanonicalIdentity[],
) {
  const reasons: DuplicateReason[] = incoming.map(() => null)
  const usedExisting = new Set<number>()
  const existingByExternalId = new Map(
    existing.flatMap((item, index) =>
      item.externalId ? [[item.externalId, index] as const] : [],
    ),
  )

  for (const [index, item] of incoming.entries()) {
    if (!item.externalId) continue
    const externalMatch = existingByExternalId.get(item.externalId)
    if (externalMatch !== undefined) {
      reasons[index] = 'external_id'
      usedExisting.add(externalMatch)
      continue
    }
    const exactWithoutId = existing.findIndex(
      (candidate, candidateIndex) =>
        !usedExisting.has(candidateIndex) &&
        !candidate.externalId &&
        candidate.fingerprint === item.fingerprint,
    )
    if (exactWithoutId >= 0) {
      reasons[index] = 'fingerprint_overlap'
      usedExisting.add(exactWithoutId)
    }
  }

  for (const [index, item] of incoming.entries()) {
    if (item.externalId) continue
    const exactMatch = existing.findIndex(
      (candidate, candidateIndex) =>
        !usedExisting.has(candidateIndex) &&
        candidate.fingerprint === item.fingerprint,
    )
    if (exactMatch >= 0) {
      reasons[index] = 'fingerprint_overlap'
      usedExisting.add(exactMatch)
    }
  }

  return reasons
}

export function statementValueSignature(item: StatementValue) {
  return `${item.postedAt.slice(0, 10)}|${item.amountCents}|${item.currency}`
}

function statementIdentityMatches(
  observation: StatementValue,
  transaction: StatementValue,
) {
  return (
    statementIdentitiesCompatible(observation, transaction) &&
    statementValueSignature(observation) ===
      statementValueSignature(transaction)
  )
}

export function matchStatementValueSubset<
  TObservation extends StatementValue,
  TTransaction extends StatementValue,
>(observations: TObservation[], transactions: TTransaction[]) {
  const available = new Map<string, TTransaction[]>()
  for (const transaction of transactions) {
    const signature = statementValueSignature(transaction)
    const matches = available.get(signature) ?? []
    matches.push(transaction)
    available.set(signature, matches)
  }
  const matches: Array<{
    observation: TObservation
    transaction: TTransaction
  }> = []
  const unmatched: TObservation[] = []
  for (const observation of observations) {
    const candidates = available.get(statementValueSignature(observation))
    const candidateIndex = candidates?.findIndex((transaction) =>
      statementIdentityMatches(observation, transaction),
    )
    const transaction =
      candidateIndex !== undefined && candidateIndex >= 0
        ? candidates?.splice(candidateIndex, 1).at(0)
        : undefined
    if (transaction) matches.push({ observation, transaction })
    else unmatched.push(observation)
  }
  if ([...available.values()].some((items) => items.length)) return null
  return { matches, unmatched }
}

export function sameStatementValues(
  left: StatementValue[],
  right: StatementValue[],
) {
  if (!left.length || left.length !== right.length) return false
  const result = matchStatementValueSubset(left, right)
  return Boolean(result && !result.unmatched.length)
}

export function assignStatementValueMatches<
  TObservation extends StatementValue,
  TTransaction extends StatementValue,
>(observations: TObservation[], transactions: TTransaction[]) {
  const result = matchStatementValueSubset(observations, transactions)
  return result && !result.unmatched.length ? result.matches : null
}

export function matchOptionalStatementValues<
  TObservation extends StatementValue,
  TTransaction extends StatementValue,
>(observations: TObservation[], transactions: TTransaction[]) {
  const available = [...transactions]
  type StatementPair = {
    observation: TObservation
    transaction: TTransaction
  }
  const matchesByObservation: Array<StatementPair | null> = observations.map(
    () => null,
  )
  const changedByObservation: Array<StatementPair | null> = observations.map(
    () => null,
  )

  for (const [observationIndex, observation] of observations.entries()) {
    if (!observation.externalId) continue
    const sameIdIndex = available.findIndex(
      (transaction) => transaction.externalId === observation.externalId,
    )
    if (sameIdIndex < 0) continue
    const pair = {
      observation,
      transaction: available[sameIdIndex],
    }
    if (
      statementValueSignature(pair.observation) ===
      statementValueSignature(pair.transaction)
    ) {
      matchesByObservation[observationIndex] = pair
    } else {
      changedByObservation[observationIndex] = pair
    }
    available.splice(sameIdIndex, 1)
  }

  for (const [observationIndex, observation] of observations.entries()) {
    if (
      matchesByObservation[observationIndex] ||
      changedByObservation[observationIndex]
    ) {
      continue
    }
    const observationSignature = statementValueSignature(observation)
    // Value fallback only when at least one side has no external id: two rows
    // with different bank identifiers are different facts even if the values
    // coincide (ADR 001, multiplicidade).
    const valueIndex = available.findIndex(
      (transaction) =>
        statementValueSignature(transaction) === observationSignature &&
        statementIdentitiesCompatible(observation, transaction),
    )
    if (valueIndex < 0) continue
    matchesByObservation[observationIndex] = {
      observation,
      transaction: available[valueIndex],
    }
    available.splice(valueIndex, 1)
  }

  const matches = matchesByObservation.filter(
    (match): match is NonNullable<typeof match> => match !== null,
  )
  const changed = changedByObservation.filter(
    (match): match is NonNullable<typeof match> => match !== null,
  )
  const unmatched = observations.filter(
    (_, index) => matchesByObservation[index] === null,
  )
  const matchedTransactions = new Set(
    matches.map(({ transaction }) => transaction),
  )
  const unmatchedTransactions = transactions.filter(
    (transaction) => !matchedTransactions.has(transaction),
  )
  return { matches, changed, unmatched, unmatchedTransactions }
}

export function findTransactionsAbsentFromStatement<
  TObservation extends StatementValue,
  TTransaction extends StatementValue,
>(observations: TObservation[], transactions: TTransaction[]) {
  const { changed, unmatchedTransactions } = matchOptionalStatementValues(
    observations,
    transactions,
  )
  const changedTransactions = new Set(
    changed.map(({ transaction }) => transaction),
  )
  return unmatchedTransactions.filter(
    (transaction) => !changedTransactions.has(transaction),
  )
}

export function resolveCanonicalAssignments<
  TObservation extends CanonicalIdentity & { id: string },
  TTransaction extends CanonicalIdentity & { id: string },
>(input: {
  observations: TObservation[]
  transactions: TTransaction[]
  duplicateReasons: DuplicateReason[]
  preassigned?: ReadonlyMap<string, string>
}) {
  const assignments = new Map(input.preassigned ?? [])
  const usedTransactionIds = new Set(assignments.values())

  for (const [index, observation] of input.observations.entries()) {
    if (!observation.externalId || assignments.has(observation.id)) continue
    const reason = input.duplicateReasons[index]
    const match =
      reason === 'external_id'
        ? input.transactions.find(
            (candidate) => candidate.externalId === observation.externalId,
          )
        : reason === 'fingerprint_overlap'
          ? input.transactions.find(
              (candidate) =>
                !candidate.externalId &&
                !usedTransactionIds.has(candidate.id) &&
                candidate.fingerprint === observation.fingerprint,
            )
          : null
    if (!match) continue
    assignments.set(observation.id, match.id)
    usedTransactionIds.add(match.id)
  }

  for (const [index, observation] of input.observations.entries()) {
    if (
      observation.externalId ||
      input.duplicateReasons[index] !== 'fingerprint_overlap'
    ) {
      continue
    }
    const match = input.transactions.find(
      (candidate) =>
        !usedTransactionIds.has(candidate.id) &&
        candidate.fingerprint === observation.fingerprint,
    )
    if (!match) continue
    assignments.set(observation.id, match.id)
    usedTransactionIds.add(match.id)
  }

  return assignments
}

export function canonicalEvidenceKind(input: {
  controlled: boolean
  duplicateReason: DuplicateReason
}) {
  if (input.controlled) return 'statement_control' as const
  if (input.duplicateReason === 'external_id') return 'external_id' as const
  if (input.duplicateReason === 'fingerprint_overlap') {
    return 'exact_overlap' as const
  }
  return 'created' as const
}
