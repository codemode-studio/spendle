/**
 * What the V1 data means for V2, decided without I/O: which V1 records
 * become which V2 inputs, which transaction categories and reconciliation
 * verdicts V1 got from the person, and how V2 will recognise the movements
 * those decisions are about.
 */
import { followCategoryDecisions } from '../categories/FollowDecisions.ts'
import { categorize } from '../categories/Policy.ts'
import type { PolicyCategory } from '../categories/Policy.ts'
import type { PatternRow } from '../categories/Store.ts'
import { foldDescription } from '../imports/Statement.ts'
import type { OpenAccount } from '../ledger/Accounts.ts'
import type {
  V1Account,
  V1Card,
  V1Snapshot,
  V1Transaction,
} from './V1Database.ts'

export type UnmappedKind =
  | 'owner'
  | 'account'
  | 'card'
  | 'category'
  | 'knowledge'
  | 'category_decision'
  | 'relation_decision'
  | 'statement_payment'
  | 'manual_transaction'
  | 'note'
  | 'investment_movement'
  | 'position'
  | 'checkpoint'
  | 'recurrence_link'
  | 'strategy'
  | 'budget'
  | 'goal'
  | 'recurrence'

/** A V1 record that does not move, and why. */
export interface Unmapped {
  readonly kind: UnmappedKind
  readonly v1Id: string
  readonly label: string
  readonly reason: string
}

export const ownerKind = (type: string) =>
  type === 'household'
    ? ('household' as const)
    : type === 'company_br' || type === 'company_us'
      ? ('company' as const)
      : ('person' as const)

/** Accounts without an institution in V1 get this one; V2 requires a name. */
export const noInstitution = 'Sem instituição'

const accountKinds = new Set(['checking', 'savings', 'cash', 'investment'])
const purposes = new Set(['operating', 'reserve', 'investment'])
const isCurrency = (value: string) => /^[A-Z]{3}$/.test(value)

export type AccountPlan =
  | {
      readonly _tag: 'Open'
      readonly input: OpenAccount
      readonly archived: boolean
    }
  | { readonly _tag: 'Skip'; readonly reason: string }

export const accountPlan = (
  account: V1Account,
  ownerId: string,
): AccountPlan => {
  if (!accountKinds.has(account.kind))
    return { _tag: 'Skip', reason: `unknown kind ${account.kind}` }
  if (!isCurrency(account.currency))
    return { _tag: 'Skip', reason: `invalid currency ${account.currency}` }
  const kind = account.kind as OpenAccount['kind']
  // V2 holds every brokerage account to the investment purpose.
  const purpose =
    kind === 'investment'
      ? 'investment'
      : purposes.has(account.purpose)
        ? (account.purpose as OpenAccount['purpose'])
        : 'operating'
  return {
    _tag: 'Open',
    archived: !account.active,
    input: {
      ownerId,
      institutionName: account.institutionName?.trim() || noInstitution,
      name: account.name.trim() || 'Conta',
      kind,
      purpose,
      currency: account.currency,
    },
  }
}

export const cardPlan = (card: V1Card, ownerId: string): AccountPlan => {
  if (!isCurrency(card.currency))
    return { _tag: 'Skip', reason: `invalid currency ${card.currency}` }
  if (card.dueDay === null)
    return {
      _tag: 'Skip',
      reason: 'no due day; set it on the card in V1 and run again',
    }
  const day = (value: number) => value >= 1 && value <= 31
  if (!day(card.closingDay) || !day(card.dueDay))
    return { _tag: 'Skip', reason: 'closing or due day outside 1-31' }
  return {
    _tag: 'Open',
    archived: !card.active,
    input: {
      ownerId,
      institutionName: card.institutionName?.trim() || noInstitution,
      name: card.name.trim() || 'Cartão',
      kind: 'credit_card',
      purpose: 'operating',
      currency: card.currency,
      card: {
        closingDay: card.closingDay,
        dueDay: card.dueDay,
        // V1 stores an unknown limit as zero.
        limitCents: card.limitCents > 0 ? card.limitCents : null,
        lastFour: card.lastFour,
      },
    },
  }
}

/** A V1 transaction's target: `account:<id>` or `card:<id>`. */
export const targetOf = (transaction: V1Transaction) =>
  transaction.accountId !== null
    ? `account:${transaction.accountId}`
    : `card:${transaction.cardId}`

