import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

import { EventLog } from '../events/EventLog.ts'
import { Accounts } from '../ledger/Accounts.ts'
import type { Account } from '../ledger/Accounts.ts'
import { Observations } from '../ledger/Observations.ts'
import { parseCsv } from './Csv.ts'
import { decodeOfx, looksLikeOfx, parseOfx } from './Ofx.ts'
import { extractPdfText, looksLikePdf, parsePdf } from './Pdf.ts'
import { decodeUndeclared } from './Statement.ts'
import type { ParsedStatement } from './Statement.ts'

export const fileImported = 'FileImported'

export class ImportRejected extends Schema.TaggedError<ImportRejected>()(
  'ImportRejected',
  {
    reason: Schema.Literals([
      'unsupported_format',
      'no_statement',
      'multiple_statements',
      'running_balance_mismatch',
      'summary_balance_mismatch',
      'mixed_currencies',
      'malformed_csv',
      'malformed_ofx',
      'unsupported_encoding',
      'invalid_date',
      'currency_mismatch',
      'account_mismatch',
      'imported_to_other_account',
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.detail ? `${this.reason}: ${this.detail}` : this.reason
  }
}

/** What a file contains, checked against the target account. */
export interface ImportPreview {
  readonly format: ParsedStatement['format']
  readonly period: ParsedStatement['period']
  readonly closingBalance: ParsedStatement['closingBalance']
  readonly lineCount: number
  readonly rejectedRows: number
  readonly firstDate: string | null
  readonly lastDate: string | null
  readonly inflowCents: number
  readonly outflowCents: number
}

export interface ImportResult extends ImportPreview {
  readonly importId: string
  readonly sourceId: string
  /** True when this exact file had already been imported. */
  readonly alreadyImported: boolean
  readonly recorded: number
  readonly unchanged: number
}

/** A stored file, without its content. */
export const ImportSummary = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  sourceId: Schema.String,
  fileName: Schema.String,
  format: Schema.Literals(['ofx', 'csv', 'pdf']),
  periodStart: Schema.NullOr(Schema.String),
  periodEnd: Schema.NullOr(Schema.String),
  dueOn: Schema.NullOr(Schema.String),
  lineCount: Schema.Int,
  rejectedRows: Schema.Int,
  importedAt: Schema.String,
})

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

const parseText = (bytes: Uint8Array, kind: 'account' | 'card') => {
  const ofx = decodeOfx(bytes)
  if (Result.isFailure(ofx)) return Result.fail(ofx.failure)
  if (looksLikeOfx(ofx.success)) return parseOfx(ofx.success)
  return parseCsv(decodeUndeclared(bytes), kind)
}

// Reads the bytes for the kind of account they are imported into.
const parse = Effect.fnUntraced(function* (
  bytes: Uint8Array,
  account: Account,
) {
  const kind = account.kind === 'credit_card' ? 'card' : 'account'
  const parsed = looksLikePdf(bytes)
    ? parsePdf(
        yield* extractPdfText(bytes).pipe(
          Effect.mapError(
            () =>
              new ImportRejected({
                reason: 'unsupported_format',
                detail: 'unreadable PDF',
              }),
          ),
        ),
        kind,
      )
    : parseText(bytes, kind)
  if (Result.isFailure(parsed))
    return yield* new ImportRejected({ reason: parsed.failure })
  return parsed.success
})

// Checks the file can belong to the account before anything is stored.
const check = (statement: ParsedStatement, account: Account) => {
  if (statement.currency !== null && statement.currency !== account.currency) {
    return Effect.fail(
      new ImportRejected({
        reason: 'currency_mismatch',
        detail: `${statement.currency} file, ${account.currency} account`,
      }),
    )
  }
  const accountKind = account.kind === 'credit_card' ? 'card' : 'account'
  if (statement.accountKind !== null && statement.accountKind !== accountKind) {
    return Effect.fail(
      new ImportRejected({
        reason: 'account_mismatch',
        detail:
          statement.accountKind === 'card'
            ? 'card statement for a bank account'
            : 'bank statement for a card',
      }),
    )
  }
  const lastFour = account.card?.lastFour ?? null
  if (
    statement.accountHint !== null &&
    lastFour !== null &&
    statement.accountHint !== lastFour
  ) {
    return Effect.fail(
      new ImportRejected({
        reason: 'account_mismatch',
        detail: `file is for •${statement.accountHint}`,
      }),
    )
  }
  return Effect.void
}

const summarize = (statement: ParsedStatement): ImportPreview => {
  const dates = statement.lines.map((line) => line.bookedOn).sort()
  return {
    format: statement.format,
    period: statement.period,
    closingBalance: statement.closingBalance,
    lineCount: statement.lines.length,
    rejectedRows: statement.rejectedRows,
    firstDate: dates[0] ?? null,
    lastDate: dates.at(-1) ?? null,
    inflowCents: statement.lines.reduce(
      (sum, line) => sum + Math.max(0, line.amountCents),
      0,
    ),
    outflowCents: statement.lines.reduce(
      (sum, line) => sum + Math.min(0, line.amountCents),
      0,
    ),
  }
}

