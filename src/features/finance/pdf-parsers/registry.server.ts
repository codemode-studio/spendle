import { interCardV1Parser } from './inter-card-v1.server'
import { mercadoPagoAccountV1Parser } from './mercado-pago-account-v1.server'
import { nubankAccountV1Parser } from './nubank-account-v1.server'
import { nubankCardV1Parser } from './nubank-card-v1.server'

import type { PdfStatementParserInput } from './types'

const pdfStatementParsers = [
  interCardV1Parser,
  nubankCardV1Parser,
  mercadoPagoAccountV1Parser,
  nubankAccountV1Parser,
]

export function selectPdfStatementParser(input: PdfStatementParserInput) {
  const matches = pdfStatementParsers.filter((parser) => parser.matches(input))
  return matches.length === 1 ? matches[0] : null
}
