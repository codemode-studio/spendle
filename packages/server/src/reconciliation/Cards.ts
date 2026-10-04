import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { addDays, today } from '../domain/LocalDate.ts'
import { foldDescription } from '../imports/Statement.ts'
import { Accounts } from '../ledger/Accounts.ts'
import { billPaymentWindowDays, billPayments, cardCycles } from './Cycles.ts'
import type { CardCycle, CardCycles, CyclePayment } from './Cycles.ts'

export class CardsError extends Schema.TaggedError<CardsError>()('CardsError', {
  reason: Schema.Literals(['not_a_card']),
  accountId: Schema.String,
}) {
  override get message(): string {
    return `Account ${this.accountId} is not a credit card`
  }
}

const CardEntryRow = Schema.Struct({
  id: Schema.String,
  bookedOn: Schema.String,
  amountCents: Schema.Int,
  description: Schema.String,
  billId: Schema.NullOr(Schema.String),
})

const DebitRow = Schema.Struct({
  id: Schema.String,
  bookedOn: Schema.String,
  amountCents: Schema.Int,
  description: Schema.String,
  /** The card credit an unconfirmed relation pairs the debit with. */
  pairedInflowId: Schema.NullOr(Schema.String),
})

const PaymentRelationRow = Schema.Struct({
  inflowEntryId: Schema.String,
  paidOn: Schema.String,
})

const paymentHint = /\b(pagamento|pgto|pag)\b/
const refundHint = /\b(estorno|reembolso|cancelamento)\b/
const billHint = /\b(fatura|cartao|credito)\b/
// Says it pays a card, not just any bill ("fatura" also names utility bills).
const cardHint = /\b(cartao|credito)\b/
// Words in institution names that do not tell banks apart.
const genericBankWords = new Set([
  'banco',
  'bank',
  'sa',
  'de',
  'do',
  'da',
  'pagamentos',
  'instituicao',
])
const bankWords = (institutionName: string) =>
  foldDescription(institutionName)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2 && !genericBankWords.has(word))
