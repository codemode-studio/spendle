import { describe, expect, it } from 'vitest'

import {
  convertMinorUnitsAtRate,
  formatCurrency,
  formatMinorUnitsForInput,
  toMinorUnits,
} from './currency'

describe('unidades monetárias', () => {
  it('mantém centavos para moedas fiduciárias', () => {
    expect(toMinorUnits('1.234,56', 'BRL')).toBe(123_456)
    expect(toMinorUnits('1234.56', 'USD')).toBe(123_456)
  })

  it('converte BTC em satoshis sem perder a oitava casa decimal', () => {
    expect(toMinorUnits('0,00000001', 'BTC')).toBe(1)
    expect(toMinorUnits('1.23456789', 'BTC')).toBe(123_456_789)
    expect(toMinorUnits('-0.00001000', 'BTC')).toBe(-1_000)
    expect(() => toMinorUnits('0,000000001', 'BTC')).toThrow(
      'no máximo 8 casas decimais',
    )
  })

  it('formata satoshis de modo explícito e reversível para formulários', () => {
    expect(formatCurrency(1, 'BTC')).toBe('BTC\u00a00,00000001')
    expect(formatCurrency(-123_456_789, 'BTC')).toBe('-BTC\u00a01,23456789')
    expect(formatMinorUnitsForInput(100_000_000, 'BTC')).toBe('1,00000000')
  })

  it('converte entre escalas diferentes usando a taxa em unidades principais', () => {
    expect(
      convertMinorUnitsAtRate(100_000_000, 'BTC', 'BRL', 350_000_000_000),
    ).toBe(35_000_000)
    expect(convertMinorUnitsAtRate(1_000, 'USD', 'BRL', 5_500_000)).toBe(5_500)
  })
})
