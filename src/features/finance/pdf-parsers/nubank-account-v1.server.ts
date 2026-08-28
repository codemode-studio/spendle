import { toMinorUnits } from '#/domain/currency'

import type {
  PdfParserTransaction,
  PdfPositionedLine,
  PdfStatementParser,
} from './types'

const monthByAbbreviation: Record<string, string> = {
  JAN: '01',
  FEV: '02',
  MAR: '03',
  ABR: '04',
  MAI: '05',
  JUN: '06',
  JUL: '07',
  AGO: '08',
  SET: '09',
  OUT: '10',
  NOV: '11',
  DEZ: '12',
}

const monthByName: Record<string, string> = {
  JANEIRO: '01',
  FEVEREIRO: '02',
  MARCO: '03',
  ABRIL: '04',
  MAIO: '05',
  JUNHO: '06',
  JULHO: '07',
  AGOSTO: '08',
  SETEMBRO: '09',
  OUTUBRO: '10',
  NOVEMBRO: '11',
  DEZEMBRO: '12',
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function parseMoney(value: string, currency: string) {
  try {
    return toMinorUnits(value.replace('−', '-').replace(/\s+/g, ''), currency)
  } catch {
    return null
  }
}

function extractPeriod(text: string) {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
  const dates = [
    ...normalized.matchAll(
      /\b(\d{2})\s+DE\s+(JANEIRO|FEVEREIRO|MARCO|ABRIL|MAIO|JUNHO|JULHO|AGOSTO|SETEMBRO|OUTUBRO|NOVEMBRO|DEZEMBRO)\s+DE\s+(\d{4})\b/g,
    ),
  ].map((match) => `${match[3]}-${monthByName[match[2]]}-${match[1]}`)
  return {
    periodStart: dates.at(0) ?? null,
    periodEnd: dates.at(1) ?? dates.at(0) ?? null,
  }
}

function amountFromLine(line: string, currency: string) {
  const amount = line.match(
    /(?:R\$\s*)?([-−]?(?:\d{1,3}(?:\.\d{3})*|\d+),\d{2})\s*$/,
  )?.[1]
  return amount ? parseMoney(amount, currency) : null
}

function parseTransactions(lines: PdfPositionedLine[], currency: string) {
  const orderedLines = [...lines].sort((left, right) =>
    left.bounds.page !== right.bounds.page
      ? left.bounds.page - right.bounds.page
      : right.bounds.y - left.bounds.y,
  )
  const transactions: PdfParserTransaction[] = []
  let readingMovements = false
  let postedAt: string | null = null
  let pending: PdfParserTransaction | null = null
  let group:
    | {
        postedAt: string
        direction: 'credit' | 'debit'
        expectedCents: number
        actualCents: number
        transactionCount: number
      }
    | undefined

  const flushPending = () => {
    if (!pending) return
    pending.description = normalizeText(pending.description)
    transactions.push(pending)
    if (group) {
      group.actualCents += Math.abs(pending.amountCents)
      group.transactionCount += 1
    }
    pending = null
  }

  const validateGroup = () => {
    if (!group) return
    if (group.expectedCents !== group.actualCents) {
      throw new Error(
        `O total de ${group.direction === 'credit' ? 'entradas' : 'saídas'} do Nubank em ${group.postedAt} não fecha: esperado ${group.expectedCents}, extraído ${group.actualCents}.`,
      )
    }
    if (group.transactionCount === 0 && group.expectedCents !== 0) {
      throw new Error(
        `O grupo Nubank em ${group.postedAt} tem total declarado, mas nenhuma transação foi extraída.`,
      )
    }
    group = undefined
  }

  const startGroup = (
    line: PdfPositionedLine,
    nextDirection: 'credit' | 'debit',
  ) => {
    const totalMatch = line.text.match(
      /([+−-]?\s*(?:\d{1,3}(?:\.\d{3})*|\d+),\d{2})\s*$/,
    )
    const expected = totalMatch ? parseMoney(totalMatch[1], currency) : null
    if (!postedAt || expected === null) {
      throw new Error(
        `Não foi possível interpretar o total do grupo Nubank: ${line.text}`,
      )
    }
    group = {
      postedAt,
      direction: nextDirection,
      expectedCents: Math.abs(expected),
      actualCents: 0,
      transactionCount: 0,
    }
  }

  for (const line of orderedLines) {
    if (/^movimenta[cç][oõ]es$/i.test(line.text)) {
      readingMovements = true
      continue
    }
    if (!readingMovements) continue
    if (
      /o saldo l[ií]quido corresponde|asseguramos a autenticidade|nu financeira s\.a\./i.test(
        line.text,
      )
    ) {
      flushPending()
      validateGroup()
      break
    }
    if (
      /extrato gerado|nubank\.com\.br|tem alguma d[uú]vida|caso a solu[cç][aã]o|^cpf\b|ag[eê]ncia.*conta|^\d{2} de [a-zç]+ de \d{4}\s+a\s+\d{2} de/i.test(
        line.text,
      )
    ) {
      continue
    }

    const dateMatch = line.text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .match(
        /^(\d{2})\s+(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\s+(\d{4})\b/,
      )
    if (dateMatch) {
      flushPending()
      validateGroup()
      postedAt = `${dateMatch[3]}-${monthByAbbreviation[dateMatch[2]]}-${dateMatch[1]}`
      if (/total de entradas/i.test(line.text)) {
        startGroup(line, 'credit')
      } else if (/total de sa[ií]das/i.test(line.text)) {
        startGroup(line, 'debit')
      } else {
        group = undefined
      }
      continue
    }
    if (/^total de entradas\b/i.test(line.text)) {
      flushPending()
      validateGroup()
      startGroup(line, 'credit')
      continue
    }
    if (/^total de sa[ií]das\b/i.test(line.text)) {
      flushPending()
      validateGroup()
      startGroup(line, 'debit')
      continue
    }

    const amountMatch = line.text.match(
      /([+-]?\s*(?:\d{1,3}(?:\.\d{3})*|\d+),\d{2})\s*$/,
    )
    if (postedAt && group && amountMatch?.index !== undefined) {
      const parsed = parseMoney(amountMatch[1], currency)
      const description = line.text
        .slice(0, amountMatch.index)
        .replace(/[|:;–—-]+$/g, '')
        .trim()
      if (parsed !== null && description) {
        flushPending()
        pending = {
          postedAt,
          description,
          amountCents:
            group.direction === 'debit' ? -Math.abs(parsed) : Math.abs(parsed),
          currency,
          raw: { line: line.text, bounds: line.bounds },
        }
        continue
      }
    }

    if (
      pending &&
      line.bounds.x >= 200 &&
      !/saldo|valores em|total de|movimenta[cç][oõ]es/i.test(line.text)
    ) {
      pending.description = `${pending.description} ${line.text}`
    }
  }
  flushPending()
  validateGroup()
  return {
    transactions,
    sourceTransactionCount: transactions.length,
  }
}

export const nubankAccountV1Parser: PdfStatementParser = {
  id: 'nubank/account-statement/v1',
  version: '1',
  institution: 'Nubank',
  kind: 'bank_statement',
  matches(input) {
    return (
      /(?:nu financeira|nu pagamentos)\s+s\.?\s*a\.?/i.test(input.text) &&
      /nubank\.com\.br/i.test(input.text) &&
      /saldo final do per[ií]odo/i.test(input.text) &&
      /total de entradas/i.test(input.text) &&
      /movimenta[cç][oõ]es/i.test(input.text)
    )
  },
  parse(input) {
    const period = extractPeriod(input.text)
    const parsed = parseTransactions(input.lines, input.currency)
    const openingLine = input.lines.find((line) =>
      /saldo inicial/i.test(line.text),
    )
    const closingMatch = input.text.match(
      /saldo final do per[ií]odo\s*R\$\s*([-−]?(?:\d{1,3}(?:\.\d{3})*|\d+),\d{2})/i,
    )
    return {
      transactions: parsed.transactions,
      sourceTransactionCount: parsed.sourceTransactionCount,
      controls: {
        openingBalanceCents: openingLine
          ? amountFromLine(openingLine.text, input.currency)
          : null,
        openingBalanceAt: period.periodStart,
        closingBalanceCents: closingMatch
          ? parseMoney(closingMatch[1], input.currency)
          : null,
        closingBalanceType: 'posted',
        balanceAsOf: period.periodEnd,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        dueDate: null,
      },
    }
  },
}

export function parseNubankAccountTransactions(input: {
  lines: PdfPositionedLine[]
  currency: string
}) {
  return parseTransactions(input.lines, input.currency).transactions
}
