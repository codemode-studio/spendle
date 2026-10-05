import { expect, it } from 'vitest'

import { persistedFinanceAnswerSchema } from './assistant-contract'

it('normalizes stored answers created before questionnaire support', () => {
  expect(
    persistedFinanceAnswerSchema.parse({
      summary: 'Resposta antiga.',
      metrics: [],
      comparison: null,
      nextStep: null,
    }),
  ).toEqual({
    summary: 'Resposta antiga.',
    metrics: [],
    comparison: null,
    nextStep: null,
    questionnaire: null,
  })
})
