import { daysBetween } from '../domain/LocalDate.ts'
import { foldDescription } from '../imports/Statement.ts'

export interface InstallmentLine {
  readonly entryId: string
  readonly bookedOn: string
  readonly amountCents: number
  readonly description: string
  /** Still pending on the open bill: it will be billed, but is not yet posted. */
  readonly pending?: boolean
  /**
   * From the provider (Pluggy's card metadata), when it says so. Any field
   * may be missing; without a number and count the description numbers the
   * instalment.
   */
  readonly installment: {
    readonly number: number | null
    readonly total: number | null
    /** When the purchase was made; the same for each of its instalments. */
    readonly purchaseDate: string | null
    /**
     * Every purchase total sources reported for the instalment, in
     * centavos, positive: the sum of its instalments. Several mean the
     * sources disagree, so the total is unknown.
     */
    readonly totalAmountsCents: ReadonlyArray<number>
  } | null
}

export interface InstallmentPlan {
  /**
   * Stable for the purchase: folded description, instalment count and first
   * instalment seen (its number, date and entry, so two purchases on one
   * day stay apart).
   */
  readonly key: string
  readonly description: string
  readonly amountCents: number
  readonly total: number
  /**
   * Instalment numbers charged on the open or earlier bills, pending or
   * posted, ascending.
   */
  readonly seen: ReadonlyArray<number>
  /** Of `seen`, those still pending on the open bill. */
  readonly pending: ReadonlyArray<number>
  /**
   * Instalment numbers the provider already reports, dated on later bills
   * than the open one; they still remain, ascending.
   */
  readonly scheduled: ReadonlyArray<number>
  readonly entryIds: ReadonlyArray<string>
  /** Instalments not yet charged on the open or earlier bills. */
  readonly remaining: number
  /**
   * What the remaining instalments will add to later bills than the open
   * one: scheduled ones at their amounts, the others estimated; negative.
   */
  readonly remainingCents: number
  /** The date of the latest instalment charged, or else the first scheduled. */
  readonly lastBookedOn: string
}

// "PARC 02/10", "Parcela 2 de 10", or a trailing "02/10".
const pattern = /\b(?:parc(?:ela)?\.?\s*)?(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})\s*$/

const fromDescription = (description: string) => {
  const match = foldDescription(description).match(pattern)
  if (!match) return null
  const number = Number(match[1])
  const total = Number(match[2])
  return number >= 1 && total >= 2 && total <= 48 && number <= total
    ? { number, total, purchaseDate: null, totalAmountsCents: [] }
    : null
}

const baseOf = (description: string) =>
  foldDescription(description)
    .replace(pattern, '')
    .replace(/\s+parc(ela)?\.?$/, '')
    .trim()

// Statements are about a month apart; bank dates move a few days.
const minDaysPerInstallment = 20
const maxDaysPerInstallment = 40

interface Item {
  readonly line: InstallmentLine
  readonly number: number
  readonly total: number
  readonly purchaseDate: string | null
  readonly totalAmountsCents: ReadonlyArray<number>
  readonly trusted: boolean
}

/**
 * Whether `next` can be a later instalment of the purchase `chain` follows:
 * a higher number, an amount within the rounding a split can leave (one
 * centavo per instalment), and the same purchase date when both are known
 * and the provider numbers both, else about a month between statements per
 * instalment (one cycle more after a first instalment the provider may date
 * on the purchase, when the provider numbers `next` too or `established`
 * says it begins a monthly chain of its own). Different purchase dates are
 * always different purchases.
 */
const continues = (
  chain: ReadonlyArray<Item>,
  next: Item,
  established = false,
) => {
  const last = chain.at(-1)!
  if (chain.some((item) => item.number === next.number)) return false
  if (next.number < last.number) return false
  if (Math.abs(next.line.amountCents - last.line.amountCents) > next.total)
    return false
  // A shared purchase date proves one purchase, whatever the dates of its
  // instalments; different ones prove two. Unknown is neither.
  const purchase = chain.find((item) => item.purchaseDate !== null)
  if (purchase && next.purchaseDate !== null) {
    if (purchase.purchaseDate !== next.purchaseDate) return false
    // A date alone does not prove numbers read from a description.
    if (purchase.trusted && next.trusted) return true
  }
  const steps = next.number - last.number
  const days = daysBetween(last.line.bookedOn, next.line.bookedOn)
  // The provider may date the first instalment on the purchase and later
  // ones on their bills, so from a trusted first instalment the gap may be
  // up to one more cycle.
  const extra =
    last.number === 1 && last.trusted && (next.trusted || established)
      ? maxDaysPerInstallment
      : 0
  return (
    days >= steps * minDaysPerInstallment &&
    days <= steps * maxDaysPerInstallment + extra
  )
}

/** Whether every instalment of `later` continues `chain`, in order. */
const joins = (chain: ReadonlyArray<Item>, later: ReadonlyArray<Item>) => {
  const joined = [...chain]
  for (const item of later) {
    if (!continues(joined, item, true)) return false
    joined.push(item)
  }
  return true
}

