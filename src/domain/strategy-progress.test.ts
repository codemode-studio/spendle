import { describe, expect, it } from 'vitest'

import { buildStrategyProgress, monthElapsed } from './strategy-progress'

const targets = {
  essential: 3_000_000,
  lifestyle: 1_800_000,
  investment: 900_000,
  reserve: 300_000,
}
const zero = { essential: 0, lifestyle: 0, investment: 0, reserve: 0 }

describe('acompanhamento da estratégia', () => {
  it('calcula a fração do mês decorrida', () => {
    expect(monthElapsed('2026-09', '2026-09-03')).toEqual({
      elapsed: 0.1,
      dayOfMonth: 3,
      total: 30,
    })
    expect(monthElapsed('2026-08', '2026-09-03')).toMatchObject({ elapsed: 1 })
    expect(monthElapsed('2026-10', '2026-09-03')).toMatchObject({ elapsed: 0 })
  })

  it('no início do mês, gasto pequeno está no ritmo e aportes ainda pendentes', () => {
    const progress = buildStrategyProgress({
      month: '2026-09',
      today: '2026-09-03',
      baseIncomeCents: 6_000_000,
      currentIncomeCents: 0,
      targets,
      actual: { ...zero, essential: 38_094 },
      projected: { ...zero, essential: 2_475_346, lifestyle: 50_000 },
    })
    const byBucket = Object.fromEntries(
      progress.buckets.map((item) => [item.bucket, item]),
    )
    expect(byBucket.essential.status).toBe('on_track')
    expect(byBucket.essential.projectedCents).toBe(2_513_440)
    expect(byBucket.investment.status).toBe('on_track')
    expect(progress.overall).toBe('on_track')
  })

  it('sinaliza estouro, ritmo acima do esperado e previsão que passa da meta', () => {
    const progress = buildStrategyProgress({
      month: '2026-08',
      today: '2026-08-16',
      baseIncomeCents: 6_000_000,
      currentIncomeCents: 4_000_000,
      targets,
      actual: { ...zero, essential: 3_068_812, lifestyle: 1_200_000 },
      projected: { ...zero, lifestyle: 700_000 },
    })
    const byBucket = Object.fromEntries(
      progress.buckets.map((item) => [item.bucket, item]),
    )
    expect(byBucket.essential.status).toBe('over')
    expect(byBucket.essential.remainingCents).toBe(-68_812)
    // 1.200.000 de 1.800.000 no dia 16 de 31: acima do ritmo e a previsão passa.
    expect(byBucket.lifestyle.status).toBe('attention')
    expect(progress.overall).toBe('over')
  })

  it('mês encerrado: aporte abaixo da meta fica marcado', () => {
    const progress = buildStrategyProgress({
      month: '2026-08',
      today: '2026-09-03',
      baseIncomeCents: 6_000_000,
      currentIncomeCents: 4_658_649,
      targets,
      actual: { ...zero, investment: 160_000, reserve: 300_000 },
      projected: zero,
    })
    const byBucket = Object.fromEntries(
      progress.buckets.map((item) => [item.bucket, item]),
    )
    expect(progress.monthEnded).toBe(true)
    expect(byBucket.investment.status).toBe('behind')
    expect(byBucket.reserve.status).toBe('done')
  })

  it('meta zerada (reserva redirecionada) conta como cumprida', () => {
    const progress = buildStrategyProgress({
      month: '2026-09',
      today: '2026-09-20',
      baseIncomeCents: 6_000_000,
      currentIncomeCents: 0,
      targets: { ...targets, reserve: 0 },
      actual: zero,
      projected: zero,
    })
    expect(
      progress.buckets.find((item) => item.bucket === 'reserve')?.status,
    ).toBe('done')
  })
})