// A four-digit number said to be a card's ending: "final 1234", "cartao 1234",
// "****1234", "xxxx1234", "*1234".
const cardEnding = /(?:\bfinal|\bcartao|\bcard|[*•]|\bx+)\s*(\d{4})(?!\d)/g
// A number labeled as a reference rather than a card: "ref 1234",
// "boleto 1234", "nsu: 1234", "cod. no 1234".
const referenceNumber =
  /\b(?:ref|referencia|doc|documento|nsu|protocolo|autenticacao|aut|codigo|cod|boleto|id)(?:[\s.:#º°-]+|n[º°o]?(?![a-z]))*\d+/g
/**
 * The card endings a description states. A four-digit number counts when it
 * is marked as one, or is the only number said that is not labeled as a
 * reference: a reference or document number is not a card.
 */
const statedEndings = (text: string) => {
  const unlabeled = text.replace(referenceNumber, ' ')
  const marked = [...unlabeled.matchAll(cardEnding)].map((match) => match[1]!)
  if (marked.length > 0) return new Set(marked)
  const numbers = unlabeled.match(/\d+/g) ?? []
  return new Set(
    numbers.length === 1 && numbers[0]!.length === 4 ? numbers : [],
  )
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const accounts = yield* Accounts

  const findCardEntries = SqlSchema.findAll({
    Request: Schema.String,
    Result: CardEntryRow,
    execute: (accountId) => sql`
      SELECT e.id, e.booked_on AS bookedOn, e.amount_cents AS amountCents, e.description,
        (SELECT CASE WHEN COUNT(DISTINCT json_extract(o.raw, '$.installment.billId')) = 1
            THEN MAX(json_extract(o.raw, '$.installment.billId')) END
          FROM entry_evidence v JOIN transaction_observations o
            ON o.source_id = v.source_id AND o.account_id = v.account_id AND o.external_id = v.external_id
          WHERE v.entry_id = e.id AND NOT EXISTS (
            SELECT 1 FROM transaction_observations n
            WHERE n.source_id = o.source_id AND n.account_id = o.account_id
              AND n.external_id = o.external_id AND n.version > o.version
          )) AS billId
      FROM ledger_entries e
      WHERE e.account_id = ${accountId} AND e.status = 'posted'
    `,
  })
  // Confirmed payments into the card and the date the bank debited them.
  const findPaymentRelations = SqlSchema.findAll({
    Request: Schema.String,
    Result: PaymentRelationRow,
    execute: (accountId) => sql`
      SELECT r.inflow_entry_id AS inflowEntryId, o.booked_on AS paidOn
      FROM relations r
      JOIN ledger_entries i ON i.id = r.inflow_entry_id
      JOIN ledger_entries o ON o.id = r.outflow_entry_id
      WHERE r.kind = 'card_payment' AND r.status = 'confirmed' AND i.account_id = ${accountId}
    `,
  })
  // Bank debits that could pay a bill: posted, in the card's currency, dated
  // after a closing and within the payment window, worded like a bill, and
  // not one side of a confirmed relation. CROSS JOIN keeps accounts outside,
  // so each bank account's dates are a range of its (account, date) index
  // rather than a scan of the whole ledger.
  const findBillDebits = SqlSchema.findAll({
    Request: Schema.Struct({
      currency: Schema.String,
      from: Schema.String,
      through: Schema.String,
    }),
    Result: DebitRow,
    execute: ({ currency, from, through }) => sql`
      SELECT e.id, e.booked_on AS bookedOn, e.amount_cents AS amountCents, e.description,
        p.inflow_entry_id AS pairedInflowId
      FROM accounts a
      CROSS JOIN ledger_entries e ON e.account_id = a.id
        AND e.booked_on > ${from} AND e.booked_on <= ${through}
      LEFT JOIN relations p ON p.outflow_entry_id = e.id AND p.status <> 'confirmed'
      WHERE a.kind <> 'credit_card' AND a.archived_at IS NULL AND a.currency = ${currency}
        AND e.status = 'posted' AND e.amount_cents < 0 AND e.currency = ${currency}
        AND (e.description LIKE '%fatura%' OR e.description LIKE '%cart%'
          OR e.description LIKE '%cr_dito%')
        AND NOT EXISTS (
          SELECT 1 FROM relations r
          WHERE r.status = 'confirmed'
            AND (r.outflow_entry_id = e.id OR r.inflow_entry_id = e.id)
        )
      ORDER BY e.booked_on, e.id
    `,
  })
  // Statement totals from files that state their period: the period's end is
  // the actual closing. Balances without a stated period are not statements.
  const findStatements = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({
      startsOn: Schema.String,
      closingOn: Schema.String,
      cents: Schema.Int,
      dueOn: Schema.NullOr(Schema.String),
      netOfPayments: Schema.BooleanFromBit,
    }),
    execute: (accountId) => sql`
      SELECT f.period_start AS startsOn, b.as_of AS closingOn, b.balance_cents AS cents,
        f.due_on AS dueOn, f.charges_only = 0 AS netOfPayments
      FROM balance_observations b
      JOIN import_files f ON f.source_id = b.source_id AND f.account_id = b.account_id
      WHERE b.account_id = ${accountId} AND b.kind = 'statement'
        AND f.period_start IS NOT NULL AND f.period_end = b.as_of
      ORDER BY b.as_of, b.rowid
    `,
  })

  /**
   * The card's statement cycles with what each one owes, what paid it, and
   * how its entries compare with the issued statement.
   *
   * Payments come from three places, most certain first:
   * 1. a confirmed card payment relation, made on the bank debit's date and
   *    credited on the card's;
   * 2. a credit on the card that says it is a payment;
   * 3. only a bank debit, when the card side is missing (card PDFs may omit
   *    payments). The debit must be in the card's currency and identify
   *    this card and no other one: it states the card's ending, or states
   *    no ending and names the card's bank, without contradicting itself, or
   *    says "cartão"/"crédito" with no ending when there is a single card.
   *    Its amount must be exactly what one closed cycle still owed on the
   *    debit's date, and it pays that cycle.
   */
  const cycles = Effect.fn('Cards.cycles')(function* (accountId: string) {
    const card = yield* accounts.get(accountId)
    if (card.card === null)
      return yield* new CardsError({ reason: 'not_a_card', accountId })
    const terms = card.card
    const [entries, paymentRelations, statements, all, date] =
      yield* Effect.all([
        findCardEntries(accountId),
        findPaymentRelations(accountId),
        findStatements(accountId),
        accounts.list,
        today,
      ])

    const payments: Array<CyclePayment> = []
    const paymentIds = new Set<string>()
    const amountOf = new Map(entries.map((entry) => [entry.id, entry]))
    for (const relation of paymentRelations) {
      const inflow = amountOf.get(relation.inflowEntryId)
      if (!inflow || paymentIds.has(inflow.id)) continue
      payments.push({
        entryId: inflow.id,
        paidOn: relation.paidOn,
        creditedOn: inflow.bookedOn,
        amountCents: inflow.amountCents,
        via: 'card',
      })
      paymentIds.add(inflow.id)
    }
    for (const entry of entries) {
      const text = foldDescription(entry.description)
      if (
        !paymentIds.has(entry.id) &&
        entry.amountCents > 0 &&
        paymentHint.test(text) &&
        !refundHint.test(text)
      ) {
        payments.push({
          entryId: entry.id,
          paidOn: entry.bookedOn,
          creditedOn: entry.bookedOn,
          amountCents: entry.amountCents,
          via: 'card',
        })
        paymentIds.add(entry.id)
      }
    }
    const history = {
      terms,
      entries: entries.filter((entry) => !paymentIds.has(entry.id)),
      statements,
      today: date,
    }
    const known = cardCycles({ ...history, payments })
    const firstCycle = known.cycles[0]
    const lastCycle = known.cycles.at(-1)
    if (firstCycle === undefined || lastCycle === undefined) return known

    const cards = all.filter(
      (account) =>
        account.kind === 'credit_card' &&
        !account.archived &&
        account.currency === card.currency,
    )
    // A stated ending names one card; the bank's name, every card of that
    // bank, but only when no ending is said. An ending no card here has, or
    // one of another bank than the one named, names no card.
    const named = (text: string, endings: ReadonlySet<string>) => {
      const said = new Set(text.split(/[^a-z0-9]+/))
      const byBank = cards.filter((account) =>
        bankWords(account.institutionName).some((word) => said.has(word)),
      )
      if (endings.size === 0) return byBank
      const byEnding = cards.filter(
        (account) =>
          account.card?.lastFour != null && endings.has(account.card.lastFour),
      )
      const known = [...endings].every((ending) =>
        byEnding.some((account) => account.card?.lastFour === ending),
      )
      return known &&
        (byBank.length === 0 ||
          byEnding.every((account) => byBank.includes(account)))
        ? byEnding
        : []
    }
    const debits = yield* findBillDebits({
      currency: card.currency,
      from: firstCycle.closingOn,
      through: addDays(lastCycle.closingOn, billPaymentWindowDays),
    })
    const billDebits = debits.flatMap((debit) => {
      // Paired with a payment already counted on the card: the same money.
      if (debit.pairedInflowId !== null && paymentIds.has(debit.pairedInflowId))
        return []
      const text = foldDescription(debit.description)
      if (!billHint.test(text)) return []
      const endings = statedEndings(text)
      const candidates = named(text, endings)
      const target =
        candidates.length === 1
          ? candidates[0]
          : endings.size === 0 && cards.length === 1 && cardHint.test(text)
            ? cards[0]
            : undefined
      return target?.id === accountId
        ? [
            {
              entryId: debit.id,
              paidOn: debit.bookedOn,
              amountCents: -debit.amountCents,
            },
          ]
        : []
    })
    if (billDebits.length === 0) return known
    const inferred = billPayments({ ...history, payments, debits: billDebits })
    return inferred.length === 0
      ? known
      : cardCycles({ ...history, payments: [...payments, ...inferred] })
  })

  return { cycles }
})

export class Cards extends Context.Service<
  Cards,
  Effect.Success<typeof make>
>()('@spendle/server/reconciliation/Cards') {
  static readonly layer = Layer.effect(Cards, make)
}

export type { CardCycle, CardCycles }
