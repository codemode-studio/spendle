import * as Result from 'effect/Result'

import { fingerprintIds, parseDate, parseMoney } from './Statement.ts'
import type {
  ParsedStatement,
  StatementLine,
  StatementProblem,
} from './Statement.ts'

const key = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')

const columns = {
  date: [
    'data',
    'data_lancamento',
    'data_da_transacao',
    'data_movimento',
    'date',
    'posted_at',
  ],
  description: [
    'descricao',
    'descricao_da_transacao',
    'historico',
    'estabelecimento',
    'lancamento',
    'title',
    'description',
    'memo',
  ],
  debit: ['debito', 'valor_debito', 'debit', 'withdrawal', 'saida'],
  credit: ['credito', 'valor_credito', 'credit', 'deposit', 'entrada'],
  amount: ['valor', 'valor_rs', 'valor_bruto', 'amount', 'transaction_amount'],
  direction: ['tipo', 'natureza', 'direction', 'credito_debito', 'd_c'],
  balance: ['saldo', 'saldo_rs', 'balance', 'running_balance'],
  id: ['id', 'identificador', 'transaction_id', 'fitid', 'codigo'],
  currency: ['moeda', 'currency', 'currency_code'],
} as const

const pick = (row: Record<string, string>, names: ReadonlyArray<string>) =>
  names
    .map((name) => row[name])
    .find((value) => value !== undefined && value !== '') ?? ''

/**
 * Splits CSV text into rows of fields, honouring quotes and doubled quotes.
 * Returns null when a quote is never closed: the rest of the file would
 * otherwise be swallowed into one field.
 */
export const splitCsv = (text: string, delimiter: string) => {
  const rows: Array<Array<string>> = []
  let row: Array<string> = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"'
        index++
      } else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === delimiter) {
      row.push(field.trim())
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++
      row.push(field.trim())
      if (row.some((value) => value !== '')) rows.push(row)
      row = []
      field = ''
    } else field += char
  }
  if (quoted) return null
  row.push(field.trim())
  if (row.some((value) => value !== '')) rows.push(row)
  return rows
}

const hasAny = (headers: ReadonlyArray<string>, names: ReadonlyArray<string>) =>
  headers.some((header) => names.includes(header))

// Finds the header line, skipping any summary lines a bank puts above the table.
const findTable = (text: string) => {
  const lines = text.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    for (const delimiter of [';', ',', '\t']) {
      const headers = line.split(delimiter).map(key)
      if (
        hasAny(headers, columns.date) &&
        hasAny(headers, columns.description) &&
        hasAny(headers, [
          ...columns.amount,
          ...columns.debit,
          ...columns.credit,
        ])
      ) {
        return {
          delimiter,
          preamble: lines.slice(0, index),
          body: lines.slice(index).join('\n'),
        }
      }
    }
  }
  return null
}

const readPreamble = (lines: ReadonlyArray<string>, delimiter: string) => {
  let accountHint: string | null = null
  let period: ParsedStatement['period'] = null
  let balance: number | null = null
  for (const line of lines) {
    const [rawKey = '', ...rest] = line.split(delimiter)
    const label = key(rawKey)
    const value = rest.join(' ').trim()
    if (!value) continue
    if (label === 'conta') {
      const digits = value.replace(/\D/g, '')
      accountHint = digits.length >= 4 ? digits.slice(-4) : null
    } else if (label === 'periodo') {
      const dates = (
        value.match(/\d{4}-\d{2}-\d{2}|\d{2}[/.-]\d{2}[/.-]\d{2,4}/g) ?? []
      ).map(parseDate)
      if (dates[0] && dates[1]) period = { start: dates[0], end: dates[1] }
    } else if (/^saldo(_|$)/.test(label)) {
      balance = parseMoney(value)
    }
  }
  return { accountHint, period, balance }
}

// Direction words differ by statement: on a card, "pagamento" is money in.
const outflowWords = {
  account: /deb|saida|compra|pagamento|^d$/,
  card: /deb|compra|saida|^d$/,
}
const inflowWords = {
  account: /cred|entrada|recebimento|estorno|^c$/,
  card: /cred|pagamento|recebimento|estorno|entrada|^c$/,
}

const amountOf = (row: Record<string, string>, kind: 'account' | 'card') => {
  const debitText = pick(row, columns.debit)
  const creditText = pick(row, columns.credit)
  if (debitText || creditText) {
    const debit = debitText ? parseMoney(debitText) : 0
    const credit = creditText ? parseMoney(creditText) : 0
    if (debit === null || credit === null) return null
    // A zero in one column is a placeholder; two non-zero values contradict.
    if (debit !== 0 && credit !== 0) return null
    return debit !== 0 ? -Math.abs(debit) : Math.abs(credit)
  }
  const raw = pick(row, columns.amount)
  const cents = parseMoney(raw)
  if (cents === null) return null
  const direction = key(pick(row, columns.direction))
  if (outflowWords[kind].test(direction)) return -Math.abs(cents)
  if (inflowWords[kind].test(direction)) return Math.abs(cents)
  // Card exports sign amounts from the statement's view: a purchase is
  // positive and a payment or refund negative, the opposite of the ledger.
  return kind === 'card' ? -cents : cents
}

