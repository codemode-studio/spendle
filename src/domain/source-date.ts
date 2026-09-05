const months = [
  'jan',
  'fev',
  'mar',
  'abr',
  'mai',
  'jun',
  'jul',
  'ago',
  'set',
  'out',
  'nov',
  'dez',
]

/** Data escrita na linha original, sem deslocamento pela parcela ou pelo ciclo. */
export function sourceDate(rawJson: string | null): string | null {
  if (!rawJson) return null
  let raw: unknown
  try {
    raw = JSON.parse(rawJson)
  } catch {
    return null
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('line' in raw) ||
    typeof raw.line !== 'string'
  )
    return null
  const match = raw.line.match(/^(\d{2}) de ([a-z]{3})\. (\d{4})\b/i)
  if (!match) return null
  const month = months.indexOf(match[2].toLowerCase()) + 1
  if (!month) return null
  const date = `${match[3]}-${String(month).padStart(2, '0')}-${match[1]}`
  const parsed = new Date(`${date}T12:00:00Z`)
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
    ? date
    : null
}
