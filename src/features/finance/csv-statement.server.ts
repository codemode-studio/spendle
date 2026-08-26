import { parse } from 'csv-parse/sync'

import { parseCurrency, toMinorUnits } from '#/domain/currency'
import { inferCoverageFromFilename } from '#/domain/import-coverage'

export interface CsvParsedTransaction {
  externalId?: string
  postedAt: string
  description: string
  amountCents: number
  currency: string
  raw: Record<string, string>
}

export interface CsvStatementResult {
  transactions: CsvParsedTransaction[]
  sourceTransactionCount: number
  invalidTransactionCount: number
  periodStart: string | null
  periodEnd: string | null
  activityStart: string | null
  activityEnd: string | null
  periodSource: 'metadata' | 'filename' | 'activity'
  coverageConfidence: 'high' | 'medium' | 'low'
  closingBalanceCents: number | null
  balanceAsOf: string | null
  detectedLastFour: string | null
  detectedCurrency: string | null
}

function normalizedKey(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
}

function normalizeRecord(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      normalizedKey(key),
      String(value ?? '').trim(),
    ]),
  )
}

function firstValue(record: Record<string, string>, keys: string[]) {
  return keys.map((key) => record[key]).find((value) => value) ?? ''
}

function parseCsvMoney(value: string, currency: string) {
  const trimmed = value.trim()
  const negative = /^-/.test(trimmed) || /^\(.*\)$/.test(trimmed)
  try {
    const minorUnits = toMinorUnits(trimmed, currency)
    return {
      cents: negative ? -Math.abs(minorUnits) : minorUnits,
      explicit: /^[-+]/.test(trimmed) || /^\(.*\)$/.test(trimmed),
    }
  } catch {
    return null
  }
}

function parseDate(value: string) {
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return validDate(iso[1], iso[2], iso[3])
  const brazilian = value.match(/^(\d{2})[/.-](\d{2})[/.-](\d{2,4})/)
  if (!brazilian) return null
  const year = brazilian[3].length === 2 ? `20${brazilian[3]}` : brazilian[3]
  return validDate(year, brazilian[2], brazilian[1])
}

function validDate(year: string, month: string, day: string) {
  const candidate = `${year}-${month}-${day}`
  const parsed = new Date(`${candidate}T12:00:00Z`)
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== candidate
    ? null
    : candidate
}

function parseAmount(
  record: Record<string, string>,
  targetType: 'account' | 'card',
  currency: string,
) {
  const debit = firstValue(record, [
    'debito',
    'valor_debito',
    'debit',
    'withdrawal',
  ])
  const credit = firstValue(record, [
    'credito',
    'valor_credito',
    'credit',
    'deposit',
  ])
  if (debit) {
    const parsed = parseCsvMoney(debit, currency)
    return parsed ? -Math.abs(parsed.cents) : null
  }
  if (credit) {
    const parsed = parseCsvMoney(credit, currency)
    return parsed ? Math.abs(parsed.cents) : null
  }

  const raw = firstValue(record, [
    'valor',
    'valor_bruto',
    'amount',
    'transaction_amount',
  ])
  if (!raw) return null
  const parsed = parseCsvMoney(raw, currency)
  if (!parsed) return null
  if (parsed.explicit) return parsed.cents
  const direction = firstValue(record, [
    'tipo',
    'natureza',
    'direction',
    'credito_debito',
  ]).toLocaleLowerCase('pt-BR')
  if (/deb|saida|compra|pagamento/.test(direction)) {
    return -Math.abs(parsed.cents)
  }
  if (/cred|entrada|recebimento|estorno/.test(direction)) {
    return Math.abs(parsed.cents)
  }
  return targetType === 'card' ? -Math.abs(parsed.cents) : parsed.cents
}

const dateHeaders = new Set([
  'data',
  'data_lancamento',
  'data_da_transacao',
  'date',
  'posted_at',
])
const descriptionHeaders = new Set([
  'descricao',
  'descricao_da_transacao',
  'historico',
  'estabelecimento',
  'title',
  'description',
  'memo',
])
const amountHeaders = new Set([
  'debito',
  'valor_debito',
  'debit',
  'withdrawal',
  'credito',
  'valor_credito',
  'credit',
  'deposit',
  'valor',
  'valor_bruto',
  'amount',
  'transaction_amount',
])

