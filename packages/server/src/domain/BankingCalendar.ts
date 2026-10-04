import { addDays, weekday } from './LocalDate.ts'

// The Brazilian national banking calendar: days on which banks do not open
// nationwide, so a deadline falling on them moves to the next business day.
// Regional and municipal holidays are not included.

const pad = (n: number) => String(n).padStart(2, '0')

/** Easter Sunday of `year` (anonymous Gregorian algorithm). */
export const easterSunday = (year: number) => {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return `${year}-${pad(month)}-${pad(day)}`
}

/** Fixed national holidays as `MM-DD`, with the first year each applies. */
const fixed: ReadonlyArray<readonly [string, number]> = [
  ['01-01', 0], // Confraternização Universal
  ['04-21', 0], // Tiradentes
  ['05-01', 0], // Dia do Trabalho
  ['09-07', 0], // Independência
  ['10-12', 0], // Nossa Senhora Aparecida (Lei 6.802/1980)
  ['11-02', 0], // Finados
  ['11-15', 0], // Proclamação da República
  ['11-20', 2024], // Consciência Negra (Lei 14.759/2023)
  ['12-25', 0], // Natal
]

/** Days from Easter Sunday of the movable bank holidays. */
const movable = [
  -48, // Carnival Monday
  -47, // Carnival Tuesday
  -2, // Good Friday
  60, // Corpus Christi
]

/** National bank holidays of `year`, sorted. */
export const bankHolidays = (year: number): ReadonlyArray<string> => {
  const easter = easterSunday(year)
  return [
    ...fixed
      .filter(([, since]) => year >= since)
      .map(([monthDay]) => `${year}-${monthDay}`),
    ...movable.map((offset) => addDays(easter, offset)),
  ].sort()
}

/** Whether banks open nationwide on `date`: a weekday that is not a national bank holiday. */
export const isBusinessDay = (date: string) => {
  const day = weekday(date)
  return (
    day !== 0 &&
    day !== 6 &&
    !bankHolidays(Number(date.slice(0, 4))).includes(date)
  )
}

/** The date itself on a business day, else the first business day after it. */
export const nextBusinessDay = (date: string) => {
  let current = date
  while (!isBusinessDay(current)) current = addDays(current, 1)
  return current
}
