import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { addDays, today } from '../domain/LocalDate.ts'
import { foldDescription } from '../imports/Statement.ts'
import { Accounts } from '../ledger/Accounts.ts'
import { cardCycles } from './Cycles.ts'
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
// A bill is paid within this many days of its closing.
const paymentWindowDays = 45

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const accounts = yield* Accounts

  const findCardEntries = SqlSchema.findAll({
    Request: Schema.String,
    Result: CardEntryRow,
    execute: (accountId) => sql`
      SELECT e.id, e.booked_on AS bookedOn, e.amount_cents AS amountCents, e.description,
        (SELECT MAX(json_extract(o.raw, '$.installment.billId'))
          FROM entry_evidence v JOIN transaction_observations o
            ON o.source_id = v.source_id AND o.account_id = v.account_id AND o.external_id = v.external_id
          WHERE v.entry_id = e.id) AS billId
      FROM ledger_entries e
      WHERE e.account_id = ${accountId} AND e.status = 'posted'
    `,
  })
  // Confirmed payments into the card, dated by the bank debit.
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
  // Bank debits that could pay a bill: posted, in the card's currency, worded
  // like a bill, and not already one side of a relation.
  const findBillDebits = SqlSchema.findAll({
    Request: Schema.Struct({ currency: Schema.String, from: Schema.String }),
    Result: DebitRow,
    execute: ({ currency, from }) => sql`
      SELECT e.id, e.booked_on AS bookedOn, e.amount_cents AS amountCents, e.description
      FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
      WHERE a.kind <> 'credit_card' AND a.archived_at IS NULL
        AND e.status = 'posted' AND e.amount_cents < 0
        AND e.currency = ${currency} AND e.booked_on > ${from}
        AND (e.description LIKE '%fatura%' OR e.description LIKE '%cart%'
          OR e.description LIKE '%cr_dito%')
        AND NOT EXISTS (
          SELECT 1 FROM relations r
          WHERE r.outflow_entry_id = e.id OR r.inflow_entry_id = e.id
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
    }),
    execute: (accountId) => sql`
      SELECT f.period_start AS startsOn, b.as_of AS closingOn, b.balance_cents AS cents
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
   * 1. a confirmed card payment relation, dated by the bank debit;
   * 2. a credit on the card that says it is a payment;
   * 3. only a bank debit, when the card side is missing (card PDFs may omit
   *    payments). The debit must be in the card's currency and identify
   *    this card and no other one: it names the card's bank or last four
   *    digits, or says "cartão"/"crédito" when there is a single card. Its
   *    amount must be exactly what one closed cycle still owes.
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
          amountCents: entry.amountCents,
          via: 'card',
        })
        paymentIds.add(entry.id)
      }
    }
    const purchases = entries.filter((entry) => !paymentIds.has(entry.id))
    const build = () =>
      cardCycles({
        terms,
        entries: purchases,
        payments,
        statements,
        today: date,
      })

    let current = build()
    const firstCycle = current.cycles[0]
    if (firstCycle === undefined) return current

    const cards = all.filter(
      (account) =>
        account.kind === 'credit_card' &&
        !account.archived &&
        account.currency === card.currency,
    )
    // The last four digits name one card; the bank's name, every card of that bank.
    const named = (text: string) => {
      const said = new Set(text.split(/[^a-z0-9]+/))
      const byDigits = cards.filter(
        (account) =>
          account.card?.lastFour != null && said.has(account.card.lastFour),
      )
      return byDigits.length > 0
        ? byDigits
        : cards.filter((account) =>
            bankWords(account.institutionName).some((word) => said.has(word)),
          )
    }
    const debits = yield* findBillDebits({
      currency: card.currency,
      from: firstCycle.closingOn,
    })
    for (const debit of debits) {
      const text = foldDescription(debit.description)
      if (!billHint.test(text)) continue
      const candidates = named(text)
      const target =
        candidates.length === 1
          ? candidates[0]
          : candidates.length === 0 && cards.length === 1 && cardHint.test(text)
            ? cards[0]
            : undefined
      if (target?.id !== accountId) continue
      const settles = current.cycles.filter(
        (cycle) =>
          cycle.closingOn < debit.bookedOn &&
          debit.bookedOn <= addDays(cycle.closingOn, paymentWindowDays) &&
          cycle.billedCents - cycle.paidCents === -debit.amountCents,
      )
      if (settles.length !== 1) continue
      payments.push({
        entryId: debit.id,
        paidOn: debit.bookedOn,
        amountCents: -debit.amountCents,
        via: 'bank',
      })
      current = build()
    }
    return current
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