function containsHeader(headers: string[], candidates: Set<string>) {
  return headers.some((header) => candidates.has(header))
}

function findCsvTable(source: string) {
  const lines = source.split(/\r?\n/)
  const delimiters = [',', ';', '\t']

  for (const [lineIndex, line] of lines.entries()) {
    for (const delimiter of delimiters) {
      const headers = line.split(delimiter).map(normalizedKey)
      if (
        containsHeader(headers, dateHeaders) &&
        containsHeader(headers, descriptionHeaders) &&
        containsHeader(headers, amountHeaders)
      ) {
        return {
          delimiter,
          preamble: lines.slice(0, lineIndex).join('\n'),
          source: lines.slice(lineIndex).join('\n'),
        }
      }
    }
  }

  const firstContentLine = lines.findIndex((line) => line.trim())
  const header = lines[firstContentLine] ?? ''
  const delimiter = delimiters.reduce((best, candidate) =>
    header.split(candidate).length > header.split(best).length
      ? candidate
      : best,
  )
  return {
    delimiter,
    preamble: '',
    source: lines.slice(Math.max(0, firstContentLine)).join('\n'),
  }
}

function parseCsvMetadata(source: string, currency: string) {
  let detectedLastFour: string | null = null
  let periodStart: string | null = null
  let periodEnd: string | null = null
  let closingBalanceCents: number | null = null

  for (const line of source.split(/\r?\n/)) {
    const [rawKey, ...rawValues] = line.split(/[;\t]/)
    const key = normalizedKey(rawKey)
    const value = rawValues.join(' ').trim()
    if (!value) continue

    if (key === 'conta') {
      const digits = value.replace(/\D/g, '')
      detectedLastFour = digits.length >= 4 ? digits.slice(-4) : null
      continue
    }

    if (key === 'periodo') {
      const dates = value.match(
        /\d{4}-\d{2}-\d{2}|\d{2}[/.-]\d{2}[/.-]\d{2,4}/g,
      )
      periodStart = dates?.[0] ? parseDate(dates[0]) : null
      periodEnd = dates?.[1] ? parseDate(dates[1]) : null
      continue
    }

    if (/^saldo(?:_|$)/.test(key)) {
      closingBalanceCents = parseCsvMoney(value, currency)?.cents ?? null
    }
  }

  return {
    detectedLastFour,
    periodStart,
    periodEnd,
    closingBalanceCents,
  }
}

