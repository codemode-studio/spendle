import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { categorizeTransactionsWithAi } from './ai.server'
import {
  NO_CATEGORY_OPTION,
  categoryCriteria,
  suggestionFromJevAnswers,
} from './typesafe.server'

const mocks = vi.hoisted(() => ({ evaluate: vi.fn() }))
vi.mock('ai', () => ({
  experimental_evaluate: mocks.evaluate,
  generateText: vi.fn(),
  Output: { object: vi.fn() },
}))
const evaluate = mocks.evaluate

const categories = [
  { id: 'food', name: 'Alimentação', bucket: 'essential' },
  { id: 'leisure', name: 'Lazer', bucket: 'lifestyle' },
]
const categoryIds = new Set(categories.map((category) => category.id))
const transaction = (id: string, description: string) => ({
  id,
  description,
  amountCents: -5000,
  currency: 'BRL',
  targetType: 'card' as const,
})

describe('respostas do Jev para categoria', () => {
  it('usa a probabilidade da opção escolhida como confiança', () => {
    expect(
      suggestionFromJevAnswers(
        'tx-1',
        {
          category: {
            choice: 'food',
            probabilities: { food: 0.874, leisure: 0.1 },
          },
          movement: { probability: 0.02 },
        },
        categoryIds,
      ),
    ).toEqual({ transactionId: 'tx-1', categoryId: 'food', confidence: 87 })
  })

  it('não sugere quando o modelo escolhe a opção de escape', () => {
    expect(
      suggestionFromJevAnswers(
        'tx-1',
        {
          category: {
            choice: NO_CATEGORY_OPTION,
            probabilities: { [NO_CATEGORY_OPTION]: 0.9 },
          },
          movement: { probability: 0.1 },
        },
        categoryIds,
      ),
    ).toBeNull()
  })

  it('não sugere para movimentações, categorias desconhecidas ou sem probabilidade', () => {
    const category = { choice: 'food', probabilities: { food: 0.99 } }
    expect(
      suggestionFromJevAnswers(
        'tx-1',
        { category, movement: { probability: 0.5 } },
        categoryIds,
      ),
    ).toBeNull()
    expect(
      suggestionFromJevAnswers(
        'tx-1',
        {
          category: { choice: 'invented', probabilities: { invented: 1 } },
          movement: { probability: 0 },
        },
        categoryIds,
      ),
    ).toBeNull()
    expect(
      suggestionFromJevAnswers(
        'tx-1',
        { category: { choice: 'food' }, movement: { probability: 0 } },
        categoryIds,
      ),
    ).toBeNull()
  })

  it('oferece cada categoria e a opção de escape como critérios', () => {
    expect(Object.keys(categoryCriteria(categories))).toEqual([
      'food',
      'leisure',
      NO_CATEGORY_OPTION,
    ])
  })
})

describe('categorização roteada para o Jev', () => {
  beforeEach(() => {
    evaluate.mockReset()
    vi.stubEnv('AI_GATEWAY_API_KEY', 'synthetic-test-key')
    vi.stubEnv('AI_CATEGORY_PROVIDER', 'jev')
    vi.stubEnv('OPENROUTER_API_KEY', '')
    vi.stubEnv('OPENROUTER_MODEL', '')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('pergunta por lançamento, isolando cada descrição no estado', async () => {
    evaluate.mockImplementation(
      ({ state }: { state: { lancamento: { descricao: string } } }) =>
        Promise.resolve({
          answers: state.lancamento.descricao.includes('PIZZARIA')
            ? {
                category: { choice: 'food', probabilities: { food: 0.93 } },
                movement: { probability: 0.01 },
              }
            : {
                category: {
                  choice: 'leisure',
                  probabilities: { leisure: 0.6 },
                },
                movement: { probability: 0.97 },
              },
        }),
    )

    const suggestions = await categorizeTransactionsWithAi(
      [transaction('tx-1', 'IFD*PIZZARIA'), transaction('tx-2', 'PIX PROPRIO')],
      categories,
    )

    expect(suggestions).toEqual([
      { transactionId: 'tx-1', categoryId: 'food', confidence: 93 },
    ])
    expect(evaluate).toHaveBeenCalledTimes(2)
    const call = evaluate.mock.calls[0][0]
    expect(call.model).toBe('typesafe-ai/jev')
    expect(JSON.stringify(call.state)).not.toContain('PIX PROPRIO')
  })

  it('mantém o provedor generativo quando o Jev não foi pedido', async () => {
    vi.stubEnv('AI_CATEGORY_PROVIDER', '')
    await expect(
      categorizeTransactionsWithAi([transaction('tx-1', 'LOJA')], categories),
    ).resolves.toEqual([])
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('propaga falhas do provedor para quem chamou', async () => {
    evaluate.mockRejectedValue(new Error('Authentication failed'))
    await expect(
      categorizeTransactionsWithAi([transaction('tx-1', 'LOJA')], categories),
    ).rejects.toThrow('Authentication failed')
  })
})