/** The V2 account a V1 account or card became. */
export interface Target {
  readonly accountId: string
  readonly currency: string
}

/** How V2 recognises a V1 transaction once its source reports it again. */
export interface Movement {
  readonly v1TransactionId: string
  readonly accountId: string
  readonly bookedOn: string
  readonly amountCents: number
  readonly descriptionKey: string
  readonly description: string
  /** No other V1 transaction of the target has this day, amount and description. */
  readonly uniqueByDescription: boolean
  /** No other V1 transaction of the target has this day and amount. */
  readonly uniqueByAmount: boolean
}

type MovementResult =
  | { readonly ok: true; readonly movement: Movement }
  | { readonly ok: false; readonly reason: string }

const systemCategories = new Set(['transfer', 'card_payment'])

/** Categories V1's reconciliation writes when it confirms a group. */
const groupCategory: Record<string, string | null> = {
  transfer: 'transfer',
  fx_transfer: 'transfer',
  card_payment: 'card_payment',
  profit_distribution: 'profit_distribution_income',
  refund: null,
}

/** Reasons V1 writes on groups it confirmed or rejected by itself. */
const automaticConfirmations = new Set([
  'Contas vinculadas por uma confirmação manual anterior.',
  'Pagamento de fatura com valor e data correspondentes, sem outro candidato.',
])
const automaticRejection = /^Invalidada porque/

const relationKinds: Record<
  string,
  'internal_transfer' | 'card_payment' | 'refund' | undefined
> = {
  transfer: 'internal_transfer',
  card_payment: 'card_payment',
  refund: 'refund',
}

export interface CategoryDecisionPlan {
  readonly v1TransactionId: string
  readonly categoryId: string
  /** `review`: chosen while reviewing an import; `transaction_list`: changed afterwards. */
  readonly via: 'review' | 'transaction_list'
}

export interface RelationDecisionPlan {
  readonly v1GroupId: string
  readonly kind: 'internal_transfer' | 'card_payment' | 'refund'
  readonly decision: 'confirmed' | 'rejected'
  readonly outflow: string
  readonly inflow: string
}

/** A V1 transaction the person typed in, recorded in V2 as a fact of the `manual` source. */
export interface ManualTransactionPlan {
  readonly v1TransactionId: string
  readonly accountId: string
  readonly bookedOn: string
  readonly amountCents: number
  readonly description: string
}

export interface NotePlan {
  readonly v1TransactionId: string
  readonly note: string
}

export interface InvestmentMovementPlan {
  readonly v1MovementId: string
  readonly v1TransactionId: string
  readonly v1PositionId: string
}

export interface DecisionPlan {
  readonly movements: ReadonlyMap<string, Movement>
  readonly categories: ReadonlyArray<CategoryDecisionPlan>
  readonly relations: ReadonlyArray<RelationDecisionPlan>
  readonly manual: ReadonlyArray<ManualTransactionPlan>
  readonly notes: ReadonlyArray<NotePlan>
  readonly investmentMovements: ReadonlyArray<InvestmentMovementPlan>
  readonly unmapped: ReadonlyArray<Unmapped>
  /** Changed categories the migrated patterns already give, so no decision is needed. */
  readonly coveredByKnowledge: number
}

