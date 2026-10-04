import { daysBetween } from '../domain/LocalDate.ts'
import { foldDescription } from '../imports/Statement.ts'
import { meaningfulWords } from '../ledger/Resolution.ts'
import { autoConfirmScore, relationKey, rivalMargin } from './Keys.ts'
import type { Decision, MatchableEntry, MatchedRelation } from './Matching.ts'

/** How long after a purchase a refund is still looked for. */
export const refundWindowDays = 120

const refundHint =
  /\b(estorno|estornado|reembolso|devolucao|cancelamento|cancelado|chargeback)\b/
// Credits that give money for another reason than returning a purchase.
const otherCredit =
  /\b(cashback|emprestimo|financiamento|rendimento|rendimentos|juros|salario|bonus|premio|pontos)\b/
// The same, as provider operation types.
const otherOperation =
  /cashback|emprestimo|financiamento|rendimento|juros|salario|bonus|premio|pontos/i

// Words shop names share without naming the same shop: kinds of shop,
// company suffixes, web addresses and places.
const storeWords = new Set([
  'loja',
  'lojas',
  'store',
  'shop',
  'comercio',
  'servicos',
  'eireli',
  'www',
  'net',
  'digital',
  'shopping',
  'centro',
  'brasil',
  'brazil',
  'sao',
  'santa',
  'santo',
  'rio',
  'paulo',
  'janeiro',
  'belo',
  'horizonte',
  'porto',
  'alegre',
  'curitiba',
])

const merchantWords = (description: string) =>
  new Set(
    [...meaningfulWords(description)].filter(
      (word) => !storeWords.has(word) && !/^\d+$/.test(word),
    ),
  )

/** Whether two descriptions share a word that names a shop. */
const sameMerchant = (a: string, b: string) => {
  const right = merchantWords(b)
  return [...merchantWords(a)].some((word) => right.has(word))
}

/** Whether a credit can give back part of a purchase; checked on every rebuild. */
export const validRefund = (purchase: MatchableEntry, refund: MatchableEntry) =>
  purchase.accountId === refund.accountId &&
  purchase.currency === refund.currency &&
  purchase.amountCents < 0 &&
  refund.amountCents > 0 &&
  refund.amountCents <= -purchase.amountCents &&
  refund.bookedOn >= purchase.bookedOn

interface Candidate {
  readonly purchase: MatchableEntry
  readonly refund: MatchableEntry
  readonly days: number
  readonly score: number
  readonly merchant: boolean
  readonly reasons: ReadonlyArray<string>
}

const evaluate = (
  purchase: MatchableEntry,
  refund: MatchableEntry,
  remainingCents: number,
) => {
  const reasons = ['same_account']
  let score = 40
  const merchant = sameMerchant(purchase.description, refund.description)
  if (merchant) {
    score += 30
    reasons.push('same_merchant')
  }
  if (refundHint.test(foldDescription(refund.description))) {
    score += 15
    reasons.push('refund_wording')
  }
  if (refund.amountCents === remainingCents) {
    score += 15
    reasons.push('full_amount')
  } else {
    reasons.push('partial_amount')
  }
  return { score: Math.min(100, score), merchant, reasons }
}

/**
 * Pairs credits with the earlier purchase they give back, on the same
 * account: a card refund, a cancelled order, a returned debit. A credit must
 * come within `refundWindowDays` of the purchase, fit in what is left of it
 * after earlier refunds (`refundedCents`), and say it is a refund or name
 * the same merchant. Cashback, loans, interest and similar credits are not
 * refunds. Entries in `used` are already in another relation.
 *
 * A pairing is confirmed automatically only when it names the purchase's
 * merchant, scores at least `autoConfirmScore`, both entries are posted, no
 * rival comes within `rivalMargin`, and the person never rejected a
 * pairing for either entry. Refund wording alone leaves it for review.
 */
export const matchRefunds = (
  entries: ReadonlyArray<MatchableEntry>,
  decisions: ReadonlyMap<string, Decision>,
  used: ReadonlySet<string>,
  refundedCents: ReadonlyMap<string, number>,
  rejectedEntries: ReadonlySet<string>,
): ReadonlyArray<MatchedRelation> => {
  const refunded = new Map(refundedCents)
  const remaining = (purchase: MatchableEntry) =>
    -purchase.amountCents - (refunded.get(purchase.id) ?? 0)

  const purchasesByAccount = new Map<string, Array<MatchableEntry>>()
  for (const entry of entries) {
    if (entry.amountCents >= 0 || used.has(entry.id)) continue
    const list = purchasesByAccount.get(entry.accountId) ?? []
    list.push(entry)
    purchasesByAccount.set(entry.accountId, list)
  }

  const candidates: Array<Candidate> = []
  for (const refund of entries) {
    if (refund.amountCents <= 0 || used.has(refund.id)) continue
    const text = foldDescription(refund.description)
    if (
      otherCredit.test(text) ||
      otherOperation.test(refund.operationType ?? '')
    )
      continue
    const wording = refundHint.test(text)
    for (const purchase of purchasesByAccount.get(refund.accountId) ?? []) {
      if (!validRefund(purchase, refund)) continue
      if (refund.amountCents > remaining(purchase)) continue
      const days = daysBetween(purchase.bookedOn, refund.bookedOn)
      if (days > refundWindowDays) continue
      if (
        decisions.get(relationKey('refund', purchase.id, refund.id)) ===
        'rejected'
      )
        continue
      const evaluated = evaluate(purchase, refund, remaining(purchase))
      if (!wording && !evaluated.merchant) continue
      candidates.push({ purchase, refund, days, ...evaluated })
    }
  }

  const rival = (except: Candidate) =>
    Math.max(
      -Infinity,
      ...candidates
        .filter(
          (candidate) =>
            candidate !== except &&
            (candidate.refund.id === except.refund.id ||
              candidate.purchase.id === except.purchase.id),
        )
        .map((candidate) => candidate.score),
    )

  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.days - b.days ||
      a.purchase.id.localeCompare(b.purchase.id) ||
      a.refund.id.localeCompare(b.refund.id),
  )
  const paired = new Set<string>()
  const relations: Array<MatchedRelation> = []
  for (const candidate of candidates) {
    const { purchase, refund } = candidate
    if (paired.has(refund.id) || refund.amountCents > remaining(purchase))
      continue
    paired.add(refund.id)
    refunded.set(
      purchase.id,
      (refunded.get(purchase.id) ?? 0) + refund.amountCents,
    )
    const unambiguous = rival(candidate) < candidate.score - rivalMargin
    const contested =
      rejectedEntries.has(purchase.id) || rejectedEntries.has(refund.id)
    const posted = purchase.status === 'posted' && refund.status === 'posted'
    const confident =
      candidate.merchant &&
      candidate.score >= autoConfirmScore &&
      posted &&
      unambiguous &&
      !contested
    relations.push({
      key: relationKey('refund', purchase.id, refund.id),
      kind: 'refund',
      outflowId: purchase.id,
      inflowId: refund.id,
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
  }
  return relations
}
