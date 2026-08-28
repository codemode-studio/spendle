export interface PdfSourceBounds {
  page: number
  x: number
  y: number
  width: number
  height: number
}

export interface PdfPositionedLine {
  text: string
  bounds: PdfSourceBounds
}

export interface PdfParserTransaction {
  externalId?: string
  postedAt: string
  description: string
  amountCents: number
  currency: string
  raw: {
    line: string
    bounds: PdfSourceBounds
  }
}

export interface PdfParserControls {
  openingBalanceCents: number | null
  openingBalanceAt: string | null
  closingBalanceCents: number | null
  closingBalanceType: 'posted' | 'available' | 'card_statement' | null
  balanceAsOf: string | null
  periodStart: string | null
  periodEnd: string | null
  dueDate: string | null
}

export interface PdfStatementParserInput {
  text: string
  lines: PdfPositionedLine[]
  currency: string
  institution: string | null
  kind: 'bank_statement' | 'card_statement' | 'unknown'
}

export interface PdfStatementParserResult {
  transactions: PdfParserTransaction[]
  controls: PdfParserControls
  sourceTransactionCount: number | null
}

export interface PdfStatementParser {
  id: string
  version: string
  institution: string
  kind: 'bank_statement' | 'card_statement'
  matches: (input: PdfStatementParserInput) => boolean
  parse: (input: PdfStatementParserInput) => PdfStatementParserResult
}
