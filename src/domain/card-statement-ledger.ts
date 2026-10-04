import {
  isCardPaymentDescription,
  isCardPaymentReceipt,
  isSettlementCategory,
} from './card-payment'
import { daysBetween } from './period'

// One card, all of its statements: which purchases belong to each cycle, which
// payment settled it and how confident that link is. Presentation only; the
// ledger never writes records.

export interface LedgerStatement {
  dueDate: string
  closingDate: string
  amountCents: number
  certainty?: 'closed' | 'installment_schedule' | 'open'
}

export interface LedgerCardTransaction {
  id: string
  postedAt: string
  amountCents: number
  description: string
  categoryId: string | null
  /** Provider category of the current observation (Pluggy), if any. */
  providerCategory?: string | null
}

export interface LedgerAccountPayment {
  id: string
  postedAt: string
  amountCents: number
  description: string
  categoryId: string | null
}

export interface LedgerManualLink {
  id: string
  dueDate: string
  transactionId: string
  /** The person said this covered only part of the statement. */
  partial?: boolean
}

export interface LedgerReconciliation {
  id: string
  type: string
  status: 'suggested' | 'confirmed' | 'rejected'
  transactionIds: string[]
}

/**
 * manual: the person chose the bank debit on the Cartões page.
 * confirmed: reconciliation confirmed between the card row and a bank debit.
 * suggested: reconciliation waiting for review.
 * received: the card statement reports the payment, no bank row linked yet.
 * inferred: a bank debit with the exact total near the due date.
 * candidate: a bank card payment near the due date with a different amount.
 */
export type StatementPaymentKind =
  'manual' | 'confirmed' | 'suggested' | 'received' | 'inferred' | 'candidate'

export type StatementStatus =
  | 'scheduled'
  | 'open'
  | 'empty'
  | 'closed'
  | 'paid'
  | 'partial'
  | 'suggested'
  | 'likely'
  | 'overdue'

export interface StatementPayment {
  transactionId: string
  kind: StatementPaymentKind
  groupId: string | null
  /** Row id of the manual link, so it can be undone. */
  linkId: string | null
  /** Manual link flagged as partial by the person. */
  partial?: boolean
  amountCents: number
  /**
   * The other side of the same payment, such as the card's "Pagamento
   * recebido" paired with a bank debit. Either side posted settles it once.
   */
  evidenceIds?: string[]
}

export interface StatementLedgerEntry extends LedgerStatement {
  status: StatementStatus
  paidCents: number
  transactionIds: string[]
  payments: StatementPayment[]
}

const INFERRED_WINDOW_DAYS = 15
const CANDIDATE_WINDOW_DAYS = 10

/** The same day one or more months away, clamped to the month's length. */
function shiftMonths(iso: string, months: number) {
  const [year, month, day] = iso.split('-').map(Number)
  const target = new Date(Date.UTC(year, month - 1 + months, 1))
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay))
  return target.toISOString().slice(0, 10)
}

function distance(a: string, b: string) {
  return daysBetween(a, b, { inclusive: false, absolute: true })
}

function looksLikeBankPayment(payment: LedgerAccountPayment) {
  return (
    payment.amountCents < 0 &&
    (payment.categoryId === 'card_payment' ||
      isCardPaymentDescription(payment.description))
  )
}

