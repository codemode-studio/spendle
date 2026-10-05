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
import { decodeUndeclared } from './Statement.ts'
import type { ParsedStatement, StatementProblem } from './Statement.ts'

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

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

const looksLikePdf = (bytes: Uint8Array) =>
  bytes[0] === 0x25 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x44 &&
  bytes[3] === 0x46

const parse = (
  bytes: Uint8Array,
  account: Account,
): Result.Result<ParsedStatement, StatementProblem> => {
  if (looksLikePdf(bytes)) return Result.fail('unsupported_format')
  const ofx = decodeOfx(bytes)
  if (Result.isFailure(ofx)) return Result.fail(ofx.failure)
  if (looksLikeOfx(ofx.success)) return parseOfx(ofx.success)
  return parseCsv(
    decodeUndeclared(bytes),
    account.kind === 'credit_card' ? 'card' : 'account',
  )
}

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
    const parsed = parse(input.bytes, account)
    if (Result.isFailure(parsed))
      return yield* new ImportRejected({ reason: parsed.failure })
    yield* check(parsed.success, account)
    return { account, statement: parsed.success }
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
            period_start, period_end, line_count, rejected_rows, imported_at)
          VALUES (${importId}, ${sha}, ${account.id}, ${source.id}, ${input.fileName}, ${statement.format},
            ${input.bytes}, ${statement.period?.start ?? null}, ${statement.period?.end ?? null},
            ${statement.lines.length}, ${statement.rejectedRows}, ${importedAt})
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

  return { preview, importFile }
})

export class Imports extends Context.Service<
  Imports,
  Effect.Success<typeof make>
>()('@spendle/server/imports/Imports') {
  static readonly layer = Layer.effect(Imports, make)
}
