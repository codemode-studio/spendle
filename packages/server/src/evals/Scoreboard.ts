/**
 * Scores what the app would do with each movement of the frozen category
 * evaluation (`evals/categories`) against the person's own decisions. Pure:
 * `EvalCategories.ts` gathers the answers, this decides what they are worth.
 */

export interface EvalItem {
  readonly id: string
  readonly description: string
  readonly amountCents: number
  /** `null`: a transfer or card payment that should get no category. */
  readonly expectedCategoryId: string | null
  /** `false`: a personal convention or opaque description; scored apart. */
  readonly guessable: boolean
}

/** The model's answer for one item. */
export interface ModelAnswer {
  readonly categoryId: string | null
  readonly probability: number
}

/** What the app does with one item: a category, applied or sent to review. */
export interface Outcome {
  readonly categoryId: string | null
  readonly applied: boolean
}

export type Outcomes = ReadonlyMap<string, Outcome>

/** Ratios from 0 to 1; `null` when nothing was counted. */
export interface SubsetScore {
  readonly items: number
  /** Of the applied categories, how many match the person's decision. */
  readonly accuracyWhenConfident: number | null
  /** How many items got a category applied. */
  readonly coverage: number | null
  /** Items resolved right without review: the real gain. */
  readonly correctAndConfident: number | null
  /** Right category whether applied or in review. */
  readonly accuracyAnyConfidence: number | null
}

const ratio = (part: number, whole: number) => (whole ? part / whole : null)

const isPurchase = (item: EvalItem) => item.expectedCategoryId !== null

const correct = (item: EvalItem, outcomes: Outcomes) =>
  outcomes.get(item.id)?.categoryId === item.expectedCategoryId

const appliedCategory = (item: EvalItem, outcomes: Outcomes) => {
  const outcome = outcomes.get(item.id)
  return outcome?.applied === true && outcome.categoryId !== null
}

export const scoreSubset = (
  items: ReadonlyArray<EvalItem>,
  outcomes: Outcomes,
): SubsetScore => {
  const applied = items.filter((item) => appliedCategory(item, outcomes))
  const appliedRight = applied.filter((item) => correct(item, outcomes))
  return {
    items: items.length,
    accuracyWhenConfident: ratio(appliedRight.length, applied.length),
    coverage: ratio(applied.length, items.length),
    correctAndConfident: ratio(appliedRight.length, items.length),
    accuracyAnyConfidence: ratio(
      items.filter((item) => correct(item, outcomes)).length,
      items.length,
    ),
  }
}

export interface Miss {
  readonly id: string
  readonly description: string
  readonly expected: string | null
  readonly applied: string | null
  readonly guessable: boolean
}

export interface Scoreboard {
  readonly guessable: SubsetScore
  readonly personalConvention: SubsetScore
  readonly allPurchases: SubsetScore
  /** Transfers and card payments that got a category applied. */
  readonly movementsApplied: { readonly applied: number; readonly of: number }
  /** Applied categories that differ from the person's decision. */
  readonly misses: ReadonlyArray<Miss>
}

export const scoreboard = (
  exam: ReadonlyArray<EvalItem>,
  outcomes: Outcomes,
): Scoreboard => {
  const purchases = exam.filter(isPurchase)
  const movements = exam.filter((item) => !isPurchase(item))
  return {
    guessable: scoreSubset(
      purchases.filter((item) => item.guessable),
      outcomes,
    ),
    personalConvention: scoreSubset(
      purchases.filter((item) => !item.guessable),
      outcomes,
    ),
    allPurchases: scoreSubset(purchases, outcomes),
    movementsApplied: {
      applied: movements.filter((item) => appliedCategory(item, outcomes))
        .length,
      of: movements.length,
    },
    misses: exam
      .filter(
        (item) => appliedCategory(item, outcomes) && !correct(item, outcomes),
      )
      .map((item) => ({
        id: item.id,
        description: item.description,
        expected: item.expectedCategoryId,
        applied: outcomes.get(item.id)?.categoryId ?? null,
        guessable: item.guessable,
      })),
  }
}

/** What the app does with the model's answers at `threshold`, below `floor` nothing. */
export const modelOutcomes = (
  answers: ReadonlyMap<string, ModelAnswer>,
  threshold: number,
  floor: number,
): Outcomes =>
  new Map(
    [...answers].map(([id, answer]) => [
      id,
      answer.categoryId === null || answer.probability < floor
        ? { categoryId: null, applied: false }
        : {
            categoryId: answer.categoryId,
            applied: answer.probability >= threshold,
          },
    ]),
  )

