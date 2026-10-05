import * as Schema from 'effect/Schema'

/**
 * Every API failure has the same body: `{ _tag, reason, detail }`. `_tag`
 * names the class of failure and fixes the status code; `reason` is a stable
 * machine-readable code a client can switch on; `detail` says which record
 * or value it is about, or is null.
 */
const fields = {
  reason: Schema.String,
  detail: Schema.NullOr(Schema.String),
}

/** The record the request names does not exist. */
export class NotFound extends Schema.TaggedError<NotFound>()(
  'NotFound',
  fields,
  { httpApiStatus: 404 },
) {}

/** The request is malformed: a field fails its schema or a value is out of range. */
export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()(
  'InvalidRequest',
  fields,
  { httpApiStatus: 400 },
) {}

/** The request conflicts with the current state: already linked, disconnected, taken. */
export class Conflict extends Schema.TaggedError<Conflict>()(
  'Conflict',
  fields,
  { httpApiStatus: 409 },
) {}

/** The request is well formed but a domain rule refuses it, as a file that does not prove its balance. */
export class Rejected extends Schema.TaggedError<Rejected>()(
  'Rejected',
  fields,
  { httpApiStatus: 422 },
) {}

/** Pluggy failed or refused to answer. */
export class ProviderFailed extends Schema.TaggedError<ProviderFailed>()(
  'ProviderFailed',
  fields,
  { httpApiStatus: 502 },
) {}

/** A feature is not configured on this server, as Open Finance without Pluggy credentials. */
export class Unavailable extends Schema.TaggedError<Unavailable>()(
  'Unavailable',
  fields,
  { httpApiStatus: 503 },
) {}

/** `SPENDLE_API_TOKEN` is set and the request did not carry it. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  'Unauthorized',
  fields,
  { httpApiStatus: 401 },
) {}

/** Storage failed; the server log has the cause. */
export class InternalError extends Schema.TaggedError<InternalError>()(
  'InternalError',
  fields,
  { httpApiStatus: 500 },
) {}

export type ApiError =
  | NotFound
  | InvalidRequest
  | Conflict
  | Rejected
  | ProviderFailed
  | Unavailable
  | Unauthorized
  | InternalError

/**
 * What every `/api/v2` endpoint may answer besides its success. The
 * middleware adds `Unauthorized` and `InvalidRequest` for a bad token or body.
 */
export const EndpointErrors = [
  NotFound,
  InvalidRequest,
  Conflict,
  Rejected,
  ProviderFailed,
  Unavailable,
  InternalError,
] as const
