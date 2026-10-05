import { describe, expect, it } from 'vitest'

import { formatInstrumentName, strategyPresets } from './finance'

describe('nomes de contas e cartões', () => {
  it('usa o ponto médio com espaçamento regular antes dos quatro dígitos', () => {
    expect(formatInstrumentName('Inter PF •0532')).toBe('Inter PF · 0532')
    expect(formatInstrumentName('Nu Ultravioleta • 1889')).toBe(
      'Nu Ultravioleta · 1889',
    )
  })
})

describe('estratégias financeiras', () => {
  it('mantém os quatro templates em exatamente 100%', () => {
    expect(Object.keys(strategyPresets)).toHaveLength(4)
    for (const preset of Object.values(strategyPresets)) {
      const total = Object.values(preset.allocation).reduce(
        (sum, value) => sum + value,
        0,
      )
      expect(total).toBe(10_000)
    }
  })
})
