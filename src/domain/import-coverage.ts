export type CoverageSource = 'metadata' | 'filename' | 'activity'
export type CoverageConfidence = 'high' | 'medium' | 'low'
export type DeclaredCoverageSource = CoverageSource | 'user' | 'unknown'
export type CoverageImportStatus =
  'review' | 'committed' | 'evidence' | 'rejected' | 'failed'

export interface CoverageInterval {
  start: string
  end: string
}

export interface CoveragePeriodRecord {
  periodStart: string | null
  periodEnd: string | null
  periodSource: DeclaredCoverageSource
  status?: CoverageImportStatus
}

export function resolveCompletedBatchStatus(statuses: CoverageImportStatus[]) {
  if (
    statuses.some((status) => status === 'committed' || status === 'evidence')
  ) {
    return 'committed' as const
  }
  if (statuses.some((status) => status === 'rejected' || status === 'failed')) {
    return 'failed' as const
  }
  return 'committed' as const
}

export function isReliableCoveragePeriod(
  period: CoveragePeriodRecord,
): period is CoveragePeriodRecord & {
  periodStart: string
  periodEnd: string
  periodSource: 'metadata' | 'filename' | 'user'
} {
  return Boolean(
    period.periodStart &&
    period.periodEnd &&
    (period.periodSource === 'metadata' ||
      period.periodSource === 'filename' ||
      period.periodSource === 'user'),
  )
}

export function summarizeCoveragePeriods(
  periods: CoveragePeriodRecord[],
  include: (period: CoveragePeriodRecord) => boolean = () => true,
) {
  const intervals = periods
    .filter(include)
    .filter(isReliableCoveragePeriod)
    .map((period) => ({
      start: period.periodStart,
      end: period.periodEnd,
    }))
    .sort((left, right) => left.start.localeCompare(right.start))
  return {
    intervals,
    coverageStart: intervals.at(0)?.start ?? null,
    coverageEnd: intervals.reduce<string | null>(
      (latest, interval) =>
        !latest || interval.end > latest ? interval.end : latest,
      null,
    ),
    gaps: findCoverageGaps(intervals),
  }
}

export function buildCoverageView(
  intervals: Array<CoverageInterval & { importStatus: CoverageImportStatus }>,
  referenceDate: string,
) {
  const effective = effectiveCoverageIntervals(intervals)
  const merged = mergeCoverageIntervals(effective)
  const latestCoverageEnd = merged.at(-1)?.end ?? null
  return {
    intervals: merged,
    gaps: findCoverageGaps(effective),
    latestCoverageEnd,
    freshness: getFreshness(latestCoverageEnd, referenceDate),
  }
}

const portugueseMonths = [
  'JAN',
  'FEV',
  'MAR',
  'ABR',
  'MAI',
  'JUN',
  'JUL',
  'AGO',
  'SET',
  'OUT',
  'NOV',
  'DEZ',
] as const

const learnedDateFormats = {
  iso: {
    regex: '(\\d{4}-\\d{2}-\\d{2})',
    render: (date: string) => date,
    parse: (value: string) => value,
  },
  dmy_dash: {
    regex: '(\\d{2}-\\d{2}-\\d{4})',
    render: (date: string) =>
      `${date.slice(8)}-${date.slice(5, 7)}-${date.slice(0, 4)}`,
    parse: (value: string) =>
      `${value.slice(6)}-${value.slice(3, 5)}-${value.slice(0, 2)}`,
  },
  dmy_under: {
    regex: '(\\d{2}_\\d{2}_\\d{4})',
    render: (date: string) =>
      `${date.slice(8)}_${date.slice(5, 7)}_${date.slice(0, 4)}`,
    parse: (value: string) =>
      `${value.slice(6)}-${value.slice(3, 5)}-${value.slice(0, 2)}`,
  },
  named: {
    regex: `(\\d{2}(?:${portugueseMonths.join('|')})\\d{4})`,
    render: (date: string) =>
      `${date.slice(8)}${portugueseMonths[Number(date.slice(5, 7)) - 1]}${date.slice(0, 4)}`,
    parse: (value: string) => {
      const month = portugueseMonths.indexOf(
        value.slice(2, 5) as (typeof portugueseMonths)[number],
      )
      return `${value.slice(5)}-${String(month + 1).padStart(2, '0')}-${value.slice(0, 2)}`
    },
  },
} as const

type LearnedDateFormat = keyof typeof learnedDateFormats

