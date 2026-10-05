/**
 * The person's own category decisions shown to the model beside each
 * merchant it is asked about (few-shot context). Selection is pure and
 * deterministic so a cached answer can be tied to exactly the examples it
 * saw, and only an example change that reaches an item asks again.
 *
 * Only decisions a person made ever enter the pool; model answers, store
 * patterns, reconciliation and provider categories never do (the caller
 * passes `category_decisions` only).
 */
import { knowledgeKey, merchantSignature } from './Patterns.ts'
import type { Direction } from './Patterns.ts'

/** A decision the person made, as a candidate example. */
export interface DecidedExample {
  readonly description: string
  readonly amountCents: number
  readonly categoryId: string
  /** Order of decisions: higher is more recent. */
  readonly revision: number
}

/** What the model sees of one past decision. */
export interface ClassifierExample {
  readonly description: string
  readonly categoryId: string
}

/** Examples per item: enough for a merchant's conventions, small enough to keep the state focused. */
export const maxExamples = 8

/**
 * Part of every context key: bump it when selection or how examples reach
 * the model changes, so cached answers are asked again under the new rule.
 */
export const EXAMPLES_VERSION = 1

// Words that name how money moved or a legal form, not who was paid.
const stopTokens: ReadonlySet<string> = new Set([
  'enviado',
  'recebido',
  'efetuado',
  'conta',
  'qr',
  'cp',
  'de',
  'da',
  'do',
  'das',
  'dos',
  'e',
  'em',
  'com',
  'para',
  'por',
  'ltda',
  'me',
  'sa',
  'eireli',
  'epp',
  'loja',
  'parcela',
  'br',
  'www',
])

const tokensOf = (description: string): ReadonlySet<string> =>
  new Set(
    merchantSignature(description)
      .split(' ')
      .filter(
        (token) =>
          token.length >= 2 && !/^\d+$/.test(token) && !stopTokens.has(token),
      ),
  )

interface Candidate {
  readonly example: ClassifierExample
  readonly revision: number
  readonly tokens: ReadonlySet<string>
}

/**
 * Prepares the pool once and returns the examples for an item: decisions
 * of the same direction sharing a merchant word with it, rarer shared words
 * counting more, the most recent first among equals; at most `limit`, one
 * per merchant (its latest decision). An item that shares no word with any
 * decision gets none, so an unrelated decision never changes its examples.
 */
export const examplePicker = (
  pool: ReadonlyArray<DecidedExample>,
  limit: number = maxExamples,
) => {
  const latest = new Map<string, DecidedExample & { direction: Direction }>()
  for (const decision of pool) {
    const key = knowledgeKey(decision)
    if (key === null) continue
    const id = `${key.direction}|${key.pattern}`
    const found = latest.get(id)
    if (found === undefined || found.revision < decision.revision)
      latest.set(id, { ...decision, direction: key.direction })
  }
  const byDirection = new Map<Direction, Array<Candidate>>([
    ['expense', []],
    ['income', []],
  ])
  for (const decision of latest.values())
    byDirection.get(decision.direction)!.push({
      example: {
        description: decision.description,
        categoryId: decision.categoryId,
      },
      revision: decision.revision,
      tokens: tokensOf(decision.description),
    })
  const frequency = new Map<Direction, Map<string, number>>()
  for (const [direction, candidates] of byDirection) {
    const counts = new Map<string, number>()
    for (const candidate of candidates)
      for (const token of candidate.tokens)
        counts.set(token, (counts.get(token) ?? 0) + 1)
    frequency.set(direction, counts)
  }

  return (item: {
    readonly description: string
    readonly direction: Direction
  }): ReadonlyArray<ClassifierExample> => {
    const wanted = tokensOf(item.description)
    if (wanted.size === 0 || limit <= 0) return []
    const counts = frequency.get(item.direction)!
    return byDirection
      .get(item.direction)!
      .flatMap((candidate) => {
        let score = 0
        for (const token of candidate.tokens)
          if (wanted.has(token)) score += 1 / counts.get(token)!
        return score > 0 ? [{ candidate, score }] : []
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.candidate.revision - a.candidate.revision ||
          a.candidate.example.description.localeCompare(
            b.candidate.example.description,
          ),
      )
      .slice(0, limit)
      .map(({ candidate }) => candidate.example)
  }
}

/**
 * The examples as one canonical string, hashed into the cache key; empty
 * when there are none, so answers given without examples stay valid while
 * an item still has none.
 */
export const exampleContext = (examples: ReadonlyArray<ClassifierExample>) =>
  examples.length === 0
    ? ''
    : [
        `v${EXAMPLES_VERSION}`,
        ...examples.map(
          (example) => `${example.categoryId}\u0000${example.description}`,
        ),
      ].join('\u0001')
