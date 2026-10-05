import { assert, describe, it } from '@effect/vitest'

import { modelQuestions } from './ModelReplay.ts'
import type { EvalItem } from './Scoreboard.ts'

const item = (
  id: string,
  description: string,
  expectedCategoryId: string | null,
  amountCents = -1000,
): EvalItem => ({
  id,
  description,
  amountCents,
  expectedCategoryId,
  guessable: true,
})

describe('modelQuestions', () => {
  const context = [
    item('c1', 'Angeloni Super', 'groceries'),
    item('c2', 'Pix enviado Angeloni Transfer', null),
    item('c3', 'Netflix', 'subscriptions'),
  ]
  const exam = [
    item('e1', 'ANGELONI SUPER LOJA 41', 'groceries'),
    item('e2', 'Angeloni Posto', 'transport'),
    item('e3', 'Easy Food', 'delivery'),
  ]

  it('gives exam items examples from the context split only, never from the exam or its transfers', () => {
    const asked = modelQuestions(context, exam, { examples: true })
    assert.deepStrictEqual(
      asked.map((question) => [question.pattern, question.examples]),
      [
        [
          'angeloni super loja 41',
          [{ description: 'Angeloni Super', categoryId: 'groceries' }],
        ],
        [
          'angeloni posto',
          [{ description: 'Angeloni Super', categoryId: 'groceries' }],
        ],
        ['easy food', undefined],
      ],
    )
  })

  it('asks every item bare without examples, for comparison', () => {
    const asked = modelQuestions(context, exam, { examples: false })
    assert.isTrue(asked.every((question) => question.examples === undefined))
    assert.deepStrictEqual(
      asked.map((question) => question.description),
      exam.map((question) => question.description),
    )
  })
})
