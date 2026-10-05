import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import type * as Multipart from 'effect/http/Multipart'

import { Imports } from '../../imports/Imports.ts'
import { SpendleApi } from '../definition/Api.ts'
import { respond } from '../Failures.ts'

export const ImportsHandlers = HttpApiBuilder.group(
  SpendleApi,
  'imports',
  Effect.fn(function* (handlers) {
    const imports = yield* Imports
    const fs = yield* FileSystem.FileSystem
    // The upload is persisted to a request-scoped temporary file.
    const read = (file: Multipart.PersistedFile) => fs.readFile(file.path)
    return handlers.handleAll({
      preview: ({ payload }) =>
        read(payload.file).pipe(
          Effect.flatMap((bytes) =>
            imports.preview({ accountId: payload.accountId, bytes }),
          ),
          respond('imports.preview'),
        ),
      upload: ({ payload }) =>
        read(payload.file).pipe(
          Effect.flatMap((bytes) =>
            imports.importFile({
              accountId: payload.accountId,
              fileName: payload.file.name,
              bytes,
            }),
          ),
          respond('imports.upload'),
        ),
      list: ({ query }) =>
        imports.list(query.accountId).pipe(respond('imports.list')),
    })
  }),
)
