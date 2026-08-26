import { describe, expect, it } from 'vitest'

import {
  filterConfidentAiSuggestions,
  parseAiCategoryOutput,
  parseAiReconciliationOutput,
} from './ai.server'

describe('saída da categorização por IA', () => {
  it('aceita somente transações e categorias conhecidas', () => {
    const result = parseAiCategoryOutput(
      {
        suggestions: [
          { transactionId: 'tx-1', categoryId: 'food', confidence: 91 },
          { transactionId: 'tx-2', categoryId: 'invented', confidence: 80 },
          { transactionId: 'unknown', categoryId: 'food', confidence: 70 },
        ],
      },
      new Set(['tx-1', 'tx-2']),
      new Set(['food']),
    )

    expect(result).toEqual([
      { transactionId: 'tx-1', categoryId: 'food', confidence: 91 },
    ])
  })

  it('rejeita confiança fora da faixa permitida', () => {
    expect(() =>
      parseAiCategoryOutput(
        {
          suggestions: [
            { transactionId: 'tx-1', categoryId: 'food', confidence: 101 },
          ],
        },
        new Set(['tx-1']),
        new Set(['food']),
      ),
    ).toThrow()
  })

  it('mantém somente sugestões com confiança suficiente', () => {
    expect(
      filterConfidentAiSuggestions([
        { transactionId: 'tx-1', categoryId: 'food', confidence: 69 },
        { transactionId: 'tx-2', categoryId: 'food', confidence: 70 },
      ]),
    ).toEqual([{ transactionId: 'tx-2', categoryId: 'food', confidence: 70 }])
  })
})

describe('saída da validação de reconciliação por IA', () => {
  it('aceita somente candidatos determinísticos conhecidos e sem repetição', () => {
    expect(
      parseAiReconciliationOutput(
        {
          validations: [
            {
              candidateId: 'pair-1',
              verdict: 'confirmed',
              confidence: 93,
              reason: 'Mesmo valor, data e contexto de transferência.',
            },
            {
              candidateId: 'pair-1',
              verdict: 'rejected',
              confidence: 99,
              reason: 'Resposta repetida.',
            },
            {
              candidateId: 'invented-pair',
              verdict: 'confirmed',
              confidence: 100,
              reason: 'Par não fornecido.',
            },
          ],
        },
        new Set(['pair-1']),
      ),
    ).toEqual([
      {
        candidateId: 'pair-1',
        verdict: 'confirmed',
        confidence: 93,
        reason: 'Mesmo valor, data e contexto de transferência.',
      },
    ])
  })

  it('rejeita veredito ou confiança fora do contrato', () => {
    expect(() =>
      parseAiReconciliationOutput(
        {
          validations: [
            {
              candidateId: 'pair-1',
              verdict: 'approved',
              confidence: 101,
              reason: 'Inválido.',
            },
          ],
        },
        new Set(['pair-1']),
      ),
    ).toThrow()
  })
})