interface BalancePoint {
  /** Position among the parsed lines. */
  readonly index: number
  readonly bookedOn: string
  readonly balanceCents: number
}

/**
 * Checks known running balances against the amounts between them, in file
 * order (oldest first) or reversed (newest first). Rows without a balance are
 * crossed using their amounts, so a blank cell cannot hide a mismatch. Card
 * exports may keep balances in the statement's sign, so both signs are tried.
 */
const balanceOrder = (
  amounts: ReadonlyArray<number>,
  points: ReadonlyArray<BalancePoint>,
): 'ascending' | 'descending' | 'both' | null => {
  const between = (from: number, to: number, sign: number) => {
    let sum = 0
    for (let index = from; index < to; index++) sum += amounts[index]! * sign
    return sum
  }
  const fits = (order: 'ascending' | 'descending') =>
    [1, -1].some((sign) =>
      points.slice(1).every((point, position) => {
        const previous = points[position]!
        return order === 'ascending'
          ? previous.balanceCents +
              between(previous.index + 1, point.index + 1, sign) ===
              point.balanceCents
          : point.balanceCents + between(previous.index, point.index, sign) ===
              previous.balanceCents
      }),
    )
  const ascending = fits('ascending')
  const descending = fits('descending')
  return ascending && descending
    ? 'both'
    : ascending
      ? 'ascending'
      : descending
        ? 'descending'
        : null
}

/**
 * Parses a bank or card CSV export by recognizing its column names. A
 * running balance column must chain with the amounts, read top to bottom or
 * bottom to top; when it does, its latest value is the closing balance.
 */
export const parseCsv = (
  text: string,
  kind: 'account' | 'card',
): Result.Result<ParsedStatement, StatementProblem> => {
  const table = findTable(text.replace(/^﻿/, ''))
  if (table === null) return Result.fail('no_statement')
  const split = splitCsv(table.body, table.delimiter)
  if (split === null) return Result.fail('malformed_csv')
  const [headerRow = [], ...dataRows] = split
  const headers = headerRow.map(key)
  const preamble = readPreamble(table.preamble, table.delimiter)

  let rejectedRows = 0
  const lines: Array<
    Omit<StatementLine, 'externalId'> & { externalId?: string }
  > = []
  const balances: Array<BalancePoint> = []
  const currencies = new Set<string>()
  for (const values of dataRows) {
    const row = Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? '']),
    )
    const bookedOn = parseDate(pick(row, columns.date))
    const description = pick(row, columns.description)
    const amountCents = amountOf(row, kind)
    if (bookedOn === null || !description || amountCents === null) {
      rejectedRows++
      continue
    }
    const id = pick(row, columns.id)
    lines.push({
      ...(id ? { externalId: id } : {}),
      bookedOn,
      amountCents,
      description,
      raw: row,
    })
    const currency = pick(row, columns.currency).toUpperCase()
    if (currency) currencies.add(currency)
    const balanceCents = parseMoney(pick(row, columns.balance))
    if (balanceCents !== null)
      balances.push({ index: lines.length - 1, bookedOn, balanceCents })
  }
  if (currencies.size > 1) return Result.fail('mixed_currencies')

  let latestBalance: BalancePoint | undefined
  if (balances.length > 0) {
    const order = balanceOrder(
      lines.map((line) => line.amountCents),
      balances,
    )
    if (balances.length > 1 && order === null)
      return Result.fail('running_balance_mismatch')
    const first = balances[0]!
    const last = balances.at(-1)!
    // When both readings fit, the dates decide which end is the newest.
    latestBalance =
      order === 'descending' ||
      (order === 'both' && first.bookedOn > last.bookedOn)
        ? first
        : last
  }
  if (
    preamble.balance !== null &&
    latestBalance &&
    preamble.balance !== latestBalance.balanceCents
  ) {
    return Result.fail('summary_balance_mismatch')
  }

  const closingCents =
    kind === 'account'
      ? (preamble.balance ?? latestBalance?.balanceCents ?? null)
      : null
  const closingAsOf = preamble.period?.end ?? latestBalance?.bookedOn ?? null
  return Result.succeed({
    format: 'csv',
    currency: currencies.size === 1 ? [...currencies][0]! : null,
    accountKind: null,
    accountHint: kind === 'account' ? preamble.accountHint : null,
    period: preamble.period,
    closingBalance:
      closingCents !== null && closingAsOf !== null
        ? { asOf: closingAsOf, cents: closingCents }
        : null,
    lines: fingerprintIds(lines),
    rejectedRows,
  })
}