function isLearnedDateFormat(value: string): value is LearnedDateFormat {
  return Object.hasOwn(learnedDateFormats, value)
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function createFilenameCoverageTemplate(
  filename: string,
  start: string,
  end: string,
) {
  const source = filename.toLocaleUpperCase('pt-BR')
  for (const [startFormat, startDefinition] of Object.entries(
    learnedDateFormats,
  ) as Array<
    [LearnedDateFormat, (typeof learnedDateFormats)[LearnedDateFormat]]
  >) {
    const renderedStart = startDefinition.render(start)
    const startIndex = source.indexOf(renderedStart)
    if (startIndex < 0) continue
    for (const [endFormat, endDefinition] of Object.entries(
      learnedDateFormats,
    ) as Array<
      [LearnedDateFormat, (typeof learnedDateFormats)[LearnedDateFormat]]
    >) {
      const renderedEnd = endDefinition.render(end)
      const endIndex = source.indexOf(
        renderedEnd,
        startIndex + renderedStart.length,
      )
      if (endIndex < 0) continue
      return `${source.slice(0, startIndex)}{start:${startFormat}}${source.slice(startIndex + renderedStart.length, endIndex)}{end:${endFormat}}${source.slice(endIndex + renderedEnd.length)}`
    }
  }
  return null
}

export function inferCoverageFromLearnedTemplates(
  filename: string,
  templates: string[],
) {
  const source = filename.toLocaleUpperCase('pt-BR')
  for (const template of templates) {
    const tokens = [...template.matchAll(/\{(start|end):([a-z_]+)\}/g)]
    if (tokens.length !== 2) continue
    const formats = tokens.map((token) => token[2])
    if (!formats.every(isLearnedDateFormat)) continue
    let cursor = 0
    let expression = '^'
    for (const [index, token] of tokens.entries()) {
      expression += escapeRegex(template.slice(cursor, token.index))
      const definition = learnedDateFormats[formats[index]]
      expression += definition.regex
      cursor = token.index + token[0].length
    }
    expression += `${escapeRegex(template.slice(cursor))}$`
    const match = source.match(new RegExp(expression))
    if (!match) continue
    const values = Object.fromEntries(
      tokens.map((token, index) => {
        const definition = learnedDateFormats[formats[index]]
        return [token[1], definition.parse(match[index + 1])]
      }),
    ) as { start: string; end: string }
    if (
      isoDate(...(values.start.split('-') as [string, string, string])) &&
      isoDate(...(values.end.split('-') as [string, string, string])) &&
      values.start <= values.end
    ) {
      return values
    }
  }
  return null
}

export function effectiveCoverageIntervals(
  intervals: Array<
    CoverageInterval & {
      importStatus: 'review' | 'committed' | 'evidence' | 'rejected' | 'failed'
    }
  >,
) {
  return intervals
    .filter(
      (interval) =>
        interval.importStatus === 'committed' ||
        interval.importStatus === 'evidence',
    )
    .map(({ start, end }) => ({ start, end }))
}

function isoDate(year: string, month: string, day: string) {
  const candidate = `${year}-${month}-${day}`
  const date = new Date(`${candidate}T12:00:00Z`)
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === candidate
    ? candidate
    : null
}

function normalizeYear(value: string) {
  return value.length === 2 ? `20${value}` : value
}

export function inferCoverageFromFilename(filename?: string | null) {
  if (!filename) return null
  const withoutExtension = filename.replace(/\.[^.]+$/, '')
  const numericMatch = withoutExtension.match(
    /(?:^|\D)(\d{2})[-_.](\d{2})[-_.](\d{2,4})\D+(?:a|ate|to|_)[-_ .]*(\d{2})[-_.](\d{2})[-_.](\d{2,4})(?:\D|$)/i,
  )
  const monthByName: Record<string, string> = {
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
  const namedMatch = withoutExtension
    .toLocaleUpperCase('pt-BR')
    .match(
      /(?:^|\D)(\d{2})(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)(\d{4})\D+(\d{2})(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)(\d{4})(?:\D|$)/,
    )
  const start = numericMatch
    ? isoDate(normalizeYear(numericMatch[3]), numericMatch[2], numericMatch[1])
    : namedMatch
      ? isoDate(namedMatch[3], monthByName[namedMatch[2]], namedMatch[1])
      : null
  const end = numericMatch
    ? isoDate(normalizeYear(numericMatch[6]), numericMatch[5], numericMatch[4])
    : namedMatch
      ? isoDate(namedMatch[6], monthByName[namedMatch[5]], namedMatch[4])
      : null
  if (!start || !end || start > end) return null
  return { start, end }
}

function nextDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

function previousDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

export function mergeCoverageIntervals(intervals: CoverageInterval[]) {
  const sorted = [...intervals]
    .filter((interval) => interval.start <= interval.end)
    .sort((left, right) => left.start.localeCompare(right.start))
  const merged: CoverageInterval[] = []
  for (const interval of sorted) {
    const current = merged.at(-1)
    if (!current || interval.start > nextDate(current.end)) {
      merged.push({ ...interval })
      continue
    }
    if (interval.end > current.end) current.end = interval.end
  }
  return merged
}

export function findCoverageGaps(intervals: CoverageInterval[]) {
  const merged = mergeCoverageIntervals(intervals)
  return merged.slice(1).map((current, index) => ({
    after: merged[index].end,
    before: current.start,
    start: nextDate(merged[index].end),
    end: previousDate(current.start),
  }))
}

function dayNumber(value: string) {
  return Math.floor(Date.parse(`${value}T12:00:00Z`) / 86_400_000)
}

export function countCoveredDaysAfter(
  intervals: CoverageInterval[],
  checkpointAsOf: string | null,
) {
  return mergeCoverageIntervals(intervals).reduce((total, interval) => {
    const start = checkpointAsOf
      ? interval.start > checkpointAsOf
        ? interval.start
        : nextDate(checkpointAsOf)
      : interval.start
    if (start > interval.end) return total
    return total + dayNumber(interval.end) - dayNumber(start) + 1
  }, 0)
}

export function getFreshness(
  latestCoverageEnd: string | null,
  referenceDate: string,
) {
  if (!latestCoverageEnd) {
    return { status: 'never' as const, ageDays: null }
  }
  const ageDays = Math.max(
    0,
    Math.floor(
      (Date.parse(`${referenceDate}T12:00:00Z`) -
        Date.parse(`${latestCoverageEnd}T12:00:00Z`)) /
        86_400_000,
    ),
  )
  return {
    status:
      ageDays <= 15
        ? ('current' as const)
        : ageDays <= 30
          ? ('recommended' as const)
          : ('outdated' as const),
    ageDays,
  }
}
