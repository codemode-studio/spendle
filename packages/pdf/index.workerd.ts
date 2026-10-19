// Workers cannot read files or compile WebAssembly from bytes at run time;
// the bundler imports the binary as a module the runtime compiles on deploy.
import module from './wasm/pdf_bg.wasm'

import { makeReader } from './reader.ts'

export type { PdfRead, PdfTextItem } from './reader.ts'

export const readPdf = makeReader(() => module)
