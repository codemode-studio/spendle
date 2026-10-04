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

// Explicit bill-payment wording: "fatura", or a payment of a "cartão de crédito".
const billPaymentHint = (text: string) =>
  /\bfatura\b/.test(text) ||
  (/\b(pagamento|pagto|pgto|pag)\b/.test(text) &&
    /\bcartao (de )?credito\b/.test(text))
// A purchase, debit-card movement or withdrawal, not a bill payment.
const purchaseHint = /\b(compras?|debito|saque)\b/
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
  'cartao',
  'cartoes',
  'credito',
  'card',
])
// Card issuers a description may name, with the words each is known by.
const knownIssuers: ReadonlyArray<ReadonlyArray<string>> = [
  ['nubank', 'nu'],
  ['inter'],
  ['itau', 'itaucard', 'unibanco'],
  ['bradesco', 'bradescard'],
  ['santander'],
  ['caixa'],
  ['bb', 'brasil', 'ourocard'],
  ['c6'],
  ['xp'],
  ['btg'],
  ['picpay'],
  ['mercadopago'],
  ['neon'],
  ['pan'],
  ['sicredi'],
  ['sicoob'],
  ['porto'],
  ['credicard'],
  ['hipercard'],
  ['digio'],
  ['banrisul'],
  ['safra'],
]
/** The words naming an institution: its distinctive words and their known aliases. */
const issuerWords = (institutionName: string) => {
  const own = foldDescription(institutionName)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2 && !genericBankWords.has(word))
  return new Set([
    ...own,
    ...knownIssuers
      .filter((aliases) => aliases.some((alias) => own.includes(alias)))
      .flat(),
  ])
}
// A number labeled as a reference rather than a card, taken whole with its
// formatting: "ref 1234", "boleto 8765-1234", "nsu: 1234.5678", "cod. no 1234".
const referenceNumber =
  /\b(?:ref|referencia|doc|documento|nsu|protocolo|autenticacao|aut|codigo|cod|boleto|id|identificador)(?:[\s.:#º°-]+|n[º°o]?(?![a-z]))*\d+(?:[\s./-]+\d+)*/g
// A four-digit number marked as a card's ending: "final 1234", "final: 1234",
// "cartao 1234", "****1234", "•1234", "xxxx-1234".
const cardEnding =
  /(?:\bfinal|\bcartao|\bcard|[*•]+|\bx+)[\s:#.-]*(\d{4})(?!\d)/g

// Words a bill payment's description may carry besides the card's issuer:
// payment and bill wording, card brands and transfer channels. Any other
// word may name an issuer, so it must be one of the card's.
const billWords = new Set([
  ...genericBankWords,
  'pagamento',
  'pagto',
  'pgto',
  'pag',
  'fatura',
  'final',
  'dos',
  'das',
  'ref',
  'referencia',
  'competencia',
  'vencimento',
  'venc',
  'boleto',
  'pix',
  'ted',
  'doc',
  'online',
  'on',
  'line',
  'internet',
  'app',
  'visa',
  'mastercard',
  'master',
  'elo',
  'amex',
])
/** A card a bank debit may name. */
export interface BillCard {
  readonly id: string
  readonly institutionName: string
  readonly lastFour: string | null
}

/**
 * Whether a bank debit's description says it pays `card`'s bill. It must
 * say it pays a card bill ("fatura", or a payment of a "cartão de crédito")
 * without purchase or debit-card wording, and identify `card` among `cards`
 * (every card it could pay, `card` included): by its recorded ending marked
 * as one ("final 1234", "*1234"), or by naming its issuer when that issuer
 * has no other card. Naming another issuer or ending, or an ending no card
 * has, identifies no card; so does any other name besides bill wording, as
 * it may be an issuer that no card or alias list knows. Numbers labeled as
 * references are not endings, and unmarked numbers say nothing.
 */
export const namesCardBill = (
  description: string,
  card: BillCard,
  cards: ReadonlyArray<BillCard>,
): boolean => {
  const text = foldDescription(description)
  if (!billPaymentHint(text) || purchaseHint.test(text)) return false
  const said = new Set(text.split(/[^a-z0-9]+/))
  const own = issuerWords(card.institutionName)
  const others = [
    ...knownIssuers.flat(),
    ...cards.flatMap((other) => [...issuerWords(other.institutionName)]),
  ]
  if (others.some((word) => said.has(word) && !own.has(word))) return false
  const byIssuer = cards.filter((other) =>
    [...issuerWords(other.institutionName)].some((word) => said.has(word)),
  )
  const unreferenced = text.replace(referenceNumber, ' ')
  const endings = new Set(
    [...unreferenced.matchAll(cardEnding)].map((match) => match[1]!),
  )
  if (endings.size > 1) return false
  // A name left once bill wording, references and the ending are set aside
  // may be an issuer no list knows: it must be this card's.
  const unexplained = unreferenced
    .replace(cardEnding, ' ')
    .split(/[^a-z0-9]+/)
    .filter(
      (word) =>
        word.length >= 2 &&
        !/^\d+$/.test(word) &&
        !billWords.has(word) &&
        !own.has(word),
    )
  if (unexplained.length > 0) return false
  const [ending] = endings
  const candidates =
    ending === undefined
      ? byIssuer
      : cards.filter(
          (other) =>
            other.lastFour === ending &&
            (byIssuer.length === 0 || byIssuer.includes(other)),
        )
  return candidates.length === 1 && candidates[0]!.id === card.id
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
      floorsAtZero: Schema.BooleanFromBit,
    }),
    execute: (accountId) => sql`
      SELECT f.period_start AS startsOn, b.as_of AS closingOn, b.balance_cents AS cents,
        f.due_on AS dueOn, f.charges_only = 0 AS netOfPayments,
        f.floors_at_zero AS floorsAtZero
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
   *    payments). The debit must be in the card's currency, say it pays a
   *    card bill and identify this card and no other (see `namesCardBill`).
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

    const cards = all
      .filter(
        (account) =>
          account.kind === 'credit_card' &&
          !account.archived &&
          account.currency === card.currency,
      )
      .map((account): BillCard => ({
        id: account.id,
        institutionName: account.institutionName,
        lastFour: account.card?.lastFour ?? null,
      }))
    const self: BillCard = {
      id: card.id,
      institutionName: card.institutionName,
      lastFour: terms.lastFour,
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
      return namesCardBill(debit.description, self, cards)
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