/**
 * How production combines them: the deterministic policy's applied
 * category wins; otherwise the model's, applied or in review; otherwise
 * whatever the policy sent to review.
 */
export const combineOutcomes = (policy: Outcomes, model: Outcomes): Outcomes =>
  new Map(
    [...new Set([...policy.keys(), ...model.keys()])].map((id) => {
      const fromPolicy = policy.get(id)
      const fromModel = model.get(id)
      if (fromPolicy?.applied && fromPolicy.categoryId !== null)
        return [id, fromPolicy]
      if (fromModel?.categoryId != null) return [id, fromModel]
      return [id, fromPolicy ?? { categoryId: null, applied: false }]
    }),
  )

export interface ThresholdRow {
  readonly threshold: number
  /** Items, transfers included, that would get a category applied. */
  readonly applied: number
  /** Of those, right; an applied transfer counts as wrong. */
  readonly accuracyWhenConfident: number | null
  readonly correctAndConfident: number | null
  readonly guessableCorrectAndConfident: number | null
  readonly movementsApplied: number
}

const thresholdRow = (
  exam: ReadonlyArray<EvalItem>,
  answers: ReadonlyMap<string, ModelAnswer>,
  threshold: number,
  floor: number,
): ThresholdRow => {
  const outcomes = modelOutcomes(answers, threshold, floor)
  const applied = exam.filter((item) => appliedCategory(item, outcomes))
  const board = scoreboard(exam, outcomes)
  return {
    threshold,
    applied: applied.length,
    accuracyWhenConfident: ratio(
      applied.filter((item) => correct(item, outcomes)).length,
      applied.length,
    ),
    correctAndConfident: board.allPurchases.correctAndConfident,
    guessableCorrectAndConfident: board.guessable.correctAndConfident,
    movementsApplied: board.movementsApplied.applied,
  }
}

/** The scoreboard at each threshold, for choosing `TYPESAFE_APPLY_THRESHOLD`. */
export const sweep = (
  exam: ReadonlyArray<EvalItem>,
  answers: ReadonlyMap<string, ModelAnswer>,
  thresholds: ReadonlyArray<number>,
  floor: number,
): ReadonlyArray<ThresholdRow> =>
  thresholds.map((threshold) => thresholdRow(exam, answers, threshold, floor))

export interface ThresholdTarget {
  /** Applied answers must be right at least this often, e.g. 0.97. */
  readonly accuracy: number
  /** Too few applied answers say nothing; below this a threshold is not offered. */
  readonly minApplied: number
}

/**
 * The lowest threshold from which every higher one with enough applied
 * answers meets the target, so a lucky dip in the middle is not picked;
 * `null` when none does, and every answer should keep going to review.
 * Candidates are the probabilities the model actually gave.
 */
export const recommendThreshold = (
  exam: ReadonlyArray<EvalItem>,
  answers: ReadonlyMap<string, ModelAnswer>,
  target: ThresholdTarget,
  floor: number,
): ThresholdRow | null => {
  const candidates = [
    ...new Set(
      [...answers.values()]
        .filter((answer) => answer.categoryId !== null)
        .map((answer) => answer.probability)
        .filter((probability) => probability >= floor),
    ),
  ].sort((a, b) => b - a)
  let chosen: ThresholdRow | null = null
  for (const threshold of candidates) {
    const row = thresholdRow(exam, answers, threshold, floor)
    if (row.applied < target.minApplied) continue
    if ((row.accuracyWhenConfident ?? 0) < target.accuracy) break
    chosen = row
  }
  return chosen
}

export interface CalibrationRow {
  readonly probability: string
  readonly answers: number
  readonly accuracy: number | null
}

/** How often answers in each probability band are right, transfers included. */
export const calibration = (
  exam: ReadonlyArray<EvalItem>,
  answers: ReadonlyMap<string, ModelAnswer>,
): ReadonlyArray<CalibrationRow> =>
  (
    [
      [0, 0.5],
      [0.5, 0.7],
      [0.7, 0.9],
      [0.9, 0.97],
      [0.97, 1.01],
    ] as const
  ).map(([from, to]) => {
    const band = exam.filter((item) => {
      const answer = answers.get(item.id)
      return (
        answer !== undefined &&
        answer.categoryId !== null &&
        answer.probability >= from &&
        answer.probability < to
      )
    })
    return {
      probability: `${from}-${Math.min(to, 1)}`,
      answers: band.length,
      accuracy: ratio(
        band.filter(
          (item) =>
            answers.get(item.id)?.categoryId === item.expectedCategoryId,
        ).length,
        band.length,
      ),
    }
  })