/** Centavos as `-25.00`, without passing through floating point. */
export const formatCents = (cents: number) => {
  const abs = Math.abs(cents)
  return `${cents < 0 ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

const describe = (transaction: V1Transaction) =>
  `${transaction.postedAt.slice(0, 10)} ${formatCents(transaction.amountCents)} ${transaction.description}`

/**
 * The person's decisions in V1 and the movements they are about.
 *
 * Category decisions are what V1 recorded as a person's choice: a category
 * chosen while reviewing an import (`suggestion_source = 'manual'`), or a
 * category changed afterwards in the transaction list, recognised as V1's
 * own backfill (migration 0034) does: the transaction's category differs
 * from the concrete one its import suggested. A change the migrated
 * knowledge patterns already explain (V1 reapplies its base to
 * transactions) is no separate decision. Reconciliation verdicts are
 * those V1 did not reach by itself.
 */
export const planDecisions = (input: {
  readonly snapshot: V1Snapshot
  readonly targets: ReadonlyMap<string, Target>
  readonly store: ReadonlyArray<PatternRow>
  readonly categories: ReadonlyArray<PolicyCategory>
}): DecisionPlan => {
  const { snapshot, targets } = input
  const unmapped: Array<Unmapped> = []
  const byId = new Map(snapshot.transactions.map((t) => [t.id, t]))
  const manual = (t: V1Transaction) =>
    t.sourceKey?.startsWith('manual:') ?? false
  // Typed-in transactions count too: V2 records them again as manual
  // facts, and decisions about them wait for those like any other.
  const live = snapshot.transactions.filter((t) => t.status !== 'excluded')

  // Day, amount and description of each live transaction, in its target's currency.
  const keyed = new Map<
    string,
    {
      readonly target: Target
      readonly bookedOn: string
      readonly amountCents: number
    }
  >()
  const amountKeys = new Map<string, number>()
  const descriptionKeys = new Map<string, number>()
  const bump = (map: Map<string, number>, key: string) =>
    map.set(key, (map.get(key) ?? 0) + 1)
  const reasons = new Map<string, string>()
  for (const transaction of live) {
    const target = targets.get(targetOf(transaction))
    if (target === undefined) {
      reasons.set(transaction.id, 'its account or card was not migrated')
      continue
    }
    const amountCents =
      transaction.currency === target.currency
        ? transaction.amountCents
        : transaction.baseCurrency === target.currency
          ? transaction.baseAmountCents
          : null
    if (amountCents === null) {
      reasons.set(transaction.id, `no amount in ${target.currency}`)
      continue
    }
    const bookedOn = transaction.postedAt.slice(0, 10)
    keyed.set(transaction.id, { target, bookedOn, amountCents })
    const amountKey = `${target.accountId}|${bookedOn}|${amountCents}`
    bump(amountKeys, amountKey)
    bump(
      descriptionKeys,
      `${amountKey}|${foldDescription(transaction.description)}`,
    )
  }
  const movements = new Map<string, Movement>()
  const movement = (transactionId: string): MovementResult => {
    const known = movements.get(transactionId)
    if (known) return { ok: true, movement: known }
    const transaction = byId.get(transactionId)
    if (transaction === undefined)
      return { ok: false, reason: 'transaction not found in V1' }
    if (transaction.status === 'excluded')
      return { ok: false, reason: 'excluded in V1' }
    const key = keyed.get(transactionId)
    if (key === undefined)
      return {
        ok: false,
        reason: reasons.get(transactionId) ?? 'not recognisable',
      }
    const descriptionKey = foldDescription(transaction.description)
    const amountKey = `${key.target.accountId}|${key.bookedOn}|${key.amountCents}`
    const found: Movement = {
      v1TransactionId: transactionId,
      accountId: key.target.accountId,
      bookedOn: key.bookedOn,
      amountCents: key.amountCents,
      descriptionKey,
      description: transaction.description,
      uniqueByDescription:
        descriptionKeys.get(`${amountKey}|${descriptionKey}`) === 1,
      uniqueByAmount: amountKeys.get(amountKey) === 1,
    }
    movements.set(transactionId, found)
    return { ok: true, movement: found }
  }

  // Groups V1 confirmed, by transaction, with the category they wrote.
  const groupsById = new Map(snapshot.groups.map((group) => [group.id, group]))
  const confirmedCategory = new Map<string, string | null>()
  for (const link of snapshot.links) {
    const group = groupsById.get(link.groupId)
    if (group?.status === 'confirmed')
      confirmedCategory.set(
        link.transactionId,
        groupCategory[group.type] ?? null,
      )
  }

  const reviewChoice = new Map<string, string>()
  const suggestion = new Map<string, string>()
  for (const row of snapshot.evidence) {
    if (row.suggestedCategoryId === null) continue
    if (row.suggestionSource === 'manual')
      reviewChoice.set(row.transactionId, row.suggestedCategoryId)
    else if (row.matchKind === 'created')
      suggestion.set(row.transactionId, row.suggestedCategoryId)
  }

  // What the migrated patterns give a transaction, as V2 would infer it.
  const noDecisions = followCategoryDecisions([], new Set())
  const inferred = (transaction: V1Transaction) =>
    categorize({
      entries: [
        {
          id: transaction.id,
          amountCents: transaction.amountCents,
          description: transaction.description,
          providerCategories: [],
        },
      ],
      relations: [],
      decisions: noDecisions,
      store: input.store,
      categories: input.categories,
    })[0]

  const categories: Array<CategoryDecisionPlan> = []
  let coveredByKnowledge = 0
  const decide = (
    transaction: V1Transaction,
    categoryId: string,
    via: CategoryDecisionPlan['via'],
  ) => {
    if (systemCategories.has(categoryId)) {
      unmapped.push({
        kind: 'category_decision',
        v1Id: transaction.id,
        label: describe(transaction),
        reason: `${categoryId} belongs to V2 reconciliation; confirm the pair there`,
      })
      return
    }
    const found = movement(transaction.id)
    if (!found.ok) {
      unmapped.push({
        kind: 'category_decision',
        v1Id: transaction.id,
        label: describe(transaction),
        reason: found.reason,
      })
      return
    }
    categories.push({ v1TransactionId: transaction.id, categoryId, via })
  }

  const manualPlans: Array<ManualTransactionPlan> = []
  for (const transaction of snapshot.transactions) {
    if (transaction.status === 'excluded') continue
    if (manual(transaction)) {
      const found = movement(transaction.id)
      const description = transaction.description.trim()
      if (!found.ok || description.length < 2) {
        unmapped.push({
          kind: 'manual_transaction',
          v1Id: transaction.id,
          label: describe(transaction),
          reason: found.ok
            ? 'description shorter than 2 characters'
            : found.reason,
        })
        continue
      }
      manualPlans.push({
        v1TransactionId: transaction.id,
        accountId: found.movement.accountId,
        bookedOn: found.movement.bookedOn,
        amountCents: found.movement.amountCents,
        description: description.slice(0, 200),
      })
      // The category typed in with it was the person's choice.
      const typed = transaction.categoryId
      if (typed !== null && typed !== 'uncategorized')
        decide(transaction, typed, 'transaction_list')
      continue
    }
    const current = transaction.categoryId
    const chosen = reviewChoice.get(transaction.id)
    const byGroup = confirmedCategory.get(transaction.id)
    // A confirmed group wrote its own category; the person's choice under
    // it is the one from the review, which V2 keeps shadowed by the pair.
    if (byGroup !== undefined && byGroup !== null && byGroup === current) {
      if (chosen !== undefined) decide(transaction, chosen, 'review')
      continue
    }
    if (current === null) continue
    if (chosen === current) {
      decide(transaction, chosen, 'review')
      continue
    }
    const suggested = suggestion.get(transaction.id)
    const changed =
      chosen !== undefined ||
      (suggested !== undefined &&
        suggested !== 'uncategorized' &&
        suggested !== current)
    if (!changed) continue
    const fromPatterns = inferred(transaction)
    if (
      fromPatterns !== undefined &&
      fromPatterns.status === 'applied' &&
      fromPatterns.categoryId === current
    ) {
      coveredByKnowledge++
      continue
    }
    decide(transaction, current, 'transaction_list')
  }

  const relations: Array<RelationDecisionPlan> = []
  const linksOf = new Map<string, Array<string>>()
  for (const link of snapshot.links) {
    const list = linksOf.get(link.groupId) ?? []
    list.push(link.transactionId)
    linksOf.set(link.groupId, list)
  }
  for (const group of snapshot.groups) {
    const decision =
      group.status === 'confirmed' &&
      !automaticConfirmations.has(group.reason ?? '')
        ? ('confirmed' as const)
        : group.status === 'rejected' &&
            !automaticRejection.test(group.reason ?? '')
          ? ('rejected' as const)
          : null
    if (decision === null) continue
    const label = `${group.type} ${decision}`
    const skip = (reason: string) =>
      unmapped.push({
        kind: 'relation_decision',
        v1Id: group.id,
        label,
        reason,
      })
    const kind = relationKinds[group.type]
    if (kind === undefined) {
      skip(`V2 has no ${group.type} relation`)
      continue
    }
    const members = (linksOf.get(group.id) ?? []).flatMap((id) => {
      const found = byId.get(id)
      return found ? [found] : []
    })
    const outflows = members.filter((t) => t.amountCents < 0)
    const inflows = members.filter((t) => t.amountCents > 0)
    if (members.length !== 2 || outflows.length !== 1 || inflows.length !== 1) {
      skip('not one outflow and one inflow')
      continue
    }
    const outflow = movement(outflows[0]!.id)
    const inflow = movement(inflows[0]!.id)
    if (!outflow.ok || !inflow.ok) {
      skip(
        [outflow, inflow]
          .flatMap((side) => (side.ok ? [] : [side.reason]))
          .join('; '),
      )
      continue
    }
    relations.push({
      v1GroupId: group.id,
      kind,
      decision,
      outflow: outflow.movement.v1TransactionId,
      inflow: inflow.movement.v1TransactionId,
    })
  }

  const notes: Array<NotePlan> = []
  for (const transaction of snapshot.transactions) {
    const note = transaction.notes?.trim() ?? ''
    if (note === '' || transaction.status === 'excluded') continue
    const found = movement(transaction.id)
    if (!found.ok) {
      unmapped.push({
        kind: 'note',
        v1Id: transaction.id,
        label: describe(transaction),
        reason: found.reason,
      })
      continue
    }
    notes.push({ v1TransactionId: transaction.id, note: note.slice(0, 500) })
  }

  const investmentMovements: Array<InvestmentMovementPlan> = []
  for (const row of snapshot.positionMovements) {
    const found = movement(row.transactionId)
    if (!found.ok) {
      const transaction = byId.get(row.transactionId)
      unmapped.push({
        kind: 'investment_movement',
        v1Id: row.id,
        label: transaction ? describe(transaction) : row.transactionId,
        reason: found.reason,
      })
      continue
    }
    investmentMovements.push({
      v1MovementId: row.id,
      v1TransactionId: row.transactionId,
      v1PositionId: row.positionId,
    })
  }

  // Payments the person linked to recurrences wait for their movements too.
  for (const link of snapshot.planning.links) {
    const found = movement(link.transactionId)
    if (found.ok) continue
    const transaction = byId.get(link.transactionId)
    unmapped.push({
      kind: 'recurrence_link',
      v1Id: link.id,
      label: transaction ? describe(transaction) : link.transactionId,
      reason: found.reason,
    })
  }

  for (const payment of snapshot.statementPayments) {
    const transaction = byId.get(payment.transactionId)
    unmapped.push({
      kind: 'statement_payment',
      v1Id: payment.id,
      label: transaction
        ? `${describe(transaction)} → bill due ${payment.dueDate}`
        : `bill due ${payment.dueDate}`,
      reason:
        'V2 pairs a bill payment with the card credit it settles; confirm the card payment once both sides are observed',
    })
  }

  return {
    movements,
    categories,
    relations,
    manual: manualPlans,
    notes,
    investmentMovements,
    unmapped,
    coveredByKnowledge,
  }
}

export interface CandidateEntry {
  readonly id: string
  readonly accountId: string
  readonly bookedOn: string
  readonly amountCents: number
  readonly description: string
}

export type Recognised =
  | { readonly _tag: 'Entry'; readonly entryId: string }
  | { readonly _tag: 'Missing' }
  | { readonly _tag: 'Ambiguous' }

/**
 * The one V2 entry that is this V1 movement: the only entry of the account
 * with its day, amount and folded description, or failing that the only
 * one with its day and amount. Each needs the movement to have been just
 * as alone in V1, so two transactions never claim the same entry.
 */
export const recognise = (
  movement: Movement,
  entries: ReadonlyArray<CandidateEntry>,
): Recognised => {
  const sameAmount = entries.filter(
    (entry) =>
      entry.accountId === movement.accountId &&
      entry.bookedOn === movement.bookedOn &&
      entry.amountCents === movement.amountCents,
  )
  if (sameAmount.length === 0) return { _tag: 'Missing' }
  const sameDescription = sameAmount.filter(
    (entry) => foldDescription(entry.description) === movement.descriptionKey,
  )
  if (sameDescription.length === 1 && movement.uniqueByDescription)
    return { _tag: 'Entry', entryId: sameDescription[0]!.id }
  if (sameAmount.length === 1 && movement.uniqueByAmount)
    return { _tag: 'Entry', entryId: sameAmount[0]!.id }
  return { _tag: 'Ambiguous' }
}