/**
 * Groups card lines into instalment plans: one purchase charged as "n of N"
 * on successive statements. Lines are grouped by description and instalment
 * count, then split into purchases: each line continues a purchase with
 * the same provider purchase date when both know it, or else one whose last
 * instalment is about a month earlier per number; amounts must agree within
 * rounding, and a repeated number is always a new purchase. Instalment
 * metadata without a purchase date proves the numbers, not the purchase.
 *
 * A plan needs the provider's instalment metadata, or at least two lines that
 * progress monthly, because a trailing "03/10" alone may be a date. What
 * remains comes from the provider's purchase total when every instalment so
 * far was seen and none reports a different total, and from the latest
 * instalment's amount otherwise.
 *
 * Lines dated up to `billedThrough`, the open bill's closing, count as
 * charged, pending ones included: they are on the open bill or an earlier
 * one. Some institutions report every instalment at once, later ones dated
 * on their own future bills; those stay in what remains, at their reported
 * amounts, until the clock reaches their bill. Once posted, a line is the
 * same entry, so nothing counts twice.
 */
export const installmentPlans = (
  lines: ReadonlyArray<InstallmentLine>,
  billedThrough: string,
): ReadonlyArray<InstallmentPlan> => {
  const groups = new Map<string, Array<Item>>()
  for (const line of lines) {
    if (line.amountCents >= 0) continue
    const metadata = line.installment
    const numbered =
      metadata?.number != null && metadata.total != null
        ? { number: metadata.number, total: metadata.total }
        : null
    // A pending line may still change; only the provider's numbers count.
    if (line.pending === true && numbered === null) continue
    const parsed = numbered ?? fromDescription(line.description)
    if (!parsed) continue
    const key = [baseOf(line.description), parsed.total].join('|')
    const group = groups.get(key) ?? []
    group.push({
      line,
      number: parsed.number,
      total: parsed.total,
      purchaseDate: metadata?.purchaseDate ?? null,
      totalAmountsCents: metadata?.totalAmountsCents ?? [],
      trusted: numbered !== null,
    })
    groups.set(key, group)
  }

  const plans: Array<InstallmentPlan> = []
  for (const [groupKey, group] of groups) {
    const chains: Array<Array<Item>> = []
    const ordered = [...group].sort(
      (a, b) =>
        a.line.bookedOn.localeCompare(b.line.bookedOn) ||
        a.number - b.number ||
        a.line.entryId.localeCompare(b.line.entryId),
    )
    for (const item of ordered) {
      const chain = chains.find((candidate) => continues(candidate, item))
      if (chain) chain.push(item)
      else chains.push([item])
    }
    // A first instalment the provider dated on the purchase may sit two
    // cycles before the second; description-only instalments join it then,
    // once they progress monthly among themselves, so a lone date-like
    // suffix never does.
    for (const chain of [...chains]) {
      if (chain.length < 2 || chain[0]!.trusted) continue
      const first = chains.find(
        (candidate) =>
          candidate !== chain &&
          candidate.at(-1)!.number === 1 &&
          candidate.at(-1)!.trusted &&
          joins(candidate, chain),
      )
      if (!first) continue
      first.push(...chain)
      chains.splice(chains.indexOf(chain), 1)
    }

    for (const chain of chains) {
      if (!chain.some((item) => item.trusted) && chain.length < 2) continue
      const latest = chain.at(-1)!
      const numbers = chain.map((item) => item.number)
      const total = latest.total
      const charged = chain.filter(
        (item) => item.line.bookedOn <= billedThrough,
      )
      const scheduled = chain.filter(
        (item) => item.line.bookedOn > billedThrough,
      )
      // Without a charged instalment, those before the first scheduled one
      // were billed unseen.
      const billedNumber = charged.at(-1)?.number ?? chain[0]!.number - 1
      const remaining = Math.max(0, total - billedNumber)
      // Any two totals reported for the purchase, on one instalment or
      // across them, leave it unknown.
      const totals = new Set(chain.flatMap((item) => item.totalAmountsCents))
      const knownTotal = totals.size === 1 ? [...totals][0]! : null
      const everyInstallment = numbers.every(
        (number, index) => number === index + 1,
      )
      const billedCents = charged.reduce(
        (sum, item) => sum + item.line.amountCents,
        0,
      )
      const scheduledCents = scheduled.reduce(
        (sum, item) => sum + item.line.amountCents,
        0,
      )
      const remainingCents =
        knownTotal !== null && everyInstallment
          ? Math.min(0, -knownTotal - billedCents)
          : remaining === 0
            ? 0
            : scheduledCents +
              Math.max(0, remaining - scheduled.length) *
                latest.line.amountCents
      const lastBilled = charged.at(-1) ?? scheduled[0]!
      plans.push({
        key: `${groupKey}|${chain[0]!.number}@${chain[0]!.line.bookedOn}|${chain[0]!.line.entryId}`,
        description: latest.line.description,
        amountCents: latest.line.amountCents,
        total,
        seen: charged.map((item) => item.number),
        pending: charged.flatMap((item) =>
          item.line.pending === true ? [item.number] : [],
        ),
        scheduled: scheduled.map((item) => item.number),
        entryIds: chain.map((item) => item.line.entryId),
        remaining,
        remainingCents,
        lastBookedOn: lastBilled.line.bookedOn,
      })
    }
  }
  return plans.sort((a, b) => a.key.localeCompare(b.key))
}
