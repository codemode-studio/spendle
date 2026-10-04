import { assign } from '../domain/Assignment.ts'
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
  readonly currency: string
  readonly status: 'pending' | 'posted'
  readonly description: string
}

export type Decision = 'confirmed' | 'rejected'

export interface MatchedRelation {
  /** `kind:outId+inId`; stable because entry ids are. Keys decisions too. */
  readonly key: string
  readonly kind: RelationKind
  readonly outflowId: string
  readonly inflowId: string
  /**
   * `conflict`: the person confirmed it, but the facts changed since (amounts
   * or currencies no longer match) and it needs their review.
   */
  readonly status: 'suggested' | 'confirmed' | 'conflict'
  readonly origin: 'auto' | 'person'
  /** 0 to 100. */
  readonly score: number
  readonly reasons: ReadonlyArray<string>
}

/** A person's confirmation whose entry no longer exists; its partner stays reserved. */
export interface OrphanedDecision {
  readonly key: string
  readonly missing: ReadonlyArray<string>
}

export interface Matching {
  readonly relations: ReadonlyArray<MatchedRelation>
  readonly orphaned: ReadonlyArray<OrphanedDecision>
}

export const relationKey = (
  kind: RelationKind,
  outflowId: string,
  inflowId: string,
) => `${kind}:${outflowId}+${inflowId}`

export const parseRelationKey = (key: string) => {
  const [kind = '', pair = ''] = key.split(':')
  const [outflowId = '', inflowId = ''] = pair.split('+')
  return { kind, outflowId, inflowId }
}

/** Auto-confirm needs this score and no rival within the margin. */
export const autoConfirmScore = 80
export const rivalMargin = 10

const hints: Record<RelationKind, RegExp> = {
  internal_transfer:
    /\b(pix|transf|transferencia|ted|doc|tev|aplicacao|aplic|resgate|investimento|envio|enviad[oa]|recebid[oa]|deposito|mesma titularidade)\b/,
  card_payment: /\b(fatura|pagamento|pgto|pag|cartao|card)\b/,
}

// Wording that says the movement is something else: income on the receiving
// side, a purchase on the paying side, a refund or cashback on a card.
const contradictions: Record<
  RelationKind,
  { readonly outflow: RegExp; readonly inflow: RegExp }
> = {
  internal_transfer: {
    outflow: /\b(compra|boleto|tarifa|iof|juros)\b/,
    inflow:
      /\b(salario|folha|rendimento|rendimentos|juros|cashback|estorno|reembolso|dividendo|premio|restituicao)\b/,
  },
  card_payment: {
    outflow: /\b(compra|tarifa)\b/,
    inflow: /\b(estorno|cashback|reembolso|credito de|ajuste)\b/,
  },
}

// TED/DOC and investment movements can land a few business days later.
const slowRail = /\b(ted|doc|aplicacao|aplic|resgate|investimento)\b/

