import { assert, describe, it } from '@effect/vitest'

import { relationKey } from './Keys.ts'
import { matchRelations } from './Matching.ts'
import type { Decision, MatchableEntry } from './Matching.ts'

const entry = (
  id: string,
  amountCents: number,
  bookedOn: string,
  description: string,
  accountId = 'card',
  operationTypes: ReadonlyArray<string> = [],
): MatchableEntry => ({
  operationTypes,
  id,
  accountId,
  accountKind: accountId === 'card' ? 'credit_card' : 'checking',
  bookedOn,
  amountCents,
  currency: 'BRL',
  status: 'posted',
  description,
  descriptions: [description],
})

const summary = (
  entries: ReadonlyArray<MatchableEntry>,
  decisions = new Map<string, Decision>(),
) =>
  matchRelations(entries, decisions).relations.map((relation) => [
    relation.kind,
    relation.outflowId,
    relation.inflowId,
    relation.status,
  ])

describe('refund matching', () => {
  it('confirms a refund that names the purchase merchant', () => {
    assert.deepStrictEqual(
      summary([
        entry('order', -25000, '2026-09-01', 'Amazon Marketplace'),
        entry('back', 25000, '2026-09-20', 'Estorno Amazon Marketplace'),
      ]),
      [['refund', 'order', 'back', 'confirmed']],
    )
  })

  it('suggests a partial credit from the same merchant without refund wording', () => {
    assert.deepStrictEqual(
      summary([
        entry('order', -25000, '2026-09-01', 'Magazine Luiza'),
        entry('part', 5000, '2026-09-10', 'Magazine Luiza'),
      ]),
      [['refund', 'order', 'part', 'suggested']],
    )
  })

  it('prefers the merchant over an equal amount, and never confirms on wording alone', () => {
    assert.deepStrictEqual(
      summary([
        entry('pharmacy', -5000, '2026-09-02', 'Drogaria Sao Paulo'),
        entry('order', -25000, '2026-09-01', 'Magazine Luiza'),
        entry('part', 5000, '2026-09-10', 'Estorno Magazine Luiza'),
      ]),
      [['refund', 'order', 'part', 'confirmed']],
    )
    assert.deepStrictEqual(
      summary([
        entry('pharmacy', -5000, '2026-09-02', 'Drogaria Sao Paulo'),
        entry('back', 5000, '2026-09-10', 'Estorno de compra'),
      ]),
      [['refund', 'pharmacy', 'back', 'suggested']],
    )
  })

  it('never takes cashback or a loan for a refund', () => {
    assert.deepStrictEqual(
      summary([
        entry('order', -1000, '2026-09-01', 'Amazon Marketplace'),
        entry('cashback', 1000, '2026-09-10', 'Cashback Amazon Marketplace'),
        entry('debit', -50000, '2026-09-01', 'Loja', 'bank'),
        entry('loan', 50000, '2026-09-05', 'Crédito de empréstimo', 'bank'),
      ]),
      [],
    )
  })

  it('never looks before the purchase, across accounts, past the window, or above its amount', () => {
    assert.deepStrictEqual(
      summary([
        entry('later', -100, '2026-09-10', 'Loja'),
        entry('earlier', 100, '2026-09-01', 'Estorno Loja'),
        entry('other', -200, '2026-09-01', 'Loja', 'bank'),
        entry('other-back', 150, '2026-09-02', 'Estorno Loja'),
        entry('old', -300, '2026-01-01', 'Loja'),
        entry('old-back', 300, '2026-09-01', 'Estorno Loja'),
        entry('small', -400, '2026-09-05', 'Loja'),
        entry('too-big', 500, '2026-09-06', 'Estorno Loja'),
      ]),
      [],
    )
  })

  it('keeps a confirmed refund when a bank debit could pay the same card credit', () => {
    const refund = relationKey('refund', 'order', 'back')
    assert.deepStrictEqual(
      summary(
        [
          entry('order', -25000, '2026-09-01', 'Loja'),
          entry('back', 25000, '2026-09-20', 'Crédito'),
          entry('debit', -25000, '2026-09-20', 'Pagamento fatura', 'bank'),
        ],
        new Map([[refund, 'confirmed']]),
      ),
      [['refund', 'order', 'back', 'confirmed']],
    )
  })

  it('holds several refunds of one purchase up to its amount', () => {
    const entries = [
      entry('order', -25000, '2026-09-01', 'Loja'),
      entry('first', 5000, '2026-09-05', 'Credito'),
      entry('second', 20000, '2026-09-08', 'Credito'),
      entry('third', 100, '2026-09-09', 'Credito'),
    ]
    const decisions = new Map<string, Decision>([
      [relationKey('refund', 'order', 'first'), 'confirmed'],
      [relationKey('refund', 'order', 'second'), 'confirmed'],
      [relationKey('refund', 'order', 'third'), 'confirmed'],
    ])
    assert.deepStrictEqual(summary(entries, decisions), [
      ['refund', 'order', 'first', 'confirmed'],
      ['refund', 'order', 'second', 'confirmed'],
      ['refund', 'order', 'third', 'conflict'],
    ])
  })

  it('drops a rejected refund', () => {
    assert.deepStrictEqual(
      summary(
        [
          entry('order', -25000, '2026-09-01', 'Amazon'),
          entry('back', 25000, '2026-09-20', 'Estorno Amazon'),
        ],
        new Map([[relationKey('refund', 'order', 'back'), 'rejected']]),
      ),
      [],
    )
  })

  it('does not take a shared shop word for the same merchant', () => {
    assert.deepStrictEqual(
      summary([
        entry('pharmacy', -5000, '2026-09-02', 'Loja Drogaria Sao Paulo'),
        entry('back', 5000, '2026-09-10', 'Estorno Loja Magazine Luiza'),
      ]),
      [['refund', 'pharmacy', 'back', 'suggested']],
    )
  })

  it('does not take a kind of business, or a partly shared name, for the same merchant', () => {
    assert.deepStrictEqual(
      summary([
        entry('market', -5000, '2026-09-02', 'Mercado Bom Preco'),
        entry('market-back', 5000, '2026-09-10', 'Estorno Mercado Extra'),
        entry('pharmacy', -7000, '2026-09-02', 'Farmacia Pague Menos'),
        entry('pharmacy-back', 7000, '2026-09-10', 'Estorno Farmacia Sao Joao'),
        entry('order', -9000, '2026-09-02', 'Amazon Prime'),
        entry('order-back', 9000, '2026-09-10', 'Estorno Amazon Marketplace'),
      ]),
      [
        ['refund', 'market', 'market-back', 'suggested'],
        ['refund', 'order', 'order-back', 'suggested'],
        ['refund', 'pharmacy', 'pharmacy-back', 'suggested'],
      ],
    )
  })

  it('does not confirm shops of different kinds, or a short shared name, as one merchant', () => {
    const result = matchRelations(
      [
        entry('pharmacy', -5000, '2026-09-02', 'Farmacia Santa Maria'),
        entry(
          'pharmacy-back',
          5000,
          '2026-09-10',
          'Estorno Restaurante Santa Maria',
        ),
        entry('meal', -7000, '2026-09-02', 'Kfc'),
        entry('meal-back', 7000, '2026-09-10', 'Estorno Kfc'),
        entry('drugstore', -9000, '2026-09-02', 'Drogaria Raia'),
        entry('drugstore-back', 9000, '2026-09-10', 'Estorno Farmacia Raia'),
      ],
      new Map(),
    )
    assert.deepStrictEqual(
      result.relations.map((relation) => [
        relation.outflowId,
        relation.status,
        relation.reasons.includes('different_business'),
      ]),
      [
        ['drugstore', 'confirmed', false],
        ['meal', 'suggested', false],
        ['pharmacy', 'suggested', true],
      ],
    )
  })

  it('never takes a credit the provider calls cashback for a refund', () => {
    assert.deepStrictEqual(
      summary([
        entry('order', -1000, '2026-09-01', 'Amazon Marketplace'),
        entry('credit', 1000, '2026-09-10', 'Amazon Marketplace', 'card', [
          'ESTORNO',
          'CASHBACK',
        ]),
      ]),
      [],
    )
  })

  it('keeps the other refunds of a purchase when one credit disappears', () => {
    const first = relationKey('refund', 'order', 'first')
    const result = matchRelations(
      [
        entry('order', -25000, '2026-09-01', 'Loja'),
        entry('second', 20000, '2026-09-08', 'Credito'),
      ],
      new Map<string, Decision>([
        [first, 'confirmed'],
        [relationKey('refund', 'order', 'second'), 'confirmed'],
      ]),
    )
    assert.deepStrictEqual(
      [
        result.relations.map((relation) => [
          relation.inflowId,
          relation.status,
        ]),
        result.orphaned,
      ],
      [
        [['second', 'confirmed']],
        [
          {
            key: first,
            missing: ['first'],
            reason: 'entry_missing',
            reserved: [],
          },
        ],
      ],
    )
  })

  it('leaves a purchase whole for later refunds when a candidate loses to a payment', () => {
    const relations = summary([
      entry('order', -10000, '2026-09-01', 'Amazon Marketplace'),
      entry('pay', 10000, '2026-09-05', 'Pagamento Amazon Marketplace'),
      entry('debit', -10000, '2026-09-05', 'Pagamento fatura', 'bank'),
      entry('other-debit', -10000, '2026-09-05', 'Pagamento fatura', 'other'),
      entry('back', 5000, '2026-09-10', 'Estorno Amazon Marketplace'),
    ])
    assert.deepStrictEqual(
      relations.filter(([kind]) => kind === 'refund'),
      [['refund', 'order', 'back', 'suggested']],
    )
    assert.deepStrictEqual(
      relations.filter(([kind]) => kind === 'card_payment').length,
      1,
    )
  })

  it('lets a clear refund win over a weak pair suggestion', () => {
    assert.deepStrictEqual(
      summary([
        entry('order', -25000, '2026-09-01', 'Amazon Marketplace'),
        entry('back', 25000, '2026-09-20', 'Estorno Amazon Marketplace'),
        entry('debit', -25000, '2026-09-20', 'Pagamento fatura', 'bank'),
      ]),
      [['refund', 'order', 'back', 'confirmed']],
    )
  })
})
