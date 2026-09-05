/**
 * Padrão de estabelecimento usado pela base de conhecimento.
 *
 * Parte da assinatura do estabelecimento (`merchantSignature`) e aplica só
 * duas reduções com lista fechada: sufixo de parcela e prefixo de processador
 * de pagamento. Nada de remoção genérica de números ou fragmentos. A detecção
 * de recorrências continua usando a assinatura completa.
 */
import { normalizeDescription } from './finance'
import { merchantSignature } from './recurrence-book'

/** Tokens iniciais de processadores de pagamento que precedem o nome real. */
const PAYMENT_PROCESSORS = new Set([
  'pg',
  'stb',
  'payu',
  'vindi',
  'zp',
  'htm',
  'pag',
])

/**
 * Agregadores cujo primeiro token já define a categoria; candidatos a prefixo.
 * `mp` (Mercado Pago) e `nuv` (Nuvemshop) ficam no padrão por isso.
 */
export const KNOWLEDGE_AGGREGATORS = new Set([
  'ifd',
  'mercadolivre',
  'shopee',
  'mp',
  'nuv',
])

/** `parcela 01 de 02`, `parcela 3` ou só `parcela` (a fração `1/2` já saiu da assinatura). */
const INSTALLMENT_SUFFIX = /\s+parcela(?:\s+\d{1,2}(?:\s+de\s+\d{1,2})?)?$/

export type KnowledgeMatchMode = 'exact' | 'prefix'

export const KNOWLEDGE_PATTERN_MIN_LENGTH = 3

export function isValidKnowledgePattern(pattern: string) {
  return pattern.length >= KNOWLEDGE_PATTERN_MIN_LENGTH && /[a-z]/.test(pattern)
}

/** Normaliza um padrão digitado pela pessoa para o mesmo alfabeto das assinaturas. */
export function normalizeKnowledgePattern(value: string) {
  return normalizeDescription(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Padrão exato derivado de uma descrição. Vazio quando a descrição não tem nome útil. */
export function knowledgePattern(description: string) {
  // O Inter pode envolver a contraparte Pix com um código de instituição.
  // Remover apenas esse formato evita confundir a sigla de uma loja com metadados.
  const counterpartDescription = description.replace(
    /^(pix\s+(?:enviado|recebido)\s*:\s*["']?)cp\s*:\s*\d{8}\s*-\s*/i,
    '$1',
  )
  const signature = merchantSignature(counterpartDescription)
  let pattern = signature.replace(INSTALLMENT_SUFFIX, '')
  const tokens = pattern.split(' ')
  if (tokens.length > 1 && PAYMENT_PROCESSORS.has(tokens[0])) {
    pattern = tokens.slice(1).join(' ')
  }
  return pattern
}

/** Primeiro token quando ele é um agregador conhecido e há um nome depois dele. */
export function knowledgePrefixCandidate(pattern: string) {
  const tokens = pattern.split(' ')
  return tokens.length > 1 && KNOWLEDGE_AGGREGATORS.has(tokens[0])
    ? tokens[0]
    : null
}

/** Um prefixo casa no limite de token: `ifd` casa `ifd pizzaria`, não `ifdx`. */
export function matchesKnowledgePrefix(pattern: string, prefix: string) {
  return pattern === prefix || pattern.startsWith(`${prefix} `)
}

/** Alternativa exata após textos bancários explícitos, preservando o padrão original. */
export function knowledgeExactPatterns(description: string) {
  const primary = knowledgePattern(description)
  const store = primary.replace(/(\bloja)\s+\d{1,4}$/, '$1')
  if (store !== primary && isValidKnowledgePattern(store))
    return [primary, store]
  const payment = description
    .trim()
    .match(/^pagamento\s+(?:efetuado\s*:|de\s+conta\b)\s*(.+)$/i)
  if (payment) {
    const counterpart = knowledgePattern(payment[1])
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
