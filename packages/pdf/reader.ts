import { __wbg_reset_state, initSync, readPdf as read } from './wasm/pdf.js'

export type { PdfRead, PdfTextItem } from './wasm/pdf.js'

/**
 * The PDF reader over the compiled module `load` returns: its bytes on Node,
 * or the module the Workers runtime compiled at deploy time.
 */
export const makeReader = (load: () => Uint8Array | WebAssembly.Module) => {
  let ready = false
  /**
   * Reads a PDF's plain text, its text fragments with their positions and the
   * pages that need OCR. Throws when the bytes are not a readable PDF.
   */
  return (bytes: Uint8Array) => {
    if (!ready) {
      initSync({ module: load() })
      ready = true
    }
    try {
      return read(bytes)
    } catch (error) {
      // A Rust panic traps and can leave the instance's memory half written.
      // Starting a fresh instance after any failure is cheap and covers it.
      __wbg_reset_state()
      throw error
    }
  }
}
