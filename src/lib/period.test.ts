import { describe, expect, it } from 'vitest'

import {
  daysBetween,
  formatDayLabel,
  formatLongDate,
  formatMonthLong,
  formatMonthShort,
  formatPeriod,
  formatShortDate,
  monthsInPeriod,
  previousPeriod,
  shiftDays,
  todayIso,
  trailingPeriod,
} from './period'

describe('períodos inclusivos', () => {
  it('cria a janela móvel a partir de uma data fixada', () => {
    expect(trailingPeriod(30, 0, '2026-09-04')).toEqual({
      start: '2026-08-06',
      end: '2026-09-04',
    })
    expect(trailingPeriod(14, 14, '2026-09-04')).toEqual({
      start: '2026-08-08',
      end: '2026-08-21',
    })
  })

  it('calcula o período anterior com o mesmo número de dias', () => {
    expect(previousPeriod({ start: '2026-08-06', end: '2026-09-04' })).toEqual({
      start: '2026-07-07',
      end: '2026-08-05',
    })
  })

  it('conta limites por padrão e também mede distância sem os limites', () => {
    expect(daysBetween('2024-02-28', '2024-03-02')).toBe(4)
    expect(
      daysBetween('2024-03-02', '2024-02-28', {
        inclusive: false,
        absolute: true,
      }),
    ).toBe(3)
  })

  it('desloca datas no UTC e permite fixar o relógio', () => {
    expect(shiftDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(todayIso(new Date('2026-09-04T23:59:00Z'))).toBe('2026-09-04')
  })
})

describe('meses e rótulos em pt-BR', () => {
  it('lista todos os meses e marca os meses parciais', () => {
    expect(monthsInPeriod({ start: '2026-12-20', end: '2027-02-28' })).toEqual([
      {
        key: '2026-12',
        label: 'dez',
        fullLabel: 'dezembro de 2026',
        partial: true,
      },
      {
        key: '2027-01',
        label: 'jan',
        fullLabel: 'janeiro de 2027',
        partial: false,
      },
      {
        key: '2027-02',
        label: 'fev',
        fullLabel: 'fevereiro de 2027',
        partial: false,
      },
    ])
  })

  it('formata nomes de mês curtos e longos', () => {
    expect(formatMonthShort('2026-09')).toBe('set')
    expect(formatMonthLong('2027-01')).toBe('janeiro de 2027')
    expect(
      formatMonthLong('2027-01', { includeYear: false, capitalize: true }),
    ).toBe('Janeiro')
  })

  it('preserva os dois rótulos de período usados nas rotas', () => {
    const period = { start: '2026-06-15', end: '2026-08-14' }
    expect(formatPeriod(period)).toBe('15 de jun a 14 de ago de 2026')
    expect(formatPeriod(period, 'month-range')).toBe('jun a ago 2026')
    expect(
      formatPeriod({ start: '2026-12-20', end: '2027-01-10' }, 'month-range'),
    ).toBe('dez 2026 a jan 2027')
    expect(
      formatPeriod({ start: '2026-09-04', end: '2026-09-04' }, 'iso'),
    ).toBe('2026-09-04')
  })

  it('formata dias e datas com resultados fixos', () => {
    expect(formatDayLabel('2026-09-04', '2026-09-04')).toBe('Hoje')
    expect(formatDayLabel('2026-09-03', '2026-09-04')).toBe('Ontem')
    expect(formatDayLabel('2026-09-02', '2026-09-04')).toBe(
      'Quarta-feira, 2 de setembro',
    )
    expect(formatDayLabel('2025-12-31', '2026-09-04')).toBe(
      'Quarta-feira, 31 de dezembro de 2025',
    )
    expect(formatLongDate('2026-09-04')).toBe('4 de set de 2026')
    expect(formatShortDate('2026-09-04')).toBe('04 de set')
  })
})
