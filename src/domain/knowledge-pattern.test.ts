import { describe, expect, it } from 'vitest'

import {
  isValidKnowledgePattern,
  knowledgePattern,
  knowledgeExactPatterns,
  knowledgePrefixCandidate,
  matchesKnowledgePrefix,
  normalizeKnowledgePattern,
} from './knowledge-pattern'

describe('knowledgePattern', () => {
  it.each([
    ['MERCADOLIVRE*MERCADOL (Parcela 01 de 02)', 'mercadolivre mercadol'],
    ['MERCADOLIVRE*4PRODUTOS (Parcela 09 de 12)', 'mercadolivre 4produtos'],
    ['Nuv*Sunflower - Parcela 1/2', 'nuv sunflower'],
    ['MP *BELIVE (Parcela 01 de 02)', 'mp belive'],
    ['Payu *Adidas - Parcela 2/2', 'adidas'],
    ['Sephora Store - Parcela 1/6', 'sephora store'],
    ['Andrade e Ceccon - Parcela 6/6', 'andrade e ceccon'],
    ['Stb*Carbonepizzaria', 'carbonepizzaria'],
    [
      'Pix enviado: "Cp :12345678-LOCADORA EXEMPLO"',
      'enviado locadora exemplo',
    ],
    [
      'Pix recebido: "Cp :12345678-CLIENTE EXEMPLO"',
      'recebido cliente exemplo',
    ],
    ['CP Comercio 123', 'cp comercio 123'],
    ['Mp *Dayanemeilipalma', 'mp dayanemeilipalma'],
    ['Htm*Besties em Flor', 'besties em flor'],
    ['ZP*GW HAPPY KIDS LTDA', 'gw happy kids ltda'],
    ['PG *ZE DELIVERY', 'ze delivery'],
    ['Ifd*54857747 Paulo Rob', 'ifd paulo rob'],
    ['ANGELONI SUPER LOJA 41', 'angeloni super loja 41'],
    [
      'Pix enviado WHOOSH BR ALUGUEL DE PATINETES LT',
      'enviado whoosh br aluguel de patinetes lt',
    ],
  ])('%s → %s', (description, expected) => {
    expect(knowledgePattern(description)).toBe(expected)
  })

  it('não remove um processador sozinho nem números fora do sufixo de parcela', () => {
    expect(knowledgePattern('MP')).toBe('mp')
    expect(knowledgePattern('Fronteira 3141 Hamburg')).toBe('fronteira hamburg')
    expect(knowledgePattern('Loja 12 parcelamentos')).toBe(
      'loja 12 parcelamentos',
    )
  })
})

describe('prefixos', () => {
  it('sugere o agregador só quando há um nome depois dele', () => {
    expect(knowledgePrefixCandidate('ifd pizzaria do johnny')).toBe('ifd')
    expect(knowledgePrefixCandidate('mercadolivre mercadol')).toBe(
      'mercadolivre',
    )
    expect(knowledgePrefixCandidate('nuv sunflower')).toBe('nuv')
    expect(knowledgePrefixCandidate('mp belive')).toBe('mp')
    expect(knowledgePrefixCandidate('shopee')).toBeNull()
    expect(knowledgePrefixCandidate('uber trip')).toBeNull()
  })

  it('casa no limite de token', () => {
    expect(matchesKnowledgePrefix('ifd pizzaria', 'ifd')).toBe(true)
    expect(matchesKnowledgePrefix('ifd', 'ifd')).toBe(true)
    expect(matchesKnowledgePrefix('ifdx loja', 'ifd')).toBe(false)
    expect(matchesKnowledgePrefix('loja ifd', 'ifd')).toBe(false)
  })
})

describe('padrão digitado', () => {
  it('normaliza acentos, maiúsculas e pontuação', () => {
    expect(normalizeKnowledgePattern('  Padaria São José * ')).toBe(
      'padaria sao jose',
    )
  })

  it('exige três caracteres e uma letra', () => {
    expect(isValidKnowledgePattern('ab')).toBe(false)
    expect(isValidKnowledgePattern('1234')).toBe(false)
    expect(isValidKnowledgePattern('ifd')).toBe(true)
  })
})

it('reconhece o favorecido após os textos bancários explícitos de pagamento', () => {
  expect(
    knowledgeExactPatterns('Pagamento efetuado: "ESCOLA EXEMPLO"'),
  ).toContain('escola exemplo')
  expect(knowledgeExactPatterns('Pagamento de conta ALFA')).toContain('alfa')
  expect(knowledgeExactPatterns('Loja Pagamento Efetuado')).not.toContain(
    'loja',
  )
})
