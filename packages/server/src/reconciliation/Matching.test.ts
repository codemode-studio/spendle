import { assert, describe, it } from '@effect/vitest'

import { matchRelations, relationKey } from './Matching.ts'
import type { Decision, MatchableEntry } from './Matching.ts'

const entry = (
  id: string,
  accountId: string,
  amountCents: number,
  fields: Partial<MatchableEntry> = {},
): MatchableEntry => ({
  id,
  accountId,
  accountKind: accountId.startsWith('card') ? 'credit_card' : 'checking',
  bookedOn: '2026-09-10',
  amountCents,
  description: 'Movimento',
  ...fields,
})

const summary = (
  entries: ReadonlyArray<MatchableEntry>,
  decisions = new Map<string, Decision>(),
) =>
  matchRelations(entries, decisions).map((relation) => [
    relation.kind,
    relation.outflowId,
    relation.inflowId,
    relation.status,
  ])

describe('matchRelations', () => {
  it('confirms a same-day Pix between two own accounts', () => {
    const relations = matchRelations(
      [
        entry('out', 'nubank', -50000, { description: 'Pix enviado Donald' }),
        entry('in', 'inter', 50000, { description: 'Pix recebido Donald' }),
      ],
      new Map(),
    )
    assert.deepStrictEqual(
      relations.map((relation) => [
        relation.kind,
        relation.status,
        relation.score,
      ]),
      [['internal_transfer', 'confirmed', 100]],
    )
  })

  it('confirms a card payment that lands on the card a few days later', () => {
    assert.deepStrictEqual(
      summary([
        entry('pay', 'nubank', -150000, {
          description: 'PAGAMENTO FATURA NUBANK',
        }),
        entry('credit', 'card-nu', 150000, {
          bookedOn: '2026-09-13',
          description: 'Pagamento recebido',
        }),
      ]),
      [['card_payment', 'pay', 'credit', 'confirmed']],
    )
  })

  it('only suggests a pair when another account could be the other side', () => {
    const relations = matchRelations(
      [
        entry('out', 'nubank', -10000),
        entry('in-a', 'inter', 10000),
        entry('in-b', 'btg', 10000),
      ],
      new Map(),
    )
    assert.deepStrictEqual(
      relations.map((relation) => [
        relation.status,
        relation.reasons.includes('ambiguous'),
      ]),
      [['suggested', true]],
    )
  })

  it('never pairs within an account, from a card, or beyond the window', () => {
    assert.deepStrictEqual(
      summary([
        entry('a', 'nubank', -100),
        entry('b', 'nubank', 100),
        entry('c', 'card-nu', -200),
        entry('d', 'inter', 200),
        entry('e', 'nubank', -300, { bookedOn: '2026-09-01' }),
        entry('f', 'inter', 300, { bookedOn: '2026-09-05' }),
      ]),
      [],
    )
  })

  it('never suggests a rejected pair again and offers the next candidate', () => {
    const entries = [
      entry('out', 'nubank', -10000, { description: 'Pix' }),
      entry('in-a', 'inter', 10000, { description: 'Pix' }),
      entry('in-b', 'btg', 10000, { bookedOn: '2026-09-11' }),
    ]
    const rejected = new Map<string, Decision>([
      [relationKey('internal_transfer', 'out', 'in-a'), 'rejected'],
    ])
    assert.deepStrictEqual(summary(entries, rejected), [
      ['internal_transfer', 'out', 'in-b', 'suggested'],
    ])
  })

  it('keeps a pair the person confirmed even when it would not score', () => {
    const entries = [
      entry('out', 'nubank', -10000, { bookedOn: '2026-09-01' }),
      entry('in', 'inter', 10000, { bookedOn: '2026-09-20' }),
      entry('in-near', 'btg', 10000, { bookedOn: '2026-09-01' }),
    ]
    const confirmed = new Map<string, Decision>([
      [relationKey('internal_transfer', 'out', 'in'), 'confirmed'],
    ])
    const relations = matchRelations(entries, confirmed)
    assert.deepStrictEqual(
      relations.map((relation) => [
        relation.inflowId,
        relation.status,
        relation.origin,
      ]),
      [['in', 'confirmed', 'person']],
    )
  })

  it('pairs each entry at most once', () => {
    const relations = matchRelations(
      [
        entry('out-1', 'nubank', -10000),
        entry('out-2', 'nubank', -10000),
        entry('in-1', 'inter', 10000),
        entry('in-2', 'inter', 10000),
      ],
      new Map(),
    )
    const legs = relations.flatMap((relation) => [
      relation.outflowId,
      relation.inflowId,
    ])
    assert.deepStrictEqual([relations.length, new Set(legs).size], [2, 4])
  })
})
