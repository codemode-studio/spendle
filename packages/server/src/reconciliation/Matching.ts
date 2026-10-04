import { daysBetween } from '../domain/LocalDate.ts'
import { foldDescription } from '../imports/Statement.ts'

export type RelationKind = 'internal_transfer' | 'card_payment'

/** An entry as the matcher sees it. */
export interface MatchableEntry {
  readonly id: string
  readonly accountId: string
  readonly accountKind:
    'checking' | 'savings' | 'cash' | 'investment' | 'credit_card'
  readonly bookedOn: string
  readonly amountCents: number
  readonly description: string
}

export type Decision = 'confirmed' | 'rejected'

export interface MatchedRelation {
  /** `kind:outId+inId`; stable because entry ids are. Keys decisions too. */
  readonly key: string
  readonly kind: RelationKind
  readonly outflowId: string
  readonly inflowId: string
  readonly status: 'suggested' | 'confirmed'
  readonly origin: 'auto' | 'person'
  /** 0 to 100. */
  readonly score: number
  readonly reasons: ReadonlyArray<string>
}

export const relationKey = (
  kind: RelationKind,
  outflowId: string,
  inflowId: string,
) => `${kind}:${outflowId}+${inflowId}`

/** Days a transfer may take to land; card payments post on the card a little later. */
const windowDays: Record<RelationKind, number> = {
  internal_transfer: 3,
  card_payment: 7,
}
/** Auto-confirm needs this score and no rival within the margin. */
export const autoConfirmScore = 80
export const rivalMargin = 10

const hints: Record<RelationKind, RegExp> = {
  internal_transfer:
    /\b(pix|transf|transferencia|ted|doc|aplicacao|aplic|resgate|envio|enviad|recebid|deposito)\b/,
  card_payment: /\b(fatura|pagamento|pgto|pag|cartao|card)\b/,
}

const kindFor = (
  outflow: MatchableEntry,
  inflow: MatchableEntry,
): RelationKind | null => {
  if (outflow.accountId === inflow.accountId) return null
  if (outflow.accountKind === 'credit_card') return null
  return inflow.accountKind === 'credit_card'
    ? 'card_payment'
    : 'internal_transfer'
}

interface Candidate {
  readonly kind: RelationKind
  readonly outflow: MatchableEntry
  readonly inflow: MatchableEntry
  readonly days: number
  readonly score: number
  readonly reasons: ReadonlyArray<string>
}

const score = (
  kind: RelationKind,
  outflow: MatchableEntry,
  inflow: MatchableEntry,
  days: number,
) => {
  const reasons = ['same_amount', 'own_accounts']
  let value = 60
  if (days === 0) {
    value += 20
    reasons.push('same_day')
  } else if (days === 1) {
    value += 10
    reasons.push('next_day')
  }
  const hinted = [outflow, inflow].filter((entry) =>
    hints[kind].test(foldDescription(entry.description)),
  )
  if (hinted.length > 0) {
    value += hinted.length === 2 ? 20 : 15
    reasons.push('description_hint')
  }
  return { score: Math.min(100, value), reasons }
}

/**
 * Pairs outflows with inflows of the same amount between the person's own
 * accounts: transfers between bank accounts, and payments from a bank
 * account to a credit card. Each entry joins at most one relation.
 *
 * A person's confirmation is kept even if the pair no longer scores; a
 * rejection is never suggested again. Remaining candidates are assigned best
 * score first. A candidate is confirmed automatically only when it scores at
 * least `autoConfirmScore`, neither of its entries has a rival candidate
 * within `rivalMargin`, and the person never rejected a pairing for either
 * entry; otherwise it stays a suggestion for the person.
 */
export const matchRelations = (
  entries: ReadonlyArray<MatchableEntry>,
  decisions: ReadonlyMap<string, Decision>,
): ReadonlyArray<MatchedRelation> => {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const used = new Set<string>()
  const relations: Array<MatchedRelation> = []

  for (const [key, decision] of [...decisions].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (decision !== 'confirmed') continue
    const [kind, pair = ''] = key.split(':')
    const [outflowId = '', inflowId = ''] = pair.split('+')
    if (kind !== 'internal_transfer' && kind !== 'card_payment') continue
    if (
      !byId.has(outflowId) ||
      !byId.has(inflowId) ||
      used.has(outflowId) ||
      used.has(inflowId)
    )
      continue
    used.add(outflowId)
    used.add(inflowId)
    relations.push({
      key,
      kind,
      outflowId,
      inflowId,
      status: 'confirmed',
      origin: 'person',
      score: 100,
      reasons: ['confirmed_by_person'],
    })
  }

  const rejectedEntries = new Set(
    [...decisions]
      .filter(([, decision]) => decision === 'rejected')
      .flatMap(([key]) => (key.split(':')[1] ?? '').split('+')),
  )

  const inflowsByAmount = new Map<number, Array<MatchableEntry>>()
  for (const entry of entries) {
    if (entry.amountCents <= 0) continue
    const list = inflowsByAmount.get(entry.amountCents) ?? []
    list.push(entry)
    inflowsByAmount.set(entry.amountCents, list)
  }

  const candidates: Array<Candidate> = []
  for (const outflow of entries) {
    if (outflow.amountCents >= 0 || used.has(outflow.id)) continue
    for (const inflow of inflowsByAmount.get(-outflow.amountCents) ?? []) {
      if (used.has(inflow.id)) continue
      const kind = kindFor(outflow, inflow)
      if (kind === null) continue
      if (
        decisions.get(relationKey(kind, outflow.id, inflow.id)) === 'rejected'
      )
        continue
      const days = daysBetween(inflow.bookedOn, outflow.bookedOn)
      if (days > windowDays[kind]) continue
      candidates.push({
        kind,
        outflow,
        inflow,
        days,
        ...score(kind, outflow, inflow, days),
      })
    }
  }

  const bestRival = (entryId: string, except: Candidate) =>
    Math.max(
      -Infinity,
      ...candidates
        .filter(
          (candidate) =>
            candidate !== except &&
            (candidate.outflow.id === entryId ||
              candidate.inflow.id === entryId),
        )
        .map((candidate) => candidate.score),
    )

  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.days - b.days ||
      a.outflow.id.localeCompare(b.outflow.id) ||
      a.inflow.id.localeCompare(b.inflow.id),
  )
  for (const candidate of candidates) {
    if (used.has(candidate.outflow.id) || used.has(candidate.inflow.id))
      continue
    used.add(candidate.outflow.id)
    used.add(candidate.inflow.id)
    const rival = Math.max(
      bestRival(candidate.outflow.id, candidate),
      bestRival(candidate.inflow.id, candidate),
    )
    const unambiguous = rival < candidate.score - rivalMargin
    // A person who rejected a pairing for either entry decides this one too.
    const contested =
      rejectedEntries.has(candidate.outflow.id) ||
      rejectedEntries.has(candidate.inflow.id)
    const confident =
      candidate.score >= autoConfirmScore && unambiguous && !contested
    relations.push({
      key: relationKey(
        candidate.kind,
        candidate.outflow.id,
        candidate.inflow.id,
      ),
      kind: candidate.kind,
      outflowId: candidate.outflow.id,
      inflowId: candidate.inflow.id,
      status: confident ? 'confirmed' : 'suggested',
      origin: 'auto',
      score: candidate.score,
      reasons: [
        ...candidate.reasons,
        ...(unambiguous ? [] : ['ambiguous']),
        ...(contested ? ['previously_rejected'] : []),
      ],
    })
  }
  return relations
}
