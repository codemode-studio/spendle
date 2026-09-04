const DAY_MS = 86_400_000

export interface Period {
  /** Inclusive ISO date. */
  start: string
  /** Inclusive ISO date. */
  end: string
}

export interface PeriodMonth {
  /** `YYYY-MM` */
  key: string
  /** `abr` */
  label: string
  /** `abril de 2026` */
  fullLabel: string
  /** Only part of the month is inside the period. */
  partial: boolean
}

export interface DaysBetweenOptions {
  /** Count both boundary dates. Defaults to `true`. */
  inclusive?: boolean
  /** Ignore the order of the dates. Defaults to `false`. */
  absolute?: boolean
}

export interface MonthLongFormatOptions {
  includeYear?: boolean
  capitalize?: boolean
}

export type PeriodFormat = 'day-range' | 'month-range' | 'iso'

function asDate(value: string) {
  const iso = value.length === 7 ? `${value}-01` : value.slice(0, 10)
  return new Date(`${iso}T12:00:00Z`)
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export function todayIso(today: Date = new Date()) {
  return today.toISOString().slice(0, 10)
}

export function shiftDays(iso: string, days: number) {
  const date = asDate(iso)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** A `days`-day window ending `endOffset` days before `today`. */
export function trailingPeriod(
  days: number,
  endOffset = 0,
  today = todayIso(),
): Period {
  const end = shiftDays(today, -endOffset)
  return { start: shiftDays(end, -(days - 1)), end }
}

export function previousPeriod(period: Period): Period {
  const days = daysBetween(period.start, period.end)
  return {
    start: shiftDays(period.start, -days),
    end: shiftDays(period.start, -1),
  }
}

export function inPeriod(date: string, period: Period) {
  return date >= period.start && date <= period.end
}

export function daysBetween(
  start: string,
  end: string,
  options: DaysBetweenOptions = {},
) {
  const { inclusive = true, absolute = false } = options
  const raw = Math.round(
    (asDate(end).getTime() - asDate(start).getTime()) / DAY_MS,
  )
  const distance = absolute ? Math.abs(raw) : raw
  return inclusive ? distance + 1 : distance
}

export function monthKey(iso: string) {
  return iso.slice(0, 7)
}

export function formatMonthShort(value: string) {
  return new Intl.DateTimeFormat('pt-BR', {
    month: 'short',
    timeZone: 'UTC',
  })
    .format(asDate(value))
    .replaceAll('.', '')
}

export function formatMonthLong(
  value: string,
  options: MonthLongFormatOptions = {},
) {
  const { includeYear = true, capitalize: shouldCapitalize = false } = options
  const label = new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    ...(includeYear ? { year: 'numeric' as const } : {}),
    timeZone: 'UTC',
  }).format(asDate(value))
  return shouldCapitalize ? capitalize(label) : label
}

export function formatMonthName(value: string) {
  return formatMonthLong(value, { includeYear: false })
}

export function monthsInPeriod(period: Period): Array<PeriodMonth> {
  const months: Array<PeriodMonth> = []
  let cursor = `${monthKey(period.start)}-01`
  while (monthKey(cursor) <= monthKey(period.end)) {
    const date = asDate(cursor)
    const key = monthKey(cursor)
    const monthEnd = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 12),
    )
      .toISOString()
      .slice(0, 10)
    months.push({
      key,
      label: formatMonthShort(key),
      fullLabel: formatMonthLong(key),
      partial: cursor < period.start || monthEnd > period.end,
    })
    date.setUTCMonth(date.getUTCMonth() + 1)
    cursor = date.toISOString().slice(0, 10)
  }
  return months
}

/** Formats exact dates, month spans, or raw ISO spans through one API. */
export function formatPeriod(
  period: Period,
  format: PeriodFormat = 'day-range',
) {
  if (format === 'iso') {
    return period.start === period.end
      ? period.start
      : `${period.start} a ${period.end}`
  }

  if (format === 'month-range') {
    const startMonth = monthKey(period.start)
    const endMonth = monthKey(period.end)
    const startYear = startMonth.slice(0, 4)
    const endYear = endMonth.slice(0, 4)
    if (startMonth === endMonth) {
      return `${formatMonthShort(startMonth)} ${startYear}`
    }
    if (startYear === endYear) {
      return `${formatMonthShort(startMonth)} a ${formatMonthShort(endMonth)} ${endYear}`
    }
    return `${formatMonthShort(startMonth)} ${startYear} a ${formatMonthShort(endMonth)} ${endYear}`
  }

  const start = asDate(period.start)
  const end = asDate(period.end)
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear()
  const startLabel = new Intl.DateTimeFormat('pt-BR', {
    day: 'numeric',
    month: 'short',
    ...(!sameYear ? { year: 'numeric' as const } : {}),
    timeZone: 'UTC',
  }).format(start)
  const endLabel = new Intl.DateTimeFormat('pt-BR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(end)
  return `${startLabel} a ${endLabel}`.replaceAll('.', '')
}

export function formatDayLabel(iso: string, today = todayIso()) {
  const difference = daysBetween(iso, today, { inclusive: false })
  if (difference === 0) return 'Hoje'
  if (difference === 1) return 'Ontem'
  const date = asDate(iso)
  const current = asDate(today)
  const label = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(date.getUTCFullYear() !== current.getUTCFullYear()
      ? { year: 'numeric' as const }
      : {}),
    timeZone: 'UTC',
  }).format(date)
  return capitalize(label)
}

export function formatLongDate(iso: string) {
  return new Intl.DateTimeFormat('pt-BR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
    .format(asDate(iso))
    .replaceAll('.', '')
}

export function formatShortDate(iso: string) {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  })
    .format(asDate(iso))
    .replaceAll('.', '')
}
