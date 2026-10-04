import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { Currency } from '../domain/Money.ts'
import { EventLog } from '../events/EventLog.ts'

export const OwnerKind = Schema.Literals(['person', 'company', 'household'])
export const AccountKind = Schema.Literals([
  'checking',
  'savings',
  'cash',
  'investment',
  'credit_card',
])
export const AccountPurpose = Schema.Literals([
  'operating',
  'reserve',
  'investment',
])

const DayOfMonth = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 31 }),
)

export class Owner extends Schema.Class<Owner>('Owner')({
  id: Schema.String,
  name: Schema.NonEmptyString,
  kind: OwnerKind,
}) {}

export class CardTerms extends Schema.Class<CardTerms>('CardTerms')({
  closingDay: DayOfMonth,
  dueDay: DayOfMonth,
  limitCents: Schema.NullOr(Schema.Int),
  lastFour: Schema.NullOr(Schema.String),
}) {}

export class Account extends Schema.Class<Account>('Account')({
  id: Schema.String,
  ownerId: Schema.String,
  institutionId: Schema.String,
  institutionName: Schema.String,
  name: Schema.NonEmptyString,
  kind: AccountKind,
  purpose: AccountPurpose,
  currency: Currency,
  card: Schema.NullOr(CardTerms),
  archived: Schema.Boolean,
}) {}

export const OpenAccount = Schema.Struct({
  ownerId: Schema.String,
  institutionName: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  kind: AccountKind,
  purpose: AccountPurpose,
  currency: Currency,
  card: Schema.optional(CardTerms),
})
export type OpenAccount = typeof OpenAccount.Type

/** Fields a person may change. Currency is fixed once an account exists. */
export const AccountChanges = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyString),
  institutionName: Schema.optional(Schema.NonEmptyString),
  kind: Schema.optional(AccountKind),
  purpose: Schema.optional(AccountPurpose),
  card: Schema.optional(CardTerms),
})
export type AccountChanges = typeof AccountChanges.Type

export class AccountNotFound extends Schema.TaggedError<AccountNotFound>()(
  'AccountNotFound',
  { accountId: Schema.String },
) {
  override get message(): string {
    return `Account ${this.accountId} not found`
  }
}

export class OwnerNotFound extends Schema.TaggedError<OwnerNotFound>()(
  'OwnerNotFound',
  {
    ownerId: Schema.String,
  },
) {
  override get message(): string {
    return `Owner ${this.ownerId} not found`
  }
}