const ExistingImport = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  sourceId: Schema.String,
})

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const crypto = yield* Crypto.Crypto
  const log = yield* EventLog
  const accounts = yield* Accounts
  const observations = yield* Observations

  const findBySha = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ExistingImport,
    execute: (sha) => sql`
      SELECT id, account_id AS accountId, source_id AS sourceId FROM import_files WHERE sha256 = ${sha}
    `,
  })

  const read = Effect.fnUntraced(function* (input: {
    readonly accountId: string
    readonly bytes: Uint8Array
  }) {
    const account = yield* accounts.get(input.accountId)
    const statement = yield* parse(input.bytes, account)
    yield* check(statement, account)
    return { account, statement }
  })

  /** Parses a file for review without storing anything. */
  const preview = Effect.fn('Imports.preview')(function* (input: {
    readonly accountId: string
    readonly bytes: Uint8Array
  }) {
    const { statement } = yield* read(input)
    return summarize(statement)
  })

  /**
   * Stores the file and records its lines and closing balance as observations
   * of the account. The same file again is a no-op; an overlapping file is a
   * separate source whose shared lines are matched in the resolution phase.
   */
  const importFile = Effect.fn('Imports.importFile')(function* (input: {
    readonly accountId: string
    readonly fileName: string
    readonly bytes: Uint8Array
  }) {
    const { account, statement } = yield* read(input)
    const summary = summarize(statement)
    const sha = hex(yield* crypto.digest('SHA-256', input.bytes))

    const existing = yield* findBySha(sha)
    if (Option.isSome(existing)) {
      if (existing.value.accountId !== account.id) {
        return yield* new ImportRejected({
          reason: 'imported_to_other_account',
        })
      }
      return {
        ...summary,
        importId: existing.value.id,
        sourceId: existing.value.sourceId,
        alreadyImported: true,
        recorded: 0,
        unchanged: summary.lineCount,
      } satisfies ImportResult
    }

    const importId = yield* crypto.randomUUIDv7
    const importedAt = DateTime.formatIso(yield* DateTime.now)
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const source = yield* observations.registerSource({
          kind: 'file',
          externalRef: sha,
          label: input.fileName,
        })
        yield* sql`
          INSERT INTO import_files (id, sha256, account_id, source_id, file_name, format, content,
            period_start, period_end, due_on, charges_only, floors_at_zero, advance_cents, line_count, rejected_rows,
            imported_at)
          VALUES (${importId}, ${sha}, ${account.id}, ${source.id}, ${input.fileName}, ${statement.format},
            ${input.bytes}, ${statement.period?.start ?? null}, ${statement.period?.end ?? null},
            ${statement.dueOn ?? null}, ${statement.chargesOnly ? 1 : 0}, ${statement.floorsAtZero ? 1 : 0},
            ${statement.advanceCents ?? null}, ${statement.lines.length}, ${statement.rejectedRows}, ${importedAt})
        `
        const recorded = yield* observations.recordTransactions({
          sourceId: source.id,
          accountId: account.id,
          transactions: statement.lines.map((line) => ({
            ...line,
            currency: account.currency,
            status: 'posted' as const,
          })),
        })
        if (statement.closingBalance) {
          yield* observations.recordBalance({
            sourceId: source.id,
            accountId: account.id,
            balance: {
              kind: 'statement',
              asOf: statement.closingBalance.asOf,
              balanceCents: statement.closingBalance.cents,
              currency: account.currency,
            },
          })
        }
        yield* log.append([
          {
            type: fileImported,
            streamId: account.id,
            payload: { importId, accountId: account.id, sourceId: source.id },
          },
        ])
        return {
          ...summary,
          importId,
          sourceId: source.id,
          alreadyImported: false,
          recorded: recorded.recorded.length,
          unchanged: recorded.unchanged,
        } satisfies ImportResult
      }),
    )
  })

  const findImports = SqlSchema.findAll({
    Request: Schema.NullOr(Schema.String),
    Result: ImportSummary,
    execute: (accountId) => sql`
      SELECT id, account_id AS accountId, source_id AS sourceId, file_name AS fileName,
        format, period_start AS periodStart, period_end AS periodEnd, due_on AS dueOn,
        line_count AS lineCount, rejected_rows AS rejectedRows, imported_at AS importedAt
      FROM import_files
      ${accountId === null ? sql`` : sql`WHERE account_id = ${accountId}`}
      ORDER BY imported_at DESC, id DESC
    `,
  })

  /** Stored files, latest first, of one account or all. */
  const list = Effect.fn('Imports.list')((accountId?: string) =>
    findImports(accountId ?? null),
  )

  return { preview, importFile, list }
})

export class Imports extends Context.Service<
  Imports,
  Effect.Success<typeof make>
>()('@spendle/server/imports/Imports') {
  static readonly layer = Layer.effect(Imports, make)
}
