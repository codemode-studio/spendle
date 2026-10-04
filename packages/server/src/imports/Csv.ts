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

interface BalanceReading {
  readonly order: 'ascending' | 'descending'
  /** -1 when balances are kept in a card statement's sign. */
  readonly sign: 1 | -1
}

/**
 * Lists the readings under which known running balances chain with the
 * amounts between them: file order (oldest first) or reversed (newest
 * first). Rows without a balance are crossed using their amounts, so a blank
 * cell cannot hide a mismatch. Only card exports may keep balances in the
 * statement's sign; a bank balance moves with the signed amounts.
 */
const balanceReadings = (
  amounts: ReadonlyArray<number>,
  points: ReadonlyArray<BalancePoint>,
  kind: 'account' | 'card',
): ReadonlyArray<BalanceReading> => {
  const between = (from: number, to: number, sign: number) => {
    let sum = 0
    for (let index = from; index < to; index++) sum += amounts[index]! * sign
    return sum
  }
  const signs: ReadonlyArray<1 | -1> = kind === 'card' ? [1, -1] : [1]
  return (['ascending', 'descending'] as const).flatMap((order) =>
    signs
      .filter((sign) =>
        points.slice(1).every((point, position) => {
          const previous = points[position]!
          return order === 'ascending'
            ? previous.balanceCents +
                between(previous.index + 1, point.index + 1, sign) ===
                point.balanceCents
            : point.balanceCents +
                between(previous.index, point.index, sign) ===
                previous.balanceCents
        }),
      )
      .map((sign) => ({ order, sign })),
  )
}

/**
 * The balance after the newest line: the newest known balance carried
 * through the lines after it in chain order, one value per fitting sign.
 */
const closingPosition = (
  lines: ReadonlyArray<{
    readonly bookedOn: string
    readonly amountCents: number
  }>,
  points: ReadonlyArray<BalancePoint>,
  readings: ReadonlyArray<BalanceReading>,
) => {
  const ascending = readings.some((reading) => reading.order === 'ascending')
  const descending = readings.some((reading) => reading.order === 'descending')
  // When both readings fit, the dates decide which end is the newest.
  const order =
    descending && (!ascending || lines[0]!.bookedOn > lines.at(-1)!.bookedOn)
      ? 'descending'
      : 'ascending'
  const latest = order === 'ascending' ? points.at(-1)! : points[0]!
  const after =
    order === 'ascending'
      ? lines.slice(latest.index + 1)
      : lines.slice(0, latest.index)
  const candidates = readings
    .filter((reading) => reading.order === order)
    .map(
      (reading) =>
        latest.balanceCents +
        after.reduce((sum, line) => sum + line.amountCents * reading.sign, 0),
    )
  return {
    asOf: order === 'ascending' ? lines.at(-1)!.bookedOn : lines[0]!.bookedOn,
    candidates,
  }
}

/**
 * Parses a bank or card CSV export by recognizing its column names. A
 * running balance column must chain with the amounts, read top to bottom or
 * bottom to top; when it does, its newest value carried through any later
 * lines is the closing balance.
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

  let closing: ReturnType<typeof closingPosition> | null = null
  if (balances.length > 0) {
    const readings = balanceReadings(
      lines.map((line) => line.amountCents),
      balances,
      kind,
    )
    if (readings.length === 0) return Result.fail('running_balance_mismatch')
    closing = closingPosition(lines, balances, readings)
  }
  if (
    preamble.balance !== null &&
    closing !== null &&
    !closing.candidates.includes(preamble.balance)
  ) {
    return Result.fail('summary_balance_mismatch')
  }

  const closingCents =
    kind === 'account'
      ? (preamble.balance ?? closing?.candidates[0] ?? null)
      : null
  const closingAsOf = preamble.period?.end ?? closing?.asOf ?? null
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
