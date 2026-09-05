import { describe, expect, it } from 'vitest'
import { sourceDate } from './source-date'

describe('data do documento', () => {
  it('preserva a data original de uma parcela antiga', () => {
    expect(
      sourceDate(
        JSON.stringify({
          line: '24 de set. 2025 LOJA (Parcela 08 de 12) - R$ 243,29',
        }),
      ),
    ).toBe('2025-09-24')
  })
  it.each([
    null,
    '{',
    '{}',
    '{"line": 42}',
    '{"line":"31 de fev. 2026 LOJA"}',
    '{"line":"20 de xxx. 2026 LOJA"}',
  ])('não inventa datas para evidência inválida: %s', (raw) => {
    expect(sourceDate(raw)).toBeNull()
  })
})