export class InvalidAccount extends Schema.TaggedError<InvalidAccount>()(
  'InvalidAccount',
  {
    reason: Schema.Literals([
      'card_terms_required',
      'card_terms_forbidden',
      'investment_purpose',
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case 'card_terms_required':
        return 'A credit card needs closing and due days'
      case 'card_terms_forbidden':
        return 'Only a credit card has card terms'
      case 'investment_purpose':
        return 'An investment account must have the investment purpose'
    }
  }
}

export class LedgerStoreError extends Schema.TaggedError<LedgerStoreError>()(
  'LedgerStoreError',
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Ledger ${this.operation} failed`
  }
}

// A credit card is the only kind with card terms, and a brokerage account is
// always an investment. Changing kind across that line would orphan or invent
// statement cycles, so it is rejected rather than coerced.
const validate = (account: {
  kind: Account['kind']
  purpose: Account['purpose']
  card?: CardTerms | null | undefined
}) => {
  if (account.kind === 'credit_card' && !account.card) {
    return Effect.fail(new InvalidAccount({ reason: 'card_terms_required' }))
  }
  if (account.kind !== 'credit_card' && account.card) {
    return Effect.fail(new InvalidAccount({ reason: 'card_terms_forbidden' }))
  }
  if (account.kind === 'investment' && account.purpose !== 'investment') {
    return Effect.fail(new InvalidAccount({ reason: 'investment_purpose' }))
  }
  return Effect.void
}

const AccountRow = Schema.Struct({
  id: Schema.String,
  ownerId: Schema.String,
  institutionId: Schema.String,
  institutionName: Schema.String,
  name: Schema.String,
  kind: AccountKind,
  purpose: AccountPurpose,
  currency: Schema.String,
  closingDay: Schema.NullOr(Schema.Int),
  dueDay: Schema.NullOr(Schema.Int),
  limitCents: Schema.NullOr(Schema.Int),
  lastFour: Schema.NullOr(Schema.String),
  archivedAt: Schema.NullOr(Schema.String),
})

const toAccount = (row: typeof AccountRow.Type) =>
  new Account({
    id: row.id,
    ownerId: row.ownerId,
    institutionId: row.institutionId,
    institutionName: row.institutionName,
    name: row.name,
    kind: row.kind,
    purpose: row.purpose,
    currency: row.currency,
    card:
      row.closingDay === null || row.dueDay === null
        ? null
        : new CardTerms({
            closingDay: row.closingDay,
            dueDay: row.dueDay,
            limitCents: row.limitCents,
            lastFour: row.lastFour,
          }),
    archived: row.archivedAt !== null,
  })

export interface AccountsShape {
  readonly createOwner: (input: {
    readonly name: string
    readonly kind: Owner['kind']
  }) => Effect.Effect<Owner, LedgerStoreError>
  readonly open: (
    input: OpenAccount,
  ) => Effect.Effect<Account, OwnerNotFound | InvalidAccount | LedgerStoreError>
  /** Applies a person's edit. Provider syncs never call this. */
  readonly update: (
    accountId: string,
    changes: AccountChanges,
  ) => Effect.Effect<
    Account,
    AccountNotFound | InvalidAccount | LedgerStoreError
  >
  readonly get: (
    accountId: string,
  ) => Effect.Effect<Account, AccountNotFound | LedgerStoreError>
  readonly list: Effect.Effect<ReadonlyArray<Account>, LedgerStoreError>
}

export class Accounts extends Context.Service<Accounts, AccountsShape>()(
  '@spendle/server/ledger/Accounts',
) {
  static readonly layer = Layer.effect(
    Accounts,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const crypto = yield* Crypto.Crypto
      const log = yield* EventLog

      const storeError = (operation: string) => (cause: unknown) =>
        new LedgerStoreError({ operation, cause })
      const now = Effect.map(DateTime.now, DateTime.formatIso)
      const newId = crypto.randomUUIDv7.pipe(Effect.orDie)

      const selectAccounts = sql`
        SELECT a.id, a.owner_id AS ownerId, a.institution_id AS institutionId,
          i.name AS institutionName, a.name, a.kind, a.purpose, a.currency,
          t.closing_day AS closingDay, t.due_day AS dueDay, t.limit_cents AS limitCents,
          t.last_four AS lastFour, a.archived_at AS archivedAt
        FROM accounts a
        JOIN institutions i ON i.id = a.institution_id
        LEFT JOIN credit_card_terms t ON t.account_id = a.id
      `

      const findAccount = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: AccountRow,
        execute: (id) => sql`${selectAccounts} WHERE a.id = ${id}`,
      })
      const findAll = SqlSchema.findAll({
        Request: Schema.Void,
        Result: AccountRow,
        execute: () => sql`${selectAccounts} ORDER BY a.name`,
      })
      const findInstitution = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Schema.Struct({ id: Schema.String }),
        execute: (name) =>
          sql`SELECT id FROM institutions WHERE lower(name) = lower(${name})`,
      })
      const findOwner = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Schema.Struct({ id: Schema.String }),
        execute: (id) => sql`SELECT id FROM owners WHERE id = ${id}`,
      })

      const institutionId = (name: string) =>
        Effect.gen(function* () {
          const trimmed = name.trim()
          const existing = yield* findInstitution(trimmed)
          if (Option.isSome(existing)) return existing.value.id
          const id = yield* newId
          yield* sql`INSERT INTO institutions (id, name, created_at) VALUES (${id}, ${trimmed}, ${yield* now})`
          return id
        })

      const writeTerms = (
        accountId: string,
        card: CardTerms | null | undefined,
      ) =>
        card
          ? sql`
              INSERT INTO credit_card_terms (account_id, closing_day, due_day, limit_cents, last_four)
              VALUES (${accountId}, ${card.closingDay}, ${card.dueDay}, ${card.limitCents}, ${card.lastFour})
              ON CONFLICT (account_id) DO UPDATE SET closing_day = excluded.closing_day,
                due_day = excluded.due_day, limit_cents = excluded.limit_cents,
                last_four = excluded.last_four
            `
          : Effect.void

      const get = Effect.fn('Accounts.get')(function* (accountId: string) {
        const row = yield* findAccount(accountId).pipe(
          Effect.mapError(storeError('get')),
        )
        if (Option.isNone(row)) return yield* new AccountNotFound({ accountId })
        return toAccount(row.value)
      })

      const createOwner = Effect.fn('Accounts.createOwner')(function* (input: {
        readonly name: string
        readonly kind: Owner['kind']
      }) {
        const owner = new Owner({
          id: yield* newId,
          name: input.name,
          kind: input.kind,
        })
        yield* sql`
          INSERT INTO owners (id, name, kind, created_at)
          VALUES (${owner.id}, ${owner.name}, ${owner.kind}, ${yield* now})
        `.pipe(Effect.mapError(storeError('createOwner')))
        return owner
      })

      const open = Effect.fn('Accounts.open')(function* (input: OpenAccount) {
        yield* validate(input)
        const id = yield* newId
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              if (Option.isNone(yield* findOwner(input.ownerId))) {
                return yield* new OwnerNotFound({ ownerId: input.ownerId })
              }
              yield* sql`
                INSERT INTO accounts (id, owner_id, institution_id, name, kind, purpose, currency, created_at)
                VALUES (${id}, ${input.ownerId}, ${yield* institutionId(input.institutionName)},
                  ${input.name.trim()}, ${input.kind}, ${input.purpose}, ${input.currency}, ${yield* now})
              `
              yield* writeTerms(id, input.card)
              yield* log.append([
                {
                  type: 'AccountOpened',
                  streamId: id,
                  payload: { accountId: id },
                },
              ])
            }),
          )
          .pipe(
            Effect.catchTag(
              ['SqlError', 'SchemaError', 'EventLogError'],
              (cause) => Effect.fail(storeError('open')(cause)),
            ),
          )
        return yield* get(id).pipe(
          Effect.catchTag('AccountNotFound', Effect.die),
        )
      })

      const update = Effect.fn('Accounts.update')(function* (
        accountId: string,
        changes: AccountChanges,
      ) {
        const current = yield* get(accountId)
        const next = {
          kind: changes.kind ?? current.kind,
          purpose: changes.purpose ?? current.purpose,
          card: changes.card ?? current.card,
        }
        yield* validate(next)
        const changed = Object.keys(changes).filter(
          (key) => changes[key as keyof AccountChanges] !== undefined,
        )
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const institution =
                changes.institutionName === undefined
                  ? current.institutionId
                  : yield* institutionId(changes.institutionName)
              yield* sql`
                UPDATE accounts SET name = ${changes.name?.trim() ?? current.name},
                  institution_id = ${institution}, kind = ${next.kind}, purpose = ${next.purpose}
                WHERE id = ${accountId}
              `
              yield* writeTerms(accountId, changes.card)
              yield* log.append([
                {
                  type: 'AccountUpdated',
                  streamId: accountId,
                  payload: { accountId, changed },
                },
              ])
            }),
          )
          .pipe(Effect.mapError(storeError('update')))
        return yield* get(accountId)
      })

      const list = findAll(undefined).pipe(
        Effect.map((rows) => rows.map(toAccount)),
        Effect.mapError(storeError('list')),
        Effect.withSpan('Accounts.list'),
      )

      return Accounts.of({ createOwner, open, update, get, list })
    }),
  )
}
