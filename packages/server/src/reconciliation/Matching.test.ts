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
  currency: 'BRL',
  status: 'posted',
  description: 'Movimento',
  ...fields,
})

const relations = (
  entries: ReadonlyArray<MatchableEntry>,
  decisions = new Map<string, Decision>(),
) => matchRelations(entries, decisions).relations

const summary = (
  entries: ReadonlyArray<MatchableEntry>,
  decisions = new Map<string, Decision>(),
) =>
  relations(entries, decisions).map((relation) => [
    relation.kind,
    relation.outflowId,
    relation.inflowId,
    relation.status,
  ])

describe('matchRelations', () => {
  it('confirms a same-day Pix both sides describe as a transfer', () => {
    assert.deepStrictEqual(
      relations([
        entry('out', 'nubank', -50000, { description: 'Pix enviado Donald' }),
        entry('in', 'inter', 50000, { description: 'Pix recebido Donald' }),
      ]).map((relation) => [relation.kind, relation.status, relation.score]),
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

  it('never confirms a pair the descriptions contradict or do not describe', () => {
    const contradicted = relations([
      entry('pix', 'nubank', -50000, { description: 'Pix enviado Maria' }),
      entry('salary', 'inter', 50000, { description: 'SALARIO EMPRESA' }),
    ])
    const undescribed = relations([
      entry('a', 'nubank', -50000),
      entry('b', 'inter', 50000),
    ])
    assert.deepStrictEqual(
      [...contradicted, ...undescribed].map((relation) => relation.status),
      ['suggested', 'suggested'],
    )
    assert.isTrue(contradicted[0]!.reasons.includes('conflicting_description'))
  })

  it('keeps currencies apart and only suggests pending movements', () => {
    assert.deepStrictEqual(
      summary([
        entry('brl', 'nubank', -50000, { description: 'Pix enviado' }),
        entry('usd', 'inter', 50000, {
          description: 'Pix recebido',
          currency: 'USD',
        }),
      ]),
      [],
    )
    const pending = relations([
      entry('out', 'nubank', -50000, {
        description: 'Pix enviado',
        status: 'pending',
      }),
      entry('in', 'inter', 50000, { description: 'Pix recebido' }),
    ])
    assert.deepStrictEqual(
      [pending[0]?.status, pending[0]?.reasons.includes('pending')],
      ['suggested', true],
    )
  })

  it('only suggests a pair when another account could be the other side', () => {
    const result = relations([
      entry('out', 'nubank', -10000, { description: 'Pix enviado' }),
      entry('in-a', 'inter', 10000, { description: 'Pix recebido' }),
      entry('in-b', 'btg', 10000, { description: 'Pix recebido' }),
    ])
    assert.deepStrictEqual(
      result.map((relation) => [
        relation.status,
        relation.reasons.includes('ambiguous'),
      ]),
      [['suggested', true]],
    )
  })

  it('finds every pair a batch allows instead of the first good-looking one', () => {
    // Greedy would pair 10→10 and strand 7 and 13; two pairs are possible.
    const result = relations([
      entry('out-7', 'nubank', -10000, {
        bookedOn: '2026-09-07',
        description: 'Pix',
      }),
      entry('out-10', 'nubank', -10000, {
        bookedOn: '2026-09-10',
        description: 'Pix',
      }),
      entry('in-10', 'inter', 10000, {
        bookedOn: '2026-09-10',
        description: 'Pix',
      }),
      entry('in-13', 'inter', 10000, {
        bookedOn: '2026-09-13',
        description: 'Pix',
      }),
    ])
    assert.strictEqual(result.length, 2)
  })

  it('gives TED and investment movements a longer window', () => {
    assert.deepStrictEqual(
      summary([
        entry('out', 'nubank', -10000, {
          bookedOn: '2026-09-04',
          description: 'TED enviada',
        }),
        entry('in', 'inter', 10000, {
          bookedOn: '2026-09-08',
          description: 'TED recebida',
        }),
      ]).length,
      1,
    )
  })

  it('never pairs within an account or from a card', () => {
    assert.deepStrictEqual(
      summary([
        entry('a', 'nubank', -100),
        entry('b', 'nubank', 100),
        entry('c', 'card-nu', -200),
        entry('d', 'inter', 200),
      ]),
      [],
    )
  })

  it('never suggests a rejected pair again and does not auto-confirm the next one', () => {
    const entries = [
      entry('out', 'nubank', -10000, { description: 'Pix enviado' }),
      entry('in-a', 'inter', 10000, { description: 'Pix recebido' }),
      entry('in-b', 'btg', 10000, {
        bookedOn: '2026-09-11',
        description: 'Pix recebido',
      }),
    ]
    const rejected = new Map<string, Decision>([
      [relationKey('internal_transfer', 'out', 'in-a'), 'rejected'],
    ])
    assert.deepStrictEqual(summary(entries, rejected), [
      ['internal_transfer', 'out', 'in-b', 'suggested'],
    ])
  })

  it('keeps a confirmed pair, and flags it when the facts no longer add up', () => {
    const key = relationKey('internal_transfer', 'out', 'in')
    const confirmed = new Map<string, Decision>([[key, 'confirmed']])
    const far = relations(
      [
        entry('out', 'nubank', -10000, { bookedOn: '2026-09-01' }),
        entry('in', 'inter', 10000, { bookedOn: '2026-09-20' }),
      ],
      confirmed,
    )
    const corrected = relations(
      [entry('out', 'nubank', -12000), entry('in', 'inter', 10000)],
      confirmed,
    )
    assert.deepStrictEqual(
      [...far, ...corrected].map((relation) => [
        relation.status,
        relation.origin,
      ]),
      [
        ['confirmed', 'person'],
        ['conflict', 'person'],
      ],
    )
  })

  it('reports a confirmation whose entry vanished and keeps its partner reserved', () => {
    const key = relationKey('internal_transfer', 'gone', 'in')
    const result = matchRelations(
      [
        entry('in', 'inter', 10000, { description: 'Pix recebido' }),
        entry('other', 'nubank', -10000, { description: 'Pix enviado' }),
      ],
      new Map([[key, 'confirmed']]),
    )
    assert.deepStrictEqual(
      [result.relations, result.orphaned],
      [[], [{ key, missing: ['gone'] }]],
    )
  })

  it('pairs each entry at most once', () => {
    const result = relations([
      entry('out-1', 'nubank', -10000),
      entry('out-2', 'nubank', -10000),
      entry('in-1', 'inter', 10000),
      entry('in-2', 'inter', 10000),
    ])
    const legs = result.flatMap((relation) => [
      relation.outflowId,
      relation.inflowId,
    ])
    assert.deepStrictEqual([result.length, new Set(legs).size], [2, 4])
  })
})
