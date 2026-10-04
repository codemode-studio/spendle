import { assert, describe, it } from '@effect/vitest'

import {
  isValidKnowledgePattern,
  knowledgeExactPatterns,
  knowledgeKey,
  knowledgePattern,
  knowledgePrefixCandidate,
  matchesKnowledgePrefix,
  merchantSignature,
  normalizeDescription,
  normalizeKnowledgePattern,
} from './Patterns.ts'

describe('knowledgePattern', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
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
  ]
  for (const [description, expected] of cases) {
    it(`${description} → ${expected}`, () => {
      assert.strictEqual(knowledgePattern(description), expected)
    })
  }

  it('keeps a lone processor and numbers outside the instalment suffix', () => {
    assert.strictEqual(knowledgePattern('MP'), 'mp')
    assert.strictEqual(
      knowledgePattern('Fronteira 3141 Hamburg'),
      'fronteira hamburg',
    )
    assert.strictEqual(
      knowledgePattern('Loja 12 parcelamentos'),
      'loja 12 parcelamentos',
    )
  })
})

describe('prefixes', () => {
  it('suggests an aggregator only when a name follows it', () => {
    assert.strictEqual(
      knowledgePrefixCandidate('ifd pizzaria do johnny'),
      'ifd',
    )
    assert.strictEqual(
      knowledgePrefixCandidate('mercadolivre mercadol'),
      'mercadolivre',
    )
    assert.strictEqual(knowledgePrefixCandidate('nuv sunflower'), 'nuv')
    assert.strictEqual(knowledgePrefixCandidate('mp belive'), 'mp')
    assert.isNull(knowledgePrefixCandidate('shopee'))
    assert.isNull(knowledgePrefixCandidate('uber trip'))
  })

  it('matches on a token boundary', () => {
    assert.isTrue(matchesKnowledgePrefix('ifd pizzaria', 'ifd'))
    assert.isTrue(matchesKnowledgePrefix('ifd', 'ifd'))
    assert.isFalse(matchesKnowledgePrefix('ifdx loja', 'ifd'))
    assert.isFalse(matchesKnowledgePrefix('loja ifd', 'ifd'))
  })
})

describe('typed patterns', () => {
  it('normalizes accents, case and punctuation', () => {
    assert.strictEqual(
      normalizeKnowledgePattern('  Padaria São José * '),
      'padaria sao jose',
    )
  })

  it('needs three characters and a letter', () => {
    assert.isFalse(isValidKnowledgePattern('ab'))
    assert.isFalse(isValidKnowledgePattern('1234'))
    assert.isTrue(isValidKnowledgePattern('ifd'))
  })
})

describe('knowledgeExactPatterns', () => {
  it('reads the payee after explicit payment wording', () => {
    assert.include(
      knowledgeExactPatterns('Pagamento efetuado: "ESCOLA EXEMPLO"'),
      'escola exemplo',
    )
    assert.include(knowledgeExactPatterns('Pagamento de conta ALFA'), 'alfa')
    assert.notInclude(knowledgeExactPatterns('Loja Pagamento Efetuado'), 'loja')
  })

  it('keeps the specific pattern and offers the shop without its branch', () => {
    assert.deepStrictEqual(knowledgeExactPatterns('ANGELONI SUPER LOJA 41'), [
      'angeloni super loja 41',
      'angeloni super loja',
    ])
    assert.deepStrictEqual(knowledgeExactPatterns('ESTABELECIMENTO 41'), [
      'estabelecimento 41',
    ])
  })
})