export function parseCsvStatement(
  buffer: Buffer,
  targetType: 'account' | 'card',
  filename?: string,
  defaultCurrency = 'BRL',
): CsvStatementResult {
  const source = buffer.toString('utf8').replace(/^\uFEFF/, '')
  const table = findCsvTable(source)
  const targetCurrency = parseCurrency(defaultCurrency)
  const metadata = parseCsvMetadata(table.preamble, targetCurrency)
  const records: Array<Record<string, unknown>> = parse(table.source, {
    bom: true,
    columns: true,
    delimiter: table.delimiter,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  })
  const transactions: CsvParsedTransaction[] = []
  const balancePoints: Array<{
    postedAt: string
    amountCents: number
    balanceCents: number
  }> = []

  for (const rawRecord of records) {
    const record = normalizeRecord(rawRecord)
    const postedAt = parseDate(
      firstValue(record, [
        'data',
        'data_lancamento',
        'data_da_transacao',
        'date',
        'posted_at',
      ]),
    )
    const description = firstValue(record, [
      'descricao',
      'descricao_da_transacao',
      'historico',
      'estabelecimento',
      'title',
      'description',
      'memo',
    ])
    const rawCurrency = firstValue(record, [
      'moeda',
      'currency',
      'currency_code',
    ]).toUpperCase()
    let currency: string
    try {
      currency = parseCurrency(rawCurrency || targetCurrency)
    } catch {
      continue
    }
    const amountCents = parseAmount(record, targetType, currency)
    if (!postedAt || !description || amountCents === null) continue
    const externalId = firstValue(record, [
      'id',
      'identificador',
      'transaction_id',
      'fitid',
      'codigo',
    ])
    transactions.push({
      externalId: externalId || undefined,
      postedAt,
      description,
      amountCents,
      currency,
      raw: record,
    })
    const rawBalance = firstValue(record, [
      'saldo',
      'balance',
      'running_balance',
    ])
    const balance = rawBalance ? parseCsvMoney(rawBalance, currency) : null
    if (balance) {
      balancePoints.push({
        postedAt,
        amountCents,
        balanceCents: balance.cents,
      })
    }
  }

  const dates = transactions.map((transaction) => transaction.postedAt).sort()
  const latestDate = dates.at(-1) ?? null
  const filenamePeriod = inferCoverageFromFilename(filename)
  const periodStart =
    metadata.periodStart ?? filenamePeriod?.start ?? dates.at(0) ?? null
  const periodEnd = metadata.periodEnd ?? filenamePeriod?.end ?? latestDate
  const declaredPeriodSource =
    metadata.periodStart && metadata.periodEnd
      ? ('metadata' as const)
      : filenamePeriod
        ? ('filename' as const)
        : ('activity' as const)
  const activityOutsideDeclaredPeriod = Boolean(
    declaredPeriodSource !== 'activity' &&
    dates.length &&
    periodStart &&
    periodEnd &&
    (dates[0] < periodStart || latestDate! > periodEnd),
  )
  const periodSource = activityOutsideDeclaredPeriod
    ? ('activity' as const)
    : declaredPeriodSource
  let latestBalancePoint:
    { postedAt: string; amountCents: number; balanceCents: number } | undefined
  if (balancePoints.length) {
    const hasCompleteBalanceSequence =
      balancePoints.length === transactions.length
    if (!hasCompleteBalanceSequence) {
      latestBalancePoint = [...balancePoints]
        .reverse()
        .find((point) => point.postedAt === latestDate)
    } else {
      const ascendingIsValid = balancePoints.slice(1).every((point, index) => {
        const previousPoint = balancePoints[index]
        return (
          previousPoint.balanceCents + point.amountCents === point.balanceCents
        )
      })
      const descendingIsValid = balancePoints
        .slice(0, -1)
        .every((point, index) => {
          const olderPoint = balancePoints[index + 1]
          return (
            olderPoint.balanceCents + point.amountCents === point.balanceCents
          )
        })
      if (balancePoints.length > 1 && !ascendingIsValid && !descendingIsValid) {
        throw new Error(
          'A coluna de saldo não fecha com as movimentações informadas no CSV.',
        )
      }
      latestBalancePoint =
        ascendingIsValid && !descendingIsValid
          ? balancePoints.at(-1)
          : descendingIsValid && !ascendingIsValid
            ? balancePoints[0]
            : balancePoints[0].postedAt <= balancePoints.at(-1)!.postedAt
              ? balancePoints.at(-1)
              : balancePoints[0]
    }
  }
  if (
    metadata.closingBalanceCents !== null &&
    latestBalancePoint &&
    metadata.closingBalanceCents !== latestBalancePoint.balanceCents
  ) {
    throw new Error(
      'O saldo do resumo não corresponde ao saldo mais recente da tabela.',
    )
  }

  const closingBalanceCents =
    targetType === 'account'
      ? (metadata.closingBalanceCents ??
        latestBalancePoint?.balanceCents ??
        null)
      : null
  return {
    transactions,
    sourceTransactionCount: records.length,
    invalidTransactionCount: Math.max(0, records.length - transactions.length),
    periodStart,
    periodEnd,
    activityStart: dates.at(0) ?? null,
    activityEnd: latestDate,
    periodSource,
    coverageConfidence: periodSource === 'activity' ? 'low' : 'high',
    closingBalanceCents,
    balanceAsOf:
      closingBalanceCents === null
        ? null
        : (metadata.periodEnd ?? latestBalancePoint?.postedAt ?? null),
    detectedLastFour:
      targetType === 'account' ? metadata.detectedLastFour : null,
    detectedCurrency:
      new Set(transactions.map((transaction) => transaction.currency)).size ===
      1
        ? (transactions[0]?.currency ?? null)
        : null,
  }
}