const windowDays = (
  kind: RelationKind,
  outflow: MatchableEntry,
  inflow: MatchableEntry,
) => {
  if (kind === 'card_payment') return 7
  const slow = [outflow, inflow].some((entry) =>
    slowRail.test(foldDescription(entry.description)),
  )
  return slow ? 5 : 3
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

/** Whether two entries can still be one relation of this kind; checked on every rebuild. */
const validPair = (
  kind: string,
  outflow: MatchableEntry,
  inflow: MatchableEntry,
) =>
  outflow.amountCents < 0 &&
  inflow.amountCents === -outflow.amountCents &&
  outflow.currency === inflow.currency &&
  kindFor(outflow, inflow) === kind

interface Candidate {
  readonly kind: RelationKind
  readonly outflow: MatchableEntry
  readonly inflow: MatchableEntry
  readonly days: number
  readonly score: number
  readonly hintedBoth: boolean
  readonly contradicted: boolean
  readonly reasons: ReadonlyArray<string>
}

const evaluate = (
  kind: RelationKind,
  outflow: MatchableEntry,
  inflow: MatchableEntry,
  days: number,
) => {
  const reasons = ['same_amount', 'own_accounts']
  let score = 50
  if (days === 0) {
    score += 20
    reasons.push('same_day')
  } else if (days === 1) {
    score += 10
    reasons.push('next_day')
  }
  const out = foldDescription(outflow.description)
  const into = foldDescription(inflow.description)
  const hinted = [out, into].filter((text) => hints[kind].test(text)).length
  if (hinted > 0) {
    score += hinted * 15
    reasons.push(
      hinted === 2 ? 'described_on_both_sides' : 'described_on_one_side',
    )
  }
  const contradicted =
    contradictions[kind].outflow.test(out) ||
    contradictions[kind].inflow.test(into)
  if (contradicted) {
    score -= 30
    reasons.push('conflicting_description')
  }
  return {
    score: Math.max(0, Math.min(100, score)),
    hintedBoth: hinted === 2,
    contradicted,
    reasons,
  }
}

/**
 * Pairs outflows with inflows of the same amount and currency between the
 * person's own accounts: transfers between bank accounts (3 days, 5 for
 * TED/DOC and investments), and payments from a bank account to a card
 * (7 days). Each entry joins at most one relation.
 *
 * A person's confirmation always holds its entries. If the facts changed so
 * the pair no longer adds up, it becomes a `conflict` for review; if an
 * entry disappeared, the decision is reported as orphaned and its partner
 * stays reserved instead of being paired again automatically. A rejection is
 * never suggested again.
 *
 * Remaining candidates are assigned per amount as a whole, maximizing how
 * many pairs are found, then their scores. Amount and dates alone only ever
 * make a suggestion: a pair is confirmed automatically when it scores at
 * least `autoConfirmScore`, both descriptions say what it is, nothing
 * contradicts it, both entries are posted, no rival comes within
 * `rivalMargin`, and the person never rejected a pairing for either entry.
 */
export const matchRelations = (
  entries: ReadonlyArray<MatchableEntry>,
  decisions: ReadonlyMap<string, Decision>,
): Matching => {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const used = new Set<string>()
  const relations: Array<MatchedRelation> = []
  const orphaned: Array<OrphanedDecision> = []

  for (const [key, decision] of [...decisions].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (decision !== 'confirmed') continue
    const { kind, outflowId, inflowId } = parseRelationKey(key)
    if (kind !== 'internal_transfer' && kind !== 'card_payment') continue
    const outflow = byId.get(outflowId)
    const inflow = byId.get(inflowId)
    if (!outflow || !inflow) {
      orphaned.push({
        key,
        missing: [outflowId, inflowId].filter((id) => !byId.has(id)),
      })
      for (const id of [outflowId, inflowId]) used.add(id)
      continue
    }
    if (used.has(outflowId) || used.has(inflowId)) continue
    used.add(outflowId)
    used.add(inflowId)
    const valid = validPair(kind, outflow, inflow)
    relations.push({
      key,
      kind,
      outflowId,
      inflowId,
      status: valid ? 'confirmed' : 'conflict',
      origin: 'person',
      score: valid ? 100 : 0,
      reasons: valid
        ? ['confirmed_by_person']
        : ['confirmed_by_person', 'facts_changed'],
    })
  }

  const rejectedEntries = new Set(
    [...decisions]
      .filter(([, decision]) => decision === 'rejected')
      .flatMap(([key]) => {
        const { outflowId, inflowId } = parseRelationKey(key)
        return [outflowId, inflowId]
      }),
  )

  const inflowsByAmount = new Map<string, Array<MatchableEntry>>()
  for (const entry of entries) {
    if (entry.amountCents <= 0 || used.has(entry.id)) continue
    const group = `${entry.currency}:${entry.amountCents}`
    const list = inflowsByAmount.get(group) ?? []
    list.push(entry)
    inflowsByAmount.set(group, list)
  }

  const candidatesByGroup = new Map<string, Array<Candidate>>()
  for (const outflow of entries) {
    if (outflow.amountCents >= 0 || used.has(outflow.id)) continue
    const group = `${outflow.currency}:${-outflow.amountCents}`
    for (const inflow of inflowsByAmount.get(group) ?? []) {
      const kind = kindFor(outflow, inflow)
      if (kind === null) continue
      if (
        decisions.get(relationKey(kind, outflow.id, inflow.id)) === 'rejected'
      )
        continue
      const days = daysBetween(inflow.bookedOn, outflow.bookedOn)
      if (days > windowDays(kind, outflow, inflow)) continue
      const list = candidatesByGroup.get(group) ?? []
      list.push({
        kind,
        outflow,
        inflow,
        days,
        ...evaluate(kind, outflow, inflow, days),
      })
      candidatesByGroup.set(group, list)
    }
  }

  // The two best scores each entry could reach, to tell clear pairs from ambiguous ones.
  const best = new Map<string, Array<number>>()
  for (const candidates of candidatesByGroup.values()) {
    for (const candidate of candidates) {
      for (const id of [candidate.outflow.id, candidate.inflow.id]) {
        const scores = best.get(id) ?? []
        scores.push(candidate.score)
        best.set(id, scores)
      }
    }
  }
  const rivalOf = (id: string, own: number) => {
    const scores = [...(best.get(id) ?? [])].sort((a, b) => b - a)
    const index = scores.indexOf(own)
    if (index !== -1) scores.splice(index, 1)
    return scores[0] ?? -Infinity
  }

  for (const candidates of candidatesByGroup.values()) {
    const outflows = [
      ...new Map(
        candidates.map((candidate) => [
          candidate.outflow.id,
          candidate.outflow,
        ]),
      ).values(),
    ]
    const inflows = [
      ...new Map(
        candidates.map((candidate) => [candidate.inflow.id, candidate.inflow]),
      ).values(),
    ]
    const find = (outflow: MatchableEntry, inflow: MatchableEntry) =>
      candidates.find(
        (candidate) =>
          candidate.outflow === outflow && candidate.inflow === inflow,
      )
    const rowOf = new Map(outflows.map((outflow, row) => [outflow.id, row]))
    const columnOf = new Map(
      inflows.map((inflow, column) => [inflow.id, column]),
    )
    const chosen = assign(
      candidates.map((candidate) => ({
        row: rowOf.get(candidate.outflow.id)!,
        column: columnOf.get(candidate.inflow.id)!,
        cost: -candidate.score * 1000 + candidate.days,
      })),
    )
    outflows.forEach((outflow, row) => {
      const column = chosen.get(row)
      if (column === undefined) return
      const candidate = find(outflow, inflows[column]!)!
      const rival = Math.max(
        rivalOf(outflow.id, candidate.score),
        rivalOf(candidate.inflow.id, candidate.score),
      )
      const unambiguous = rival < candidate.score - rivalMargin
      const contested =
        rejectedEntries.has(outflow.id) ||
        rejectedEntries.has(candidate.inflow.id)
      const posted =
        outflow.status === 'posted' && candidate.inflow.status === 'posted'
      const confident =
        candidate.score >= autoConfirmScore &&
        candidate.hintedBoth &&
        !candidate.contradicted &&
        posted &&
        unambiguous &&
        !contested
      relations.push({
        key: relationKey(candidate.kind, outflow.id, candidate.inflow.id),
        kind: candidate.kind,
        outflowId: outflow.id,
        inflowId: candidate.inflow.id,
        status: confident ? 'confirmed' : 'suggested',
        origin: 'auto',
        score: candidate.score,
        reasons: [
          ...candidate.reasons,
          ...(posted ? [] : ['pending']),
          ...(unambiguous ? [] : ['ambiguous']),
          ...(contested ? ['previously_rejected'] : []),
        ],
      })
    })
  }
  return {
    relations: relations.sort((a, b) => a.key.localeCompare(b.key)),
    orphaned,
  }
}
