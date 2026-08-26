import { describe, expect, it } from 'vitest'

import {
  buildCoverageView,
  countCoveredDaysAfter,
  createFilenameCoverageTemplate,
  effectiveCoverageIntervals,
  findCoverageGaps,
  getFreshness,
  inferCoverageFromFilename,
  inferCoverageFromLearnedTemplates,
  mergeCoverageIntervals,
  resolveCompletedBatchStatus,
  summarizeCoveragePeriods,
} from './import-coverage'

describe('cobertura de importações', () => {
  it('lê o período declarado nos nomes de arquivo do Nubank e Inter', () => {
    expect(
      inferCoverageFromFilename('NU_54686607_01MAI2026_31MAI2026.csv'),
    ).toEqual({ start: '2026-05-01', end: '2026-05-31' })
    expect(
      inferCoverageFromFilename('Extrato-27-05-2026-a-24-08-2026-CSV.csv'),
    ).toEqual({ start: '2026-05-27', end: '2026-08-24' })
  })

  it('ignora datas impossíveis sem interromper a importação', () => {
    expect(
      inferCoverageFromFilename('Extrato-01-99-2026-a-31-99-2026.csv'),
    ).toBeNull()
    expect(
      inferCoverageFromLearnedTemplates('EXTRATO-2026-99-01-A-2026-99-31.CSV', [
        'EXTRATO-{start:iso}-A-{end:iso}.CSV',
      ]),
    ).toBeNull()
  })

  it('une sobreposições e não cria lacuna falsa em intervalos aninhados', () => {
    const intervals = [
      { start: '2026-05-01', end: '2026-05-31' },
      { start: '2026-05-10', end: '2026-05-20' },
      { start: '2026-06-01', end: '2026-06-30' },
      { start: '2026-08-01', end: '2026-08-23' },
    ]
    expect(mergeCoverageIntervals(intervals)).toEqual([
      { start: '2026-05-01', end: '2026-06-30' },
      { start: '2026-08-01', end: '2026-08-23' },
    ])
    expect(findCoverageGaps(intervals)).toEqual([
      {
        after: '2026-06-30',
        before: '2026-08-01',
        start: '2026-07-01',
        end: '2026-07-31',
      },
    ])
  })

  it('classifica a atualização em 15 e 30 dias', () => {
    expect(getFreshness('2026-08-10', '2026-08-25').status).toBe('current')
    expect(getFreshness('2026-08-09', '2026-08-25').status).toBe('recommended')
    expect(getFreshness('2026-07-25', '2026-08-25').status).toBe('outdated')
  })

  it('conta somente dias realmente cobertos depois do checkpoint', () => {
    expect(
      countCoveredDaysAfter(
        [
          { start: '2026-05-01', end: '2026-05-10' },
          { start: '2026-06-01', end: '2026-06-05' },
        ],
        '2026-05-05',
      ),
    ).toBe(10)
  })

  it('não usa revisão, falha ou rejeição como cobertura efetiva', () => {
    expect(
      effectiveCoverageIntervals([
        {
          start: '2026-05-01',
          end: '2026-05-31',
          importStatus: 'rejected',
        },
        {
          start: '2026-06-01',
          end: '2026-06-30',
          importStatus: 'committed',
        },
        {
          start: '2026-07-01',
          end: '2026-07-31',
          importStatus: 'evidence',
        },
      ]),
    ).toEqual([
      { start: '2026-06-01', end: '2026-06-30' },
      { start: '2026-07-01', end: '2026-07-31' },
    ])
  })

  it('resume a cobertura confiável e preserva lacunas comprovadas', () => {
    const summary = summarizeCoveragePeriods([
      {
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
        periodSource: 'metadata',
      },
      {
        periodStart: '2026-06-15',
        periodEnd: '2026-06-30',
        periodSource: 'user',
      },
      {
        periodStart: '2026-07-01',
        periodEnd: '2026-07-31',
        periodSource: 'activity',
      },
    ])

    expect(summary).toMatchObject({
      coverageStart: '2026-05-01',
      coverageEnd: '2026-06-30',
      gaps: [
        {
          start: '2026-06-01',
          end: '2026-06-14',
        },
      ],
    })
  })

  it('constrói a visão efetiva com freshness em uma única operação', () => {
    expect(
      buildCoverageView(
        [
          {
            start: '2026-08-01',
            end: '2026-08-20',
            importStatus: 'committed',
          },
          {
            start: '2026-08-21',
            end: '2026-08-25',
            importStatus: 'review',
          },
        ],
        '2026-08-26',
      ),
    ).toEqual({
      intervals: [{ start: '2026-08-01', end: '2026-08-20' }],
      gaps: [],
      latestCoverageEnd: '2026-08-20',
      freshness: { status: 'current', ageDays: 6 },
    })
  })

  it('reutiliza um padrão de nome somente depois da confirmação explícita', () => {
    const template = createFilenameCoverageTemplate(
      'movimentos__01_05_2026__31_05_2026.csv',
      '2026-05-01',
      '2026-05-31',
    )
    expect(template).toBe('MOVIMENTOS__{start:dmy_under}__{end:dmy_under}.CSV')
    expect(
      inferCoverageFromLearnedTemplates(
        'movimentos__01_06_2026__30_06_2026.csv',
        [template!],
      ),
    ).toEqual({ start: '2026-06-01', end: '2026-06-30' })
  })

  it('preserva como concluído um lote parcialmente aceito', () => {
    expect(resolveCompletedBatchStatus(['committed', 'rejected'])).toBe(
      'committed',
    )
    expect(resolveCompletedBatchStatus(['evidence', 'failed'])).toBe(
      'committed',
    )
    expect(resolveCompletedBatchStatus(['rejected'])).toBe('failed')
  })
})
