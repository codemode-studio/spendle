import { describe, expect, it } from 'vitest'

import type { RecurrenceBook } from '@spendle/server/api'

import { buildClosingIssuePresentations } from './closing-issues'

const occurrence = (expectedDate: string, overdue: boolean) => ({
  id: expectedDate,
  expectedDate,
  expectedAmountCents: 100,
  currency: 'BRL',
  status: 'expected' as const,
  overdue,
  matches: [],
})

const recurrence = (
  name: string,
  occurrences: RecurrenceBook['recurrences'][number]['occurrences'],
): RecurrenceBook['recurrences'][number] => ({
  id: name,
  name,
  groupId: null,
  participantLabel: null,
  accountId: null,
  categoryId: 'housing',
  amountCents: 100,
  currency: 'BRL',
  direction: 'expense',
  amountMode: 'fixed',
  matchMode: 'single',
  destinationMode: 'automatic',
  frequency: 'monthly',
  startsOn: '2026-06-01',
  scheduleAnchor: '2026-06-01',
  nextDate: '2026-06-01',
  active: true,
  converted: null,
  learnedDescriptions: [],
  occurrences,
})

const book: RecurrenceBook = {
  groups: [],
  recurrences: [
    recurrence(
      'Salário',
      ['2026-06-01', '2026-07-01', '2026-08-01'].map((date) =>
        occurrence(date, true),
      ),
    ),
    recurrence('Colégio', [
      occurrence('2026-09-05', true),
      occurrence('2026-10-05', false),
    ]),
    recurrence('Financiamento do carro', [
      {
        ...occurrence('2026-09-03', false),
        status: 'matched',
        matches: [
          {
            id: 'car',
            occurrenceId: 'Financiamento do carro|2026-09-03',
            entryId: 'car-payment',
            status: 'confirmed',
            score: 100,
            reason: 'vinculado pela pessoa',
            categoryConflict: true,
            entry: {
              id: 'car-payment',
              accountId: 'checking',
              accountName: 'Conta',
              bookedOn: '2026-09-03',
              description: 'Pagamento ALFA',
              amountCents: -100,
              currency: 'BRL',
              categoryId: 'transport',
            },
          },
        ],
      },
    ]),
  ],
}

describe('pendências do fechamento', () => {
  it('explica recorrências vencidas e conflitos, e deixa de fora o que não bloqueia', () => {
    const issues = buildClosingIssuePresentations(
      [
        { code: 'overdue_recurrence', count: 4, blocksClosing: true },
        { code: 'recurrence_category_conflict', count: 1, blocksClosing: true },
        { code: 'missing_balance', count: 1, blocksClosing: false },
      ],
      { month: '2026-09', book },
    )
    expect(issues).toEqual([
      {
        code: 'overdue_recurrence',
        count: 4,
        blocksClosing: true,
        label: 'Ocorrências recorrentes vencidas',
        detail:
          'Salário: 01 de jun, 01 de jul e 01 de ago e Colégio: 05 de set',
        actionLabel: 'Revisar recorrências',
        destination: 'recurrences',
      },
      {
        code: 'recurrence_category_conflict',
        count: 1,
        blocksClosing: true,
        label: 'Categorias divergentes em recorrências',
        detail: 'Financiamento do carro: Pagamento ALFA',
        actionLabel: 'Revisar recorrências',
        destination: 'recurrences',
      },
    ])
  })
})
