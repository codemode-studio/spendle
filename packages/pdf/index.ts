import { readFileSync } from 'node:fs'

import { makeReader } from './reader.ts'

export type { PdfRead, PdfTextItem } from './reader.ts'

export const readPdf = makeReader(() =>
  readFileSync(new URL('./wasm/pdf_bg.wasm', import.meta.url)),
)
