import { describe, expect, it } from 'vitest'

import { describeRecurrence } from './recurrence'

function occurrence(
  id: string,
  expectedDate: string,
  status: 'expected' | 'matched' | 'skipped' = 'expected',
  matches: Array<{
    occurrenceId: string
    status: string
    score: number
    id: string
  }> = [],
) {
  return { id, expectedDate, status, matches }
}

describe('livro de recorrências', () => {
  it('mantém envelope em andamento fora do atraso', () => {
    const result = describeRecurrence(
      {
        active: true,
        matchMode: 'aggregate',
        frequency: 'monthly',
        scheduleAnchor: '2026-08-01',
        occurrences: [occurrence('open', '2026-08-01')],
      },
      { today: '2026-08-20' },
    )

    expect(result).toMatchObject({ status: 'in_progress', overdue: false })
  })

  it('mantém o período atual em andamento sem ocultar envelope anterior vencido', () => {
    const expired = occurrence('expired', '2026-07-01')
    const current = occurrence('current', '2026-08-01')
    const result = describeRecurrence(
      {
        active: true,
        matchMode: 'aggregate',
        frequency: 'monthly',
        scheduleAnchor: '2026-07-01',
        occurrences: [current, expired],
      },
      { today: '2026-08-20' },
    )

    expect(result.status).toBe('in_progress')
    expect(result.overdue).toBe(true)
    expect(result.overdueOccurrences).toEqual([expired])
  })

  it('marca envelope esperado como atrasado após o fim da janela', () => {
    const result = describeRecurrence(
      {
        active: true,
        matchMode: 'aggregate',
        frequency: 'monthly',
        scheduleAnchor: '2026-07-01',
        occurrences: [occurrence('ended', '2026-07-01')],
      },
      { today: '2026-08-20' },
    )

    expect(result).toMatchObject({ status: 'overdue', overdue: true })
  })

  it('mantém a regra de atraso pela data esperada para pagamento único', () => {
    const result = describeRecurrence(
      {
        active: true,
        matchMode: 'single',
        frequency: 'monthly',
        scheduleAnchor: '2026-08-10',
        occurrences: [occurrence('single', '2026-08-10')],
      },
      { today: '2026-08-20' },
    )

    expect(result).toMatchObject({ status: 'overdue', overdue: true })
  })

  it('escolhe a ocorrência aberta mais nova até hoje', () => {
    const old = occurrence('old', '2026-07-10')
    const current = occurrence('current', '2026-08-10')
    const future = occurrence('future', '2026-09-10')
    const result = describeRecurrence(
      {
        active: true,
        matchMode: 'single',
        frequency: 'monthly',
        scheduleAnchor: '2026-08-10',
        occurrences: [future, old, current],
      },
      { today: '2026-08-20' },
    )
    expect(result.currentOccurrence).toBe(current)
    expect(result.status).toBe('overdue')
    expect(result.overdue).toBe(true)
  })

  it('usa a ocorrência futura mais antiga quando não há aberta vencida', () => {
    const near = occurrence('near', '2026-09-10')
    const far = occurrence('far', '2026-10-10')
    const result = describeRecurrence(
      {
        active: true,
        matchMode: 'single',
        frequency: 'monthly',
        scheduleAnchor: '2026-09-10',
        occurrences: [far, near],
      },
      { today: '2026-08-20' },
    )
    expect(result.currentOccurrence).toBe(near)
    expect(result.status).toBe('pending')
  })

  it('prioriza envelope aberto, sugestão e vínculo realizado na apresentação', () => {
    const open = occurrence('open', '2026-08-10', 'expected', [
      { id: 'low', occurrenceId: 'open', status: 'suggested', score: 75 },
      { id: 'high', occurrenceId: 'open', status: 'suggested', score: 95 },
    ])
    expect(
      describeRecurrence(
        {
          active: true,
          matchMode: 'aggregate',
          frequency: 'monthly',
          scheduleAnchor: '2026-08-10',
          occurrences: [open],
        },
        { today: '2026-08-20' },
      ),
    ).toMatchObject({ status: 'in_progress', bestSuggestion: { id: 'high' } })

    const done = occurrence('done', '2026-07-10', 'matched', [
      { id: 'paid', occurrenceId: 'done', status: 'confirmed', score: 100 },
    ])
    expect(
      describeRecurrence(
        {
          active: true,
          matchMode: 'single',
          frequency: 'monthly',
          scheduleAnchor: '2026-07-10',
          occurrences: [done],
        },
        { today: '2026-08-20' },
      ),
    ).toMatchObject({ status: 'done', acceptedMatches: [{ id: 'paid' }] })
  })

  it('marca a recorrência pausada sem perder seus derivados', () => {
    const open = occurrence('open', '2026-08-10')
    const result = describeRecurrence(
      {
        active: false,
        matchMode: 'single',
        frequency: 'monthly',
        scheduleAnchor: '2026-08-10',
        occurrences: [open],
      },
      { today: '2026-08-20' },
    )
    expect(result.status).toBe('paused')
    expect(result.currentOccurrence).toBe(open)
    expect(result.overdue).toBe(false)
  })
})
