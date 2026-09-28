import { expect, it, vi } from 'vitest'
import { chat } from '@tanstack/ai'
import { createOpenRouterText } from '@tanstack/ai-openrouter'

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

it('sends a strict JSON schema to OpenRouter', async () => {
  const requests: Request[] = []
  vi.stubGlobal('fetch', (request: Request) => {
    requests.push(request)
    return new Promise<Response>((_, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason))
    })
  })
  const abortController = new AbortController()
  const pending = chat({
    adapter: createOpenRouterText('~openai/gpt-mini-latest', 'test-key'),
    messages: [{ role: 'user', content: 'Responda.' }],
    outputSchema: financeAnswerSchema,
    abortController,
  })
  await vi.waitFor(() => expect(requests).toHaveLength(1))
  const request = await requests[0].clone().json()
  const responseFormat = request.response_format
  expect(responseFormat.type).toBe('json_schema')

  expect(responseFormat.json_schema.strict).toBe(true)
  expect(findOptionalObjectProperties(responseFormat.json_schema.schema)).toEqual([])
  abortController.abort()
  await pending.catch(() => undefined)
  vi.unstubAllGlobals()
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
