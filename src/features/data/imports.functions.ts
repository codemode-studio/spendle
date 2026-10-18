import { createServerFn } from '@tanstack/react-start'
import * as Schema from 'effect/Schema'

import { api } from '#/lib/api/client.server'

/** A statement upload: the account and one OFX, CSV or PDF file. */
function readUpload(data: unknown) {
  if (!(data instanceof FormData))
    throw new Error('Envie o arquivo do extrato.')
  const accountId = data.get('accountId')
  const file = data.get('file')
  if (typeof accountId !== 'string' || !accountId)
    throw new Error('Escolha a conta do extrato.')
  if (!(file instanceof File) || file.size === 0)
    throw new Error('Escolha um arquivo OFX, CSV ou PDF.')
  return { accountId, file }
}

function forward(upload: { accountId: string; file: File }) {
  const form = new FormData()
  form.append('accountId', upload.accountId)
  form.append('file', upload.file, upload.file.name)
  return form
}

/** What the file contains, checked against the account; nothing is recorded. */
export const previewImportFn = createServerFn({ method: 'POST' })
  .validator(readUpload)
  .handler(({ data }) =>
    api((client) => client.imports.preview({ payload: forward(data) })),
  )

/** Records the file's movements and balances; the same file again changes nothing. */
export const uploadImportFn = createServerFn({ method: 'POST' })
  .validator(readUpload)
  .handler(({ data }) =>
    api((client) => client.imports.upload({ payload: forward(data) })),
  )

export const listImportsFn = createServerFn({ method: 'GET' })
  .validator(
    Schema.toStandardSchemaV1(
      Schema.Struct({ accountId: Schema.optional(Schema.String) }),
    ),
  )
  .handler(({ data }) => api((client) => client.imports.list({ query: data })))