export function buildCardStatementLedger(input: {
  statements: LedgerStatement[]
  transactions: LedgerCardTransaction[]
  accountPayments: LedgerAccountPayment[]
  reconciliations: LedgerReconciliation[]
  manualLinks?: LedgerManualLink[]
  /**
   * Statements of the person's other cards in the same currency. A bank debit
   * that could pay one of them is not inferred for this card.
   */
  otherCardStatements?: Array<Pick<LedgerStatement, 'dueDate' | 'amountCents'>>
  /**
   * Whether a row has already posted (the same test as
   * `statementCashSettlement`). Only posted payments reduce what a bill still
   * owes when receipts are placed; pending ones are still shown. Defaults to
   * every row posted.
   */
  isPosted?: (transactionId: string) => boolean
  today: string
}): StatementLedgerEntry[] {
  const isPosted = input.isPosted ?? (() => true)
  const statements = [...input.statements].sort((a, b) =>
    a.closingDate.localeCompare(b.closingDate),
  )
  if (!statements.length) return []
  const entries: StatementLedgerEntry[] = statements.map((statement) => ({
    ...statement,
    status: 'closed',
    paidCents: 0,
    transactionIds: [],
    payments: [],
  }))
  // Purchases belong to the first cycle that closes on or after their date.
  const cycleIndex = (postedAt: string) => {
    const index = statements.findIndex((s) => postedAt <= s.closingDate)
    return index === -1 ? statements.length - 1 : index
  }
  const cardGroups = input.reconciliations.filter(
    (group) => group.type === 'card_payment' && group.status !== 'rejected',
  )
  const groupByTransaction = new Map<string, LedgerReconciliation>()
  for (const group of cardGroups)
    for (const id of group.transactionIds) groupByTransaction.set(id, group)
  const explicitlyLinked = new Set(
    cardGroups
      .filter((group) => group.status === 'confirmed')
      .flatMap((group) => group.transactionIds),
  )

  // A person's decision outranks every inference.
  const accountPaymentById = new Map(
    input.accountPayments.map((payment) => [payment.id, payment]),
  )
  const manualLinks = (input.manualLinks ?? []).flatMap((link) => {
    const entry = entries.find((item) => item.dueDate === link.dueDate)
    const payment = accountPaymentById.get(link.transactionId)
    return entry && payment ? [{ link, entry, payment }] : []
  })
  const manuallyLinked = new Set(manualLinks.map(({ payment }) => payment.id))
  // Card receipts recording a hand-linked debit, kept as its evidence.
  const manualEvidence = new Map<string, string[]>()
  const addManualEvidence = (paymentId: string, receiptId: string) =>
    manualEvidence.set(paymentId, [
      ...(manualEvidence.get(paymentId) ?? []),
      receiptId,
    ])
  // A hand-linked bank debit with no card_payment group is still paired with
  // the card's own "Pagamento recebido" for it: the receipt of the same
  // amount, in the statement the link settles, within the payment window.
  // Each debit pairs with at most one receipt; other receipts still count.
  const unpairedManual = manualLinks.filter(
    ({ payment }) => !groupByTransaction.has(payment.id),
  )
  const pairWithManualLink = (
    receipt: LedgerCardTransaction,
    entry: StatementLedgerEntry,
  ) => {
    const index = unpairedManual.findIndex(
      ({ entry: linked, payment }) =>
        linked === entry &&
        -payment.amountCents === receipt.amountCents &&
        distance(payment.postedAt, receipt.postedAt) <= INFERRED_WINDOW_DAYS,
    )
    if (index === -1) return false
    addManualEvidence(unpairedManual[index].payment.id, receipt.id)
    unpairedManual.splice(index, 1)
    return true
  }

  // Settled so far by the person's links, before any receipt is placed.
  const manualCents = new Map<StatementLedgerEntry, number>()
  const settledByHand = new Set<StatementLedgerEntry>()
  for (const { link, entry, payment } of manualLinks) {
    manualCents.set(entry, (manualCents.get(entry) ?? 0) - payment.amountCents)
    if (!link.partial) settledByHand.add(entry)
  }
  // What each bill still owes, counting only payments already posted: a
  // pending receipt is shown on its bill but does not push a posted one to
  // the next cycle, since cash settlement will not count it either.
  const postedCents = new Map<StatementLedgerEntry, number>()
  const addPosted = (entry: StatementLedgerEntry, amountCents: number) =>
    postedCents.set(entry, (postedCents.get(entry) ?? 0) + amountCents)
  const remainingCents = (entry: StatementLedgerEntry) =>
    settledByHand.has(entry)
      ? 0
      : Math.max(
          0,
          entry.amountCents -
            (postedCents.get(entry) ?? 0) -
            (manualCents.get(entry) ?? 0),
        )

  const receipts: LedgerCardTransaction[] = []
  for (const transaction of input.transactions) {
    // The card statement reports the payment by its wording or the provider
    // category, with or without a bank debit matched to it, or a confirmed
    // bill payment group already says this credit is the receipt.
    const received =
      isCardPaymentReceipt(transaction) ||
      (transaction.amountCents > 0 &&
        groupByTransaction.get(transaction.id)?.status === 'confirmed')
    if (received) {
      receipts.push(transaction)
      continue
    }
    if (isSettlementCategory(transaction.categoryId)) continue
    entries[cycleIndex(transaction.postedAt)].transactionIds.push(
      transaction.id,
    )
  }

  // A receipt posts in the cycle after the bill it usually settles, but it
  // may also pay that cycle's own bill in advance, before it closes. With no
  // bill id on the receipt, the person's link decides; otherwise the oldest
  // bill still open takes it, and whatever it leaves pays the current cycle.
  // A receipt before the due date of a bill outside the ledger (the one
  // closed before the copied history starts) paid that bill.
  const neighbours = (transaction: LedgerCardTransaction) => {
    const home = statements.findIndex(
      (s) => transaction.postedAt <= s.closingDate,
    )
    const current = home === -1 ? undefined : entries[home]
    const previousIndex = (home === -1 ? entries.length : home) - 1
    const previous = previousIndex >= 0 ? entries[previousIndex] : undefined
    return { current, previous }
  }
  const placements = (
    transaction: LedgerCardTransaction,
  ): Array<{ entry: StatementLedgerEntry; amountCents: number }> => {
    const { current, previous } = neighbours(transaction)
    const linked = unpairedManual.find(
      ({ entry, payment }) =>
        (entry === previous || entry === current) &&
        -payment.amountCents === transaction.amountCents &&
        distance(payment.postedAt, transaction.postedAt) <=
          INFERRED_WINDOW_DAYS,
    )
    const group = groupByTransaction.get(transaction.id)
    const handLinked = group?.transactionIds
      .map((id) => manualLinks.find(({ payment }) => payment.id === id))
      .find(Boolean)
    const decided = handLinked?.entry ?? linked?.entry
    if (decided)
      return [{ entry: decided, amountCents: transaction.amountCents }]
    if (!previous) {
      if (!current) return []
      const previousDue = shiftMonths(current.dueDate, -1)
      return transaction.postedAt <= previousDue
        ? []
        : [{ entry: current, amountCents: transaction.amountCents }]
    }
    const owed = remainingCents(previous)
    if (!current || owed >= transaction.amountCents)
      return [{ entry: previous, amountCents: transaction.amountCents }]
    // A group is one payment; it settles a single statement.
    if (group)
      return [
        {
          entry: owed > 0 ? previous : current,
          amountCents: transaction.amountCents,
        },
      ]
    return [
      ...(owed > 0 ? [{ entry: previous, amountCents: owed }] : []),
      { entry: current, amountCents: transaction.amountCents - owed },
    ]
  }

  // Bank debits of placed bill payment groups; they never count twice.
  const groupedBankIds = new Set<string>()
  const settle = (transaction: LedgerCardTransaction) => {
    for (const { entry, amountCents: placedCents } of placements(transaction)) {
      const group = groupByTransaction.get(transaction.id)
      const groupBankIds =
        group?.transactionIds.filter((id) => id !== transaction.id) ?? []
      // A bank debit linked by hand already counts this receipt, with the
      // person's partial or full decision; only the rest of the pair adds.
      const bankIds = groupBankIds.filter((id) => !manuallyLinked.has(id))
      for (const id of groupBankIds)
        if (manuallyLinked.has(id)) addManualEvidence(id, transaction.id)
      if (groupBankIds.length && !bankIds.length) continue
      const handCents = groupBankIds
        .filter((id) => manuallyLinked.has(id))
        .reduce(
          (sum, id) => sum - (accountPaymentById.get(id)?.amountCents ?? 0),
          0,
        )
      for (const id of bankIds) groupedBankIds.add(id)
      if (group && group.status === 'confirmed' && bankIds.length) {
        const amountCents = Math.max(0, transaction.amountCents - handCents)
        for (const id of bankIds)
          entry.payments.push({
            transactionId: id,
            kind: 'confirmed',
            groupId: group.id,
            linkId: null,
            amountCents,
            evidenceIds: [transaction.id],
          })
        entry.paidCents += amountCents
        if ([transaction.id, ...bankIds].some(isPosted))
          addPosted(entry, amountCents)
      } else if (group && group.status === 'suggested' && bankIds.length) {
        for (const id of bankIds)
          entry.payments.push({
            transactionId: id,
            kind: 'suggested',
            groupId: group.id,
            linkId: null,
            amountCents: transaction.amountCents,
          })
      } else if (!group && pairWithManualLink(transaction, entry)) {
        continue
      } else {
        entry.payments.push({
          transactionId: transaction.id,
          kind: 'received',
          groupId: null,
          linkId: null,
          amountCents: placedCents,
        })
        entry.paidCents += placedCents
        if (isPosted(transaction.id)) addPosted(entry, placedCents)
      }
    }
  }

  // Order matters only for what each bill still owes when a receipt is
  // placed: bill payment groups first, then bank debits identified by amount
  // and date, then the card's own receipts, oldest first. A receipt that is
  // the card side of an identified debit is its evidence and counts once.
  receipts.sort((a, b) => a.postedAt.localeCompare(b.postedAt))
  for (const transaction of receipts)
    if (groupByTransaction.has(transaction.id)) settle(transaction)

  // Bank-side evidence for a bill no group or link of the person settles.
  const bankPayments = input.accountPayments.filter(
    (payment) =>
      looksLikeBankPayment(payment) &&
      !explicitlyLinked.has(payment.id) &&
      !manuallyLinked.has(payment.id) &&
      !groupedBankIds.has(payment.id),
  )
  const handLinkedEntries = new Set(manualLinks.map(({ entry }) => entry))
  const usedBankIds = new Set<string>()
  const pairedReceiptIds = new Set<string>()
  for (const entry of entries) {
    if (
      entry.payments.length ||
      handLinkedEntries.has(entry) ||
      entry.amountCents <= 0
    )
      continue
    const exact = bankPayments.filter(
      (payment) =>
        !usedBankIds.has(payment.id) &&
        -payment.amountCents === entry.amountCents &&
        distance(payment.postedAt, entry.dueDate) <= INFERRED_WINDOW_DAYS,
    )
    if (exact.length !== 1) continue
    const payment = exact[0]
    const ambiguous = [
      ...entries.filter((other) => other !== entry),
      ...(input.otherCardStatements ?? []),
    ].some(
      (other) =>
        other.amountCents === entry.amountCents &&
        distance(payment.postedAt, other.dueDate) <= INFERRED_WINDOW_DAYS,
    )
    if (ambiguous) continue
    usedBankIds.add(payment.id)
    // The card's "Pagamento recebido" for this debit: same amount, within
    // the payment window, posted where it could settle this bill.
    const evidence = receipts.find((receipt) => {
      if (groupByTransaction.has(receipt.id)) return false
      if (pairedReceiptIds.has(receipt.id)) return false
      if (receipt.amountCents !== -payment.amountCents) return false
      if (distance(receipt.postedAt, payment.postedAt) > INFERRED_WINDOW_DAYS)
        return false
      const { current, previous } = neighbours(receipt)
      if (current !== entry && previous !== entry) return false
      // The card side of a debit the person linked by hand stays with it.
      return !unpairedManual.some(
        ({ payment: linked }) =>
          -linked.amountCents === receipt.amountCents &&
          distance(linked.postedAt, receipt.postedAt) <= INFERRED_WINDOW_DAYS,
      )
    })
    if (evidence) pairedReceiptIds.add(evidence.id)
    const evidenceIds = evidence ? [evidence.id] : []
    entry.payments.push({
      transactionId: payment.id,
      kind: 'inferred',
      groupId: null,
      linkId: null,
      amountCents: -payment.amountCents,
      ...(evidence ? { evidenceIds } : {}),
    })
    entry.paidCents += -payment.amountCents
    if ([payment.id, ...evidenceIds].some(isPosted))
      addPosted(entry, -payment.amountCents)
  }

  for (const transaction of receipts)
    if (
      !groupByTransaction.has(transaction.id) &&
      !pairedReceiptIds.has(transaction.id)
    )
      settle(transaction)

  for (const { link, entry, payment } of manualLinks) {
    entry.payments.push({
      transactionId: payment.id,
      kind: 'manual',
      groupId: null,
      linkId: link.id,
      partial: Boolean(link.partial),
      amountCents: -payment.amountCents,
      evidenceIds: manualEvidence.get(payment.id) ?? [],
    })
    entry.paidCents += -payment.amountCents
  }

  for (const entry of entries) {
    if (
      entry.paidCents >= entry.amountCents ||
      entry.amountCents <= 0 ||
      entry.payments.some((p) => p.kind === 'suggested')
    )
      continue
    for (const payment of bankPayments) {
      if (usedBankIds.has(payment.id)) continue
      if (distance(payment.postedAt, entry.dueDate) > CANDIDATE_WINDOW_DAYS)
        continue
      entry.payments.push({
        transactionId: payment.id,
        kind: 'candidate',
        groupId: null,
        linkId: null,
        amountCents: -payment.amountCents,
      })
    }
  }

  for (const entry of entries) {
    entry.status = statementStatus(entry, input.today)
  }
  return entries.sort((a, b) => a.dueDate.localeCompare(b.dueDate))
}

