/**
 * Strategy arithmetic: how a monthly income divides into envelopes. Pure;
 * amounts are integer centavos and shares are basis points (10 000 = 100%).
 */

export const allocationBuckets = [
  'essential',
  'lifestyle',
  'investment',
  'reserve',
] as const
export type AllocationBucket = (typeof allocationBuckets)[number]

/** Basis points per envelope, or centavos per envelope. */
export type Allocation = Readonly<Record<AllocationBucket, number>>

export const strategyTemplates = [
  'balanced',
  'wealth',
  'aggressive',
  'independence',
] as const
export type StrategyTemplate = (typeof strategyTemplates)[number]

export const isValidAllocation = (allocation: Allocation) =>
  allocationBuckets.every(
    (bucket) =>
      Number.isInteger(allocation[bucket]) &&
      allocation[bucket] >= 0 &&
      allocation[bucket] <= 10_000,
  ) &&
  allocationBuckets.reduce((sum, bucket) => sum + allocation[bucket], 0) ===
    10_000

/** `basisPoints` of `baseCents`, rounded to the centavo. */
export const allocationAmount = (baseCents: number, basisPoints: number) =>
  Math.round((baseCents * basisPoints) / 10_000)

export const targetsFor = (baseCents: number, allocation: Allocation) => ({
  essential: allocationAmount(baseCents, allocation.essential),
  lifestyle: allocationAmount(baseCents, allocation.lifestyle),
  investment: allocationAmount(baseCents, allocation.investment),
  reserve: allocationAmount(baseCents, allocation.reserve),
})

/**
 * The income a month is planned on: the person's target until three months
 * are closed, then the average income of the latest three closed months,
 * never above the target.
 */
export const conservativeBase = (
  targetCents: number,
  closedIncomesLatestFirst: ReadonlyArray<number>,
) => {
  if (closedIncomesLatestFirst.length < 3) return targetCents
  const lastThree = closedIncomesLatestFirst.slice(0, 3)
  const average = Math.round(
    lastThree.reduce((sum, cents) => sum + cents, 0) / lastThree.length,
  )
  return Math.min(targetCents, Math.max(0, average))
}

/**
 * Once the emergency reserve reaches its target, its share goes to
 * investments, unless the person keeps contributing to it.
 */
export const effectiveAllocation = (
  allocation: Allocation,
  reserveComplete: boolean,
  keepReserveContributions: boolean,
): Allocation =>
  !reserveComplete || keepReserveContributions
    ? { ...allocation }
    : {
        ...allocation,
        investment: allocation.investment + allocation.reserve,
        reserve: 0,
      }
