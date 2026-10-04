/**
 * Merchant patterns the category store learns and matches, ported from V1
 * (`normalizeDescription`, `merchantSignature` and `knowledge-pattern.ts`) so
 * decisions imported from V1 keep matching the same descriptions.
 *
 * A pattern starts from the merchant signature and applies only two
 * closed-list reductions: the instalment suffix and a leading payment
 * processor. Nothing strips numbers or fragments generically.
 */

/** Lowercase, accentless, single-spaced. */
export const normalizeDescription = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

/**
 * The description without payment wording, ids, long numbers, dates and
 * punctuation: what stays the same across one merchant's charges.
 */
export const merchantSignature = (value: string) =>
  normalizeDescription(value)
    .replace(
      /\b(?:pix|ted|doc|pg|pagamento|pgto|compra|debito|credito|cartao|visa|mastercard)\b/g,
      ' ',
    )
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g, ' ')
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Leading payment-processor tokens that precede the real merchant name. */
const paymentProcessors = new Set([
  'pg',
  'stb',
  'payu',
  'vindi',
  'zp',
  'htm',
  'pag',
])

/**
 * Aggregators whose first token already decides the category, so they stay
 * in the pattern and may become prefixes: `mp` (Mercado Pago), `nuv`
 * (Nuvemshop).
 */
export const knowledgeAggregators: ReadonlySet<string> = new Set([
  'ifd',
  'mercadolivre',
  'shopee',
  'mp',
  'nuv',
])

/** `parcela 01 de 02`, `parcela 3` or just `parcela` (`1/2` already left the signature). */
const installmentSuffix = /\s+parcela(?:\s+\d{1,2}(?:\s+de\s+\d{1,2})?)?$/

export type MatchMode = 'exact' | 'prefix'

export const minPatternLength = 3

/** At least three characters and one letter. */
export const isValidKnowledgePattern = (pattern: string) =>
  pattern.length >= minPatternLength && /[a-z]/.test(pattern)

/** Normalizes a pattern the person typed to the signatures' alphabet. */
export const normalizeKnowledgePattern = (value: string) =>
  normalizeDescription(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** The exact pattern of a description; empty when it names nothing useful. */
export const knowledgePattern = (description: string) => {
  // Inter may wrap a Pix counterpart in an institution code. Removing only
  // that shape keeps a shop's initials from passing for metadata.
  const counterpart = description.replace(
    /^(pix\s+(?:enviado|recebido)\s*:\s*["']?)cp\s*:\s*\d{8}\s*-\s*/i,
    '$1',
  )
  let pattern = merchantSignature(counterpart).replace(installmentSuffix, '')
  const tokens = pattern.split(' ')
  if (tokens.length > 1 && paymentProcessors.has(tokens[0]!)) {
    pattern = tokens.slice(1).join(' ')
  }
  return pattern
}

/** The first token when it is a known aggregator followed by a name. */
export const knowledgePrefixCandidate = (pattern: string) => {
  const tokens = pattern.split(' ')
  return tokens.length > 1 && knowledgeAggregators.has(tokens[0]!)
    ? tokens[0]!
    : null
}

/** A prefix matches on a token boundary: `ifd` matches `ifd pizzaria`, not `ifdx`. */
export const matchesKnowledgePrefix = (pattern: string, prefix: string) =>
  pattern === prefix || pattern.startsWith(`${prefix} `)

/**
 * The primary pattern, then an alternative after explicit banking wording
 * (a Pix counterpart, a paid bill's payee, a shop without its branch
 * number), keeping the specific one first.
 */
export const knowledgeExactPatterns = (
  description: string,
): ReadonlyArray<string> => {
  const primary = knowledgePattern(description)
  const store = primary.replace(/(\bloja)\s+\d{1,4}$/, '$1')
  if (store !== primary && isValidKnowledgePattern(store))
    return [primary, store]
  const payment = description
    .trim()
    .match(/^pagamento\s+(?:efetuado\s*:|de\s+conta\b)\s*(.+)$/i)
  if (payment) {
    const counterpart = knowledgePattern(payment[1]!)
    return counterpart !== primary && isValidKnowledgePattern(counterpart)
      ? [primary, counterpart]
      : [primary]
  }
  if (!/^pix\s+(?:enviado|recebido)\b/i.test(description.trim()))
    return [primary]
  const counterpart = primary.replace(/^(?:enviado|recebido)\s+/, '')
  return counterpart !== primary && isValidKnowledgePattern(counterpart)
    ? [primary, counterpart]
    : [primary]
}

export type Direction = 'income' | 'expense'

/** What the store keys a movement by, or `null` when it has nothing to learn from. */
export interface KnowledgeKey {
  readonly signature: string
  readonly pattern: string
  readonly direction: Direction
}

export const knowledgeKey = (input: {
  readonly description: string
  readonly amountCents: number
}): KnowledgeKey | null => {
  if (input.amountCents === 0) return null
  const signature = merchantSignature(input.description)
  const pattern = knowledgePattern(input.description)
  if (!isValidKnowledgePattern(signature) || !isValidKnowledgePattern(pattern))
    return null
  return {
    signature,
    pattern,
    direction: input.amountCents < 0 ? 'expense' : 'income',
  }
}
