import { describe, expect, it } from 'vitest'

import {
  calculateConservativeBase,
  formatInstrumentName,
  resolveEffectiveAllocation,
  strategyAllocationSchema,
  strategyPresets,
} from './finance'

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
      expect(strategyAllocationSchema.parse(preset.allocation)).toEqual(
        preset.allocation,
      )
    }
  })

  it('rejeita percentuais fora da faixa ou com soma diferente de 100%', () => {
    expect(() =>
      strategyAllocationSchema.parse({
        essential: 4_000,
        lifestyle: 2_000,
        investment: 3_000,
        reserve: 999,
      }),
    ).toThrow('exatamente 100%')
    expect(() =>
      strategyAllocationSchema.parse({
        essential: 10_001,
        lifestyle: 0,
        investment: 0,
        reserve: -1,
      }),
    ).toThrow()
  })

  it('redireciona a reserva completa para investimentos e permite reativá-la', () => {
    const balanced = strategyPresets.balanced.allocation
    expect(resolveEffectiveAllocation(balanced, true)).toEqual({
      essential: 4_000,
      lifestyle: 2_000,
      investment: 4_000,
      reserve: 0,
    })
    expect(resolveEffectiveAllocation(balanced, true, true)).toEqual(balanced)
  })

  it('usa a meta sem três meses e depois o menor valor entre meta e média', () => {
    expect(calculateConservativeBase(6_000_000, [5_000_000, 4_000_000])).toBe(
      6_000_000,
    )
    expect(
      calculateConservativeBase(6_000_000, [5_000_000, 4_000_000, 3_000_000]),
    ).toBe(4_000_000)
    expect(
      calculateConservativeBase(6_000_000, [7_000_000, 8_000_000, 9_000_000]),
    ).toBe(6_000_000)
  })
})
