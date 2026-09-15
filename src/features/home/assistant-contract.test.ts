import { expect, it } from 'vitest'
import { Output } from 'ai'

import {
  financeAnswerSchema,
  persistedFinanceAnswerSchema,
} from './assistant-contract'

function findOptionalObjectProperties(
  schema: unknown,
  path = '$',
): Array<string> {
  if (!schema || typeof schema !== 'object') return []
  const node = schema as Record<string, unknown>
  const errors: Array<string> = []
  if (
    node.properties &&
    typeof node.properties === 'object' &&
    !Array.isArray(node.properties)
  ) {
    const properties = node.properties as Record<string, unknown>
    const required = new Set(
      Array.isArray(node.required)
        ? node.required.filter((value): value is string =>
            typeof value === 'string',
          )
        : [],
    )
    for (const [key, value] of Object.entries(properties)) {
      if (!required.has(key)) errors.push(`${path}: ${key}`)
      errors.push(...findOptionalObjectProperties(value, `${path}.${key}`))
    }
  }
  if (node.items)
    errors.push(...findOptionalObjectProperties(node.items, `${path}[]`))
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    const branches = node[keyword]
    if (!Array.isArray(branches)) continue
    branches.forEach((branch, index) => {
      errors.push(
        ...findOptionalObjectProperties(branch, `${path}.${keyword}[${index}]`),
      )
    })
  }
  return errors
}

it('generates an Azure-compatible strict response schema', async () => {
  const responseFormat = await Output.object({
    schema: financeAnswerSchema,
  }).responseFormat
  if (!responseFormat || responseFormat.type !== 'json')
    throw new Error('Expected a JSON response format')

  expect(responseFormat.schema).toBeDefined()
  expect(findOptionalObjectProperties(responseFormat.schema)).toEqual([])
})

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
