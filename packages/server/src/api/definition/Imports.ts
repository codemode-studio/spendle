import * as Schema from 'effect/Schema'
import * as Multipart from 'effect/http/Multipart'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'

import { EndpointErrors } from './Errors.ts'

/** A statement file (OFX, CSV or PDF) for an account, as `multipart/form-data`. */
export const StatementUpload = Schema.Struct({
  accountId: Schema.String,
  file: Multipart.SingleFileSchema,
}).pipe(HttpApiSchema.asMultipart({ maxFileSize: '20 MB', maxParts: 2 }))

export const ImportFormat = Schema.Literals(['ofx', 'csv', 'pdf'])

/**
 * What a file contains, checked against the account. A file whose running
 * or summary balance does not add up is refused with `Rejected` and the
 * problem as `reason`; rows that looked like movements but could not be read
 * are counted in `rejectedRows`.
 */
export const ImportPreview = Schema.Struct({
  format: ImportFormat,
  period: Schema.NullOr(
    Schema.Struct({ start: Schema.String, end: Schema.String }),
  ),
  closingBalance: Schema.NullOr(
    Schema.Struct({ asOf: Schema.String, cents: Schema.Int }),
  ),
  lineCount: Schema.Int,
  rejectedRows: Schema.Int,
  firstDate: Schema.NullOr(Schema.String),
  lastDate: Schema.NullOr(Schema.String),
  inflowCents: Schema.Int,
  outflowCents: Schema.Int,
})

export const ImportResult = Schema.Struct({
  ...ImportPreview.fields,
  importId: Schema.String,
  sourceId: Schema.String,
  /** The same file was already imported; nothing changed. */
  alreadyImported: Schema.Boolean,
  recorded: Schema.Int,
  unchanged: Schema.Int,
})

export const ImportSummary = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  sourceId: Schema.String,
  fileName: Schema.String,
  format: ImportFormat,
  periodStart: Schema.NullOr(Schema.String),
  periodEnd: Schema.NullOr(Schema.String),
  dueOn: Schema.NullOr(Schema.String),
  lineCount: Schema.Int,
  rejectedRows: Schema.Int,
  importedAt: Schema.String,
})

export class ImportsApi extends HttpApiGroup.make('imports')
  .add(
    HttpApiEndpoint.post('preview', '/preview', {
      payload: StatementUpload,
      success: ImportPreview,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.post('upload', '/', {
      payload: StatementUpload,
      success: ImportResult,
      error: EndpointErrors,
    }),
    HttpApiEndpoint.get('list', '/', {
      query: { accountId: Schema.optional(Schema.String) },
      success: Schema.Array(ImportSummary),
      error: EndpointErrors,
    }),
  )
  .prefix('/api/imports') {}
