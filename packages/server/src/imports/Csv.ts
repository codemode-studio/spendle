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
} as const

const pick = (row: Record<string, string>, names: ReadonlyArray<string>) =>
  names
    .map((name) => row[name])
    .find((value) => value !== undefined && value !== '') ?? ''

/** Splits CSV text into rows of fields, honouring quotes and doubled quotes. */
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

const amountOf = (row: Record<string, string>, kind: 'account' | 'card') => {
  const debit = pick(row, columns.debit)
  if (debit) {
    const cents = parseMoney(debit)
    return cents === null ? null : -Math.abs(cents)
  }
  const credit = pick(row, columns.credit)
  if (credit) {
    const cents = parseMoney(credit)
    return cents === null ? null : Math.abs(cents)
  }
  const raw = pick(row, columns.amount)
  const cents = parseMoney(raw)
  if (cents === null) return null
  const direction = key(pick(row, columns.direction))
  if (/deb|saida|compra|pagamento|^d$/.test(direction)) return -Math.abs(cents)
  if (/cred|entrada|recebimento|estorno|^c$/.test(direction))
    return Math.abs(cents)
  // Card exports sign amounts from the statement's view: a purchase is
  // positive and a payment or refund negative, the opposite of the ledger.
  return kind === 'card' ? -cents : cents
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
  const [headerRow = [], ...dataRows] = splitCsv(table.body, table.delimiter)
  const headers = headerRow.map(key)
  const preamble = readPreamble(table.preamble, table.delimiter)

  let rejectedRows = 0
  const lines: Array<
    Omit<StatementLine, 'externalId'> & { externalId?: string }
  > = []
  const balances: Array<{
    bookedOn: string
    amountCents: number
    balanceCents: number
  }> = []
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
    const balanceCents = parseMoney(pick(row, columns.balance))
    if (balanceCents !== null)
      balances.push({ bookedOn, amountCents, balanceCents })
  }

  let latestBalance: (typeof balances)[number] | undefined
  if (balances.length > 0 && balances.length === lines.length) {
    const chains = (ordered: typeof balances) =>
      ordered
        .slice(1)
        .every(
          (point, index) =>
            ordered[index]!.balanceCents + point.amountCents ===
            point.balanceCents,
        )
    const ascending = chains(balances)
    const descending = chains([...balances].reverse())
    if (balances.length > 1 && !ascending && !descending)
      return Result.fail('running_balance_mismatch')
    latestBalance =
      ascending && !descending
        ? balances.at(-1)
        : descending && !ascending
          ? balances[0]
          : balances.at(-1)
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
    currency: null,
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