/**
 * What a statement has settled in cash: the same settling payments as its
 * status, limited to those with a transaction `isPosted` accepts on either
 * side of the payment. A pending or future bank debit with no posted card
 * receipt is shown on the statement but has not left the account yet.
 */
export function statementCashSettlement(
  entry: StatementLedgerEntry,
  isPosted: (transactionId: string) => boolean,
) {
  const settled = entry.payments.filter(
    (p) =>
      ['manual', 'confirmed', 'received', 'inferred'].includes(p.kind) &&
      [p.transactionId, ...(p.evidenceIds ?? [])].some(isPosted),
  )
  // A confirmed group lists each bank debit with the card row's amount.
  const groups = new Set<string>()
  let paidCents = 0
  for (const payment of settled) {
    if (payment.groupId) {
      if (groups.has(payment.groupId)) continue
      groups.add(payment.groupId)
    }
    paidCents += payment.amountCents
  }
  const paid =
    settled.some((p) => p.kind === 'manual' && !p.partial) ||
    (entry.amountCents > 0 && paidCents >= entry.amountCents)
  return { paidCents, paid }
}

function statementStatus(
  entry: StatementLedgerEntry,
  today: string,
): StatementStatus {
  if (entry.certainty === 'installment_schedule') return 'scheduled'
  if (entry.closingDate >= today) return 'open'
  if (entry.amountCents <= 0 && !entry.transactionIds.length) return 'empty'
  const settled = entry.payments.filter((p) =>
    ['manual', 'confirmed', 'received', 'inferred'].includes(p.kind),
  )
  const settledCents = settled.reduce((sum, p) => sum + p.amountCents, 0)
  // A person who picked the debit is saying the statement is settled; the gap
  // is a credit or adjustment at closing, unless they flagged it as partial.
  if (settled.some((p) => p.kind === 'manual' && !p.partial)) return 'paid'
  if (entry.amountCents > 0 && settledCents >= entry.amountCents) return 'paid'
  if (entry.payments.some((p) => p.kind === 'suggested')) return 'suggested'
  if (settledCents > 0) return 'partial'
  if (entry.payments.some((p) => p.kind === 'candidate')) return 'likely'
  if (entry.dueDate < today) return 'overdue'
  return 'closed'
}

// "overdue" only means no payment was found after the due date; the bank
// statement for that month may simply not be imported yet.
export const statementStatusLabels: Record<StatementStatus, string> = {
  scheduled: 'Prevista',
  open: 'Aberta',
  empty: 'Sem lançamentos',
  closed: 'Fechada',
  paid: 'Paga',
  partial: 'Paga parcialmente',
  suggested: 'Pagamento a confirmar',
  likely: 'Pagamento provável',
  overdue: 'Pagamento não identificado',
}

export const statementPaymentKindLabels: Record<StatementPaymentKind, string> =
  {
    manual: 'Vinculado por você',
    confirmed: 'Vínculo confirmado',
    suggested: 'Sugestão a confirmar',
    received: 'Informado pela fatura',
    inferred: 'Identificado por valor e data',
    candidate: 'Possível pagamento',
  }