// Computed by V1's `normalizeDescription`, `merchantSignature` and
// `knowledgeExactPatterns`; V1 decisions only keep matching while these agree.
describe('V1 parity', () => {
  const table: ReadonlyArray<
    readonly [string, string, string, ReadonlyArray<string>]
  > = [
    [
      'PIX ENVIADO 12345678 João da Silva',
      'pix enviado 12345678 joao da silva',
      'enviado joao da silva',
      ['enviado joao da silva', 'joao da silva'],
    ],
    [
      'Compra no débito - PADARIA SÃO JOSÉ',
      'compra no debito - padaria sao jose',
      'no padaria sao jose',
      ['no padaria sao jose'],
    ],
    [
      'Pagamento de fatura cartão VISA 1234',
      'pagamento de fatura cartao visa 1234',
      'de fatura',
      ['de fatura'],
    ],
    [
      'TED 001 0001 Maria Souza',
      'ted 001 0001 maria souza',
      '001 maria souza',
      ['001 maria souza'],
    ],
    [
      'UBER *TRIP 3f2a9c1e-1234-4abc-9def-0123456789ab',
      'uber *trip 3f2a9c1e-1234-4abc-9def-0123456789ab',
      'uber trip',
      ['uber trip'],
    ],
    ['Netflix.com 12/09', 'netflix.com 12/09', 'netflix com', ['netflix com']],
    [
      'MERCADOLIVRE*4PRODUTOS (Parcela 09 de 12)',
      'mercadolivre*4produtos (parcela 09 de 12)',
      'mercadolivre 4produtos parcela 09 de 12',
      ['mercadolivre 4produtos'],
    ],
    [
      'Ifd*54857747 Paulo Rob',
      'ifd*54857747 paulo rob',
      'ifd paulo rob',
      ['ifd paulo rob'],
    ],
    [
      'Café & Cia.  —  Loja 3',
      'cafe & cia. — loja 3',
      'cafe cia loja 3',
      ['cafe cia loja 3', 'cafe cia loja'],
    ],
    [
      'PGTO CONTA LUZ 09/2026',
      'pgto conta luz 09/2026',
      'conta luz 09',
      ['conta luz 09'],
    ],
    [
      'Débito automático Seguro Auto 15-09-26',
      'debito automatico seguro auto 15-09-26',
      'automatico seguro auto',
      ['automatico seguro auto'],
    ],
    [
      'Mastercard Black Anuidade 3/12',
      'mastercard black anuidade 3/12',
      'black anuidade',
      ['black anuidade'],
    ],
    [
      'Spotify   P0A1B2C3',
      'spotify p0a1b2c3',
      'spotify p0a1b2c3',
      ['spotify p0a1b2c3'],
    ],
    [
      '  ANGELONI SUPER LOJA 41 ',
      'angeloni super loja 41',
      'angeloni super loja 41',
      ['angeloni super loja 41', 'angeloni super loja'],
    ],
    [
      'Pix recebido: "Cp :12345678-CLIENTE EXEMPLO"',
      'pix recebido: "cp :12345678-cliente exemplo"',
      'recebido cp cliente exemplo',
      ['recebido cliente exemplo', 'cliente exemplo'],
    ],
    [
      'Pagamento efetuado: "ESCOLA EXEMPLO"',
      'pagamento efetuado: "escola exemplo"',
      'efetuado escola exemplo',
      ['efetuado escola exemplo', 'escola exemplo'],
    ],
    [
      'Pagamento de conta ALFA',
      'pagamento de conta alfa',
      'de conta alfa',
      ['de conta alfa', 'alfa'],
    ],
    [
      'Pix enviado WHOOSH BR ALUGUEL DE PATINETES LT',
      'pix enviado whoosh br aluguel de patinetes lt',
      'enviado whoosh br aluguel de patinetes lt',
      [
        'enviado whoosh br aluguel de patinetes lt',
        'whoosh br aluguel de patinetes lt',
      ],
    ],
  ]
  for (const [description, normalized, signature, patterns] of table) {
    it(description, () => {
      assert.strictEqual(normalizeDescription(description), normalized)
      assert.strictEqual(merchantSignature(description), signature)
      assert.deepStrictEqual(knowledgeExactPatterns(description), patterns)
    })
  }
})

describe('knowledgeKey', () => {
  it('keys by pattern and direction, without instalment numbers', () => {
    assert.deepStrictEqual(
      knowledgeKey({
        description: 'Sephora Store - Parcela 1/6',
        amountCents: -10000,
      }),
      {
        signature: 'sephora store parcela',
        pattern: 'sephora store',
        direction: 'expense',
      },
    )
    assert.strictEqual(
      knowledgeKey({ description: 'Sephora Store', amountCents: 500 })
        ?.direction,
      'income',
    )
  })

  it('learns nothing from a zero amount or a nameless description', () => {
    assert.isNull(knowledgeKey({ description: 'Padaria', amountCents: 0 }))
    assert.isNull(
      knowledgeKey({ description: 'PIX 12345678', amountCents: -1 }),
    )
  })
})
