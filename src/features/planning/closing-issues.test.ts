import { describe, expect, it } from 'vitest'

import type { PlanningSnapshot } from '#/features/finance/snapshot.types'
import { buildClosingIssuePresentations } from './closing-issues'

function planningSnapshot(): PlanningSnapshot {
  return {
    dashboard: {
      currentMonth: '2026-09',
      integrity: {
        partial: true,
        totalCount: 5,
        closingBlockerCount: 5,
        issues: [
          { code: 'overdue_recurrence', count: 4, blocksClosing: true },
          {
            code: 'recurrence_category_conflict',
            count: 1,
            blocksClosing: true,
          },
        ],
      },
    },
    recurrences: [
      {
        id: 'salary',
        name: 'Salário',
        participantLabel: null,
        active: true,
        matchMode: 'single',
        frequency: 'monthly',
        scheduleAnchor: '2026-06-01',
        occurrences: ['2026-06-01', '2026-07-01', '2026-08-01'].map(
          (expectedDate) => ({
            id: `salary-${expectedDate}`,
            expectedDate,
            status: 'expected',
            matches: [],
          }),
        ),
      },
      {
        id: 'school',
        name: 'Colégio',
        participantLabel: null,
        active: true,
        matchMode: 'single',
        frequency: 'monthly',
        scheduleAnchor: '2026-09-05',
        occurrences: [
          {
            id: 'school-september',
            expectedDate: '2026-09-05',
            status: 'expected',
            matches: [],
          },
        ],
      },
      {
        id: 'car',
        name: 'Financiamento do carro',
        participantLabel: null,
        active: true,
        matchMode: 'single',
        frequency: 'monthly',
        scheduleAnchor: '2026-09-03',
        occurrences: [
          {
            id: 'car-september',
            expectedDate: '2026-09-03',
            status: 'matched',
            matches: [
              {
                id: 'car-match',
                occurrenceId: 'car-september',
                transactionId: 'car-payment',
                status: 'confirmed',
                score: 100,
                categoryConflict: true,
                transaction: {
                  id: 'car-payment',
                  description: 'Pagamento ALFA',
                  postedAt: '2026-09-03',
                },
              },
            ],
          },
        ],
      },
    ],
  } as PlanningSnapshot
}

describe('pendências do fechamento', () => {
  it('explica recorrências vencidas e conflitos em vez de chamá-los de conciliações', () => {
    const issues = buildClosingIssuePresentations(planningSnapshot(), {
      today: '2026-09-09',
    })

    expect(issues).toEqual([
      {
        code: 'overdue_recurrence',
        count: 4,
        label: 'Ocorrências recorrentes vencidas',
        detail:
          'Salário: 01 de jun, 01 de jul e 01 de ago e Colégio: 05 de set',
        actionLabel: 'Revisar recorrências',
        destination: 'recurrences',
      },
      {
        code: 'recurrence_category_conflict',
        count: 1,
        label: 'Categorias divergentes em recorrências',
        detail: 'Financiamento do carro: Pagamento ALFA',
        actionLabel: 'Revisar recorrências',
        destination: 'recurrences',
      },
    ])
  })
})
