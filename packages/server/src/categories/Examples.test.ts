import { assert, describe, it } from '@effect/vitest'

import { exampleContext, examplePicker } from './Examples.ts'
import type { DecidedExample } from './Examples.ts'

let revision = 0
const decided = (
  description: string,
  categoryId: string,
  amountCents = -1000,
): DecidedExample => ({
  description,
  amountCents,
  categoryId,
  revision: ++revision,
})

const expense = (description: string) =>
  ({ description, direction: 'expense' }) as const

describe('examplePicker', () => {
  it('picks decisions sharing a merchant word, rarer words first, and none for an unrelated merchant', () => {
    const pick = examplePicker([
      decided('Pix enviado: "Cp :12345678-Leticia Tavares da Rosa"', 'health'),
      decided('Pix enviado Ivone Martins da Rosa', 'maintenance'),
      decided('Pix enviado Joana Rosa Lima', 'family'),
      decided('Padaria Real', 'groceries'),
    ])
    assert.deepStrictEqual(
      pick(expense('Leticia Tavares da Rosa')).map((e) => e.categoryId),
      // "leticia" and "tavares" belong to one decision; "rosa" to three.
      ['health', 'family', 'maintenance'],
    )
    // Payment wording ("pix enviado", "cp") is not a merchant word.
    assert.deepStrictEqual(pick(expense('Pix enviado Carlos Souza')), [])
  })

  it('keeps the direction, one example per merchant (its latest decision) and the limit', () => {
    const pick = examplePicker(
      [
        decided('Uber Trip', 'transport'),
        decided('Uber Trip', 'business'),
        decided('Uber Eats', 'delivery'),
        decided('Uber Rendimentos', 'salary', 50_000),
        decided('Uber Flash', 'transport'),
      ],
      2,
    )
    const examples = pick(expense('Uber Trip Help'))
    // "trip" is rarer than "uber"; among equals the most recent comes first.
    assert.deepStrictEqual(examples, [
      { description: 'Uber Trip', categoryId: 'business' },
      { description: 'Uber Flash', categoryId: 'transport' },
    ])
    assert.deepStrictEqual(
      pick({ description: 'Uber Bonus', direction: 'income' }),
      [{ description: 'Uber Rendimentos', categoryId: 'salary' }],
    )
  })

  it('gives the same examples after a decision about an unrelated merchant', () => {
    const pool = [
      decided('Angeloni Super', 'groceries'),
      decided('Angeloni Farmacia', 'health'),
    ]
    const before = examplePicker(pool)(expense('Angeloni Loja 41'))
    const after = examplePicker([...pool, decided('Netflix', 'subscriptions')])(
      expense('Angeloni Loja 41'),
    )
    assert.deepStrictEqual(after, before)
    assert.strictEqual(exampleContext(after), exampleContext(before))
    const related = examplePicker([
      ...pool,
      decided('Angeloni Posto', 'transport'),
    ])(expense('Angeloni Loja 41'))
    assert.notStrictEqual(exampleContext(related), exampleContext(before))
  })
})

describe('exampleContext', () => {
  it('is empty without examples, so answers given without them stay valid', () => {
    assert.strictEqual(exampleContext([]), '')
    assert.notStrictEqual(
      exampleContext([{ description: 'Padaria', categoryId: 'groceries' }]),
      exampleContext([{ description: 'Padaria', categoryId: 'dining' }]),
    )
  })
})
