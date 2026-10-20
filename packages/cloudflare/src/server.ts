import * as SqliteClient from '@effect/sql-sqlite-do/SqliteClient'
import { makeControlObject, makeSpaceObject } from '@spendle/server/durable'
import type { RemoteSpaces } from '@spendle/server/durable'

// The server the objects run, loaded on an object's first request (see
// `Control.ts` and `Space.ts`). Every module of the Worker shares one
// bundle, so importing this statically would make each isolate that only
// serves pages also evaluate the domain, the parsers and the PDF reader.

export const controlObject = (
  storage: DurableObjectStorage,
  spaces: RemoteSpaces,
  deployment: string,
) => makeControlObject(SqliteClient.layer({ storage }), spaces, deployment)

export const spaceObject = (
  storage: DurableObjectStorage,
  deployment: string,
) => makeSpaceObject(SqliteClient.layer({ storage }), deployment)
