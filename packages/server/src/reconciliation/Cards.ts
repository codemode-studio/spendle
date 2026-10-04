import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { today } from '../domain/LocalDate.ts'
import { foldDescription } from '../imports/Statement.ts'
import { Accounts } from '../ledger/Accounts.ts'
import { cardCycles } from './Cycles.ts'
import type { CardCycle, CyclePayment } from './Cycles.ts'

export class CardsError extends Schema.TaggedError<CardsError>()('CardsError', {
  reason: Schema.Literals(['not_a_card']),
  accountId: Schema.String,
}) {
  override get message(): string {
    return `Account ${this.accountId} is not a credit card`
  }
}

const EntryRow = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  accountKind: Schema.String,
  bookedOn: Schema.String,
  amountCents: Schema.Int,
  description: Schema.String,
})

const PaymentRelationRow = Schema.Struct({
  inflowEntryId: Schema.String,
  outflowEntryId: Schema.String,
})

const paymentHint = /\b(pagamento|pgto|pag)\b/
const billHint = /\b(fatura|cartao)\b/
const refundHint = /\b(estorno|reembolso|cancelamento)\b/

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const accounts = yield* Accounts

  const findEntries = SqlSchema.findAll({
    Request: Schema.Void,
    Result: EntryRow,
    execute: () => sql`
      SELECT e.id, e.account_id AS accountId, a.kind AS accountKind, e.booked_on AS bookedOn,
        e.amount_cents AS amountCents, e.description
      FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
      WHERE e.status = 'posted' AND a.archived_at IS NULL
    `,
  })
  const findPaymentRelations = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PaymentRelationRow,
    execute: () => sql`
      SELECT inflow_entry_id AS inflowEntryId, outflow_entry_id AS outflowEntryId
      FROM relations WHERE kind = 'card_payment'
    `,
  })
  const findRelated = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ entryId: Schema.String }),
    execute: () => sql`
      SELECT outflow_entry_id AS entryId FROM relations
      UNION SELECT inflow_entry_id FROM relations
    `,
  })
  const findStatements = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ asOf: Schema.String, cents: Schema.Int }),
    execute: (accountId) => sql`
      SELECT as_of AS asOf, balance_cents AS cents FROM balance_observations
      WHERE account_id = ${accountId} AND kind = 'statement'
      ORDER BY as_of, observed_at
    `,
  })

  /**
   * The card's statement cycles with what each one owes, what paid it, and
   * how its entries compare with the issued statement.
   *
   * Payments come from three places, most certain first:
   * 1. a card payment relation, dated by the bank debit;
   * 2. a credit on the card that says it is a payment;
   * 3. only a bank debit for a bill ("fatura", "cartão"), when the card
   *    side is missing (card PDFs omit payments). It counts when its amount
   *    is exactly what the cycle still owes and it names this card's bank,
   *    or this is the person's only card.
   */
  const cycles = Effect.fn('Cards.cycles')(function* (accountId: string) {
    const card = yield* accounts.get(accountId)
    if (card.card === null)
      return yield* new CardsError({ reason: 'not_a_card', accountId })
    const terms = card.card
    const [entries, paymentRelations, related, statements, all, date] =
      yield* Effect.all([
        findEntries(undefined),
        findPaymentRelations(undefined),
        findRelated(undefined),
        findStatements(accountId),
        accounts.list,
        today,
      ])
    const byId = new Map(entries.map((entry) => [entry.id, entry]))
    const relatedIds = new Set(related.map((row) => row.entryId))

    const payments: Array<CyclePayment> = []
    const paymentIds = new Set<string>()
    for (const relation of paymentRelations) {
      const inflow = byId.get(relation.inflowEntryId)
      const outflow = byId.get(relation.outflowEntryId)
      if (!inflow || inflow.accountId !== accountId) continue
      payments.push({
        entryId: inflow.id,
        paidOn: outflow?.bookedOn ?? inflow.bookedOn,
        amountCents: inflow.amountCents,
        via: 'card',
      })
      paymentIds.add(inflow.id)
    }
    const cardEntries = entries.filter((entry) => entry.accountId === accountId)
    for (const entry of cardEntries) {
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
    const purchases = cardEntries.filter((entry) => !paymentIds.has(entry.id))

    // Bank debits for a bill with no card-side credit settle what is exactly owed.
    const onlyCard =
      all.filter(
        (account) => account.kind === 'credit_card' && !account.archived,
      ).length === 1
    const bank = foldDescription(card.institutionName)
    const firstPass = cardCycles({
      terms,
      entries: purchases,
      payments,
      statements,
      today: date,
    })
    for (const debit of entries) {
      if (
        debit.accountKind === 'credit_card' ||
        debit.amountCents >= 0 ||
        relatedIds.has(debit.id)
      )
        continue
      const text = foldDescription(debit.description)
      if (!billHint.test(text) || !(onlyCard || text.includes(bank))) continue
      const settled = firstPass.find(
        (cycle) =>
          debit.bookedOn > cycle.closingOn &&
          -cycle.totalCents - cycle.paidCents === -debit.amountCents,
      )
      if (
        settled &&
        !payments.some((payment) => payment.entryId === debit.id)
      ) {
        payments.push({
          entryId: debit.id,
          paidOn: debit.bookedOn,
          amountCents: -debit.amountCents,
          via: 'bank',
        })
      }
    }

    return cardCycles({
      terms,
      entries: purchases,
      payments,
      statements,
      today: date,
    })
  })

  return { cycles }
})

export class Cards extends Context.Service<
  Cards,
  Effect.Success<typeof make>
>()('@spendle/server/reconciliation/Cards') {
  static readonly layer = Layer.effect(Cards, make)
}

export type { CardCycle }
