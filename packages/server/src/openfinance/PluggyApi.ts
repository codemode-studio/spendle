import * as Schema from 'effect/Schema'

// The subset of Pluggy's REST payloads the ledger uses. Unknown fields are
// ignored, so additions on Pluggy's side do not break decoding.

const ProductStatus = Schema.Struct({
  isUpdated: Schema.Boolean,
  lastUpdatedAt: Schema.optional(Schema.NullOr(Schema.String)),
})

export const PluggyItem = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  executionStatus: Schema.optional(Schema.NullOr(Schema.String)),
  clientUserId: Schema.optional(Schema.NullOr(Schema.String)),
  connector: Schema.Struct({ id: Schema.Number, name: Schema.String }),
  // Per-product collection state; `isUpdated: false` means this execution did
  // not refresh that product, and `lastUpdatedAt` is when it last was.
  statusDetail: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        accounts: Schema.optional(Schema.NullOr(ProductStatus)),
        transactions: Schema.optional(Schema.NullOr(ProductStatus)),
      }),
    ),
  ),
  error: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        code: Schema.String,
        message: Schema.optional(Schema.String),
      }),
    ),
  ),
})
export type PluggyItem = typeof PluggyItem.Type

export const PluggyAccount = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(['BANK', 'CREDIT']),
  subtype: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.String,
  marketingName: Schema.optional(Schema.NullOr(Schema.String)),
  number: Schema.optional(Schema.NullOr(Schema.String)),
  balance: Schema.Number,
  currencyCode: Schema.String,
  creditData: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        creditLimit: Schema.optional(Schema.NullOr(Schema.Number)),
        balanceCloseDate: Schema.optional(Schema.NullOr(Schema.String)),
        balanceDueDate: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
})
export type PluggyAccount = typeof PluggyAccount.Type

export const PluggyTransaction = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  date: Schema.String,
  description: Schema.String,
  descriptionRaw: Schema.optional(Schema.NullOr(Schema.String)),
  type: Schema.Literals(['CREDIT', 'DEBIT']),
  amount: Schema.Number,
  amountInAccountCurrency: Schema.optional(Schema.NullOr(Schema.Number)),
  /** The account's running balance after this transaction, when the bank reports it. */
  balance: Schema.optional(Schema.NullOr(Schema.Number)),
  currencyCode: Schema.String,
  status: Schema.optional(Schema.Literals(['PENDING', 'POSTED'])),
  category: Schema.optional(Schema.NullOr(Schema.String)),
  providerCode: Schema.optional(Schema.NullOr(Schema.String)),
  operationType: Schema.optional(Schema.NullOr(Schema.String)),
  merchant: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: Schema.optional(Schema.NullOr(Schema.String)),
        businessName: Schema.optional(Schema.NullOr(Schema.String)),
        category: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  creditCardMetadata: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        installmentNumber: Schema.optional(Schema.NullOr(Schema.Number)),
        totalInstallments: Schema.optional(Schema.NullOr(Schema.Number)),
        totalAmount: Schema.optional(Schema.NullOr(Schema.Number)),
        purchaseDate: Schema.optional(Schema.NullOr(Schema.String)),
        billId: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
})
export type PluggyTransaction = typeof PluggyTransaction.Type

export const PluggyPage = <S extends Schema.Constraint>(item: S) =>
  Schema.Struct({ results: Schema.Array(item) })

export const PluggyCursorPage = <S extends Schema.Constraint>(item: S) =>
  Schema.Struct({
    results: Schema.Array(item),
    next: Schema.NullOr(Schema.String),
  })
