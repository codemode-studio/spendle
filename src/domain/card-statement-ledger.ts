import {
  isCardPaymentDescription,
  isReceivedCardPayment,
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
}

export interface StatementLedgerEntry extends LedgerStatement {
  status: StatementStatus
  paidCents: number
  transactionIds: string[]
  payments: StatementPayment[]
}

const INFERRED_WINDOW_DAYS = 15
const CANDIDATE_WINDOW_DAYS = 10

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
  today: string
}): StatementLedgerEntry[] {
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
    unpairedManual.splice(index, 1)
    return true
  }

  for (const transaction of input.transactions) {
    const received = isReceivedCardPayment({
      creditCardId: 'card',
      amountCents: transaction.amountCents,
      description: transaction.description,
    })
    if (received) {
      // A payment lands in the cycle after the one it settles.
      const target = cycleIndex(transaction.postedAt) - 1
      if (target < 0) continue
      const entry = entries[target]
      const group = groupByTransaction.get(transaction.id)
      const groupBankIds =
        group?.transactionIds.filter((id) => id !== transaction.id) ?? []
      // A bank debit linked by hand already counts this receipt, with the
      // person's partial or full decision; only the rest of the pair adds.
      const bankIds = groupBankIds.filter((id) => !manuallyLinked.has(id))
      if (groupBankIds.length && !bankIds.length) continue
      const manualCents = groupBankIds
        .filter((id) => manuallyLinked.has(id))
        .reduce(
          (sum, id) => sum - (accountPaymentById.get(id)?.amountCents ?? 0),
          0,
        )
      if (group && group.status === 'confirmed' && bankIds.length) {
        const amountCents = Math.max(0, transaction.amountCents - manualCents)
        for (const id of bankIds)
          entry.payments.push({
            transactionId: id,
            kind: 'confirmed',
            groupId: group.id,
            linkId: null,
            amountCents,
          })
        entry.paidCents += amountCents
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
          amountCents: transaction.amountCents,
        })
        entry.paidCents += transaction.amountCents
      }
      continue
    }
    if (isSettlementCategory(transaction.categoryId)) continue
    entries[cycleIndex(transaction.postedAt)].transactionIds.push(
      transaction.id,
    )
  }

  for (const { link, entry, payment } of manualLinks) {
    entry.payments.push({
      transactionId: payment.id,
      kind: 'manual',
      groupId: null,
      linkId: link.id,
      partial: Boolean(link.partial),
      amountCents: -payment.amountCents,
    })
    entry.paidCents += -payment.amountCents
  }

  // Bank-side evidence when the card statement itself is silent.
  const bankPayments = input.accountPayments.filter(
    (payment) =>
      looksLikeBankPayment(payment) &&
      !explicitlyLinked.has(payment.id) &&
      !manuallyLinked.has(payment.id),
  )
  const usedBankIds = new Set<string>()
  for (const entry of entries) {
    if (entry.payments.length || entry.amountCents <= 0) continue
    const exact = bankPayments.filter(
      (payment) =>
        !usedBankIds.has(payment.id) &&
        -payment.amountCents === entry.amountCents &&
        distance(payment.postedAt, entry.dueDate) <= INFERRED_WINDOW_DAYS,
    )
    if (exact.length === 1) {
      const payment = exact[0]
      const ambiguous = entries.some(
        (other) =>
          other !== entry &&
          other.amountCents === entry.amountCents &&
          distance(payment.postedAt, other.dueDate) <= INFERRED_WINDOW_DAYS,
      )
      if (!ambiguous) {
        usedBankIds.add(payment.id)
        entry.payments.push({
          transactionId: payment.id,
          kind: 'inferred',
          groupId: null,
          linkId: null,
          amountCents: -payment.amountCents,
        })
        entry.paidCents += -payment.amountCents
      }
    }
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
 * status, limited to those `isPosted` accepts. A pending or future bank
 * debit is shown on the statement but has not left the account yet.
 */
export function statementCashSettlement(
  entry: StatementLedgerEntry,
  isPosted: (payment: StatementPayment) => boolean,
) {
  const settled = entry.payments.filter(
    (p) =>
      ['manual', 'confirmed', 'received', 'inferred'].includes(p.kind) &&
      isPosted(p),
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
