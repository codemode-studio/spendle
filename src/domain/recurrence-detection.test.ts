import { describe, expect, it } from 'vitest'

import {
  detectRecurrences,
  detectionKey,
  displayNameFromDescriptions,
} from './recurrence-detection'
import type { DetectionTransaction } from './recurrence-detection'

const today = '2026-09-03'

function tx(
  overrides: Partial<DetectionTransaction> & {
    id: string
    postedAt: string
    amountCents: number
  },
): DetectionTransaction {
  return {
    currency: 'BRL',
    description: 'Pix Janete Meili',
    status: 'confirmed',
    accountId: 'account-pj',
    creditCardId: null,
    categoryId: null,
    counterpartyAccountId: null,
    reconciliationTypes: null,
    ...overrides,
  }
}

const cuidadora = [
  tx({
    id: 'c1',
    postedAt: '2026-06-04',
    amountCents: -215_000,
    categoryId: 'family',
  }),
  tx({
    id: 'c2',
    postedAt: '2026-07-06',
    amountCents: -215_000,
    categoryId: 'family',
  }),
  tx({ id: 'c3', postedAt: '2026-08-04', amountCents: -215_000 }),
]

describe('detecção de recorrências', () => {
  it('detecta um pagamento mensal fixo e projeta a próxima data', () => {
    const [detected] = detectRecurrences({ transactions: cuidadora, today })
    expect(detected).toMatchObject({
      name: 'Pix Janete Meili',
      direction: 'expense',
      frequency: 'monthly',
      amountMode: 'fixed',
      typicalAmountCents: 215_000,
      accountId: 'account-pj',
      categoryId: 'family',
      nextExpectedDate: '2026-09-04',
    })
    expect(detected.confidence).toBeGreaterThanOrEqual(65)
    expect(detected.transactions.map((item) => item.id)).toEqual([
      'c1',
      'c2',
      'c3',
    ])
  })

  it('classifica valores que oscilam como variáveis e descarta oscilação grande', () => {
    const variable = detectRecurrences({
      today,
      transactions: [
        tx({
          id: 'l1',
          postedAt: '2026-06-10',
          amountCents: -90_855,
          description: 'Celesc',
        }),
        tx({
          id: 'l2',
          postedAt: '2026-07-10',
          amountCents: -102_000,
          description: 'Celesc',
        }),
        tx({
          id: 'l3',
          postedAt: '2026-08-10',
          amountCents: -84_000,
          description: 'Celesc',
        }),
      ],
    })
    expect(variable[0]?.amountMode).toBe('variable')

    const erratic = detectRecurrences({
      today,
      transactions: [
        tx({
          id: 'e1',
          postedAt: '2026-06-10',
          amountCents: -10_000,
          description: 'Loja',
        }),
        tx({
          id: 'e2',
          postedAt: '2026-07-10',
          amountCents: -40_000,
          description: 'Loja',
        }),
      ],
    })
    expect(erratic).toHaveLength(0)
  })

  it('ignora pagamentos sem cadência, como pedágios de viagem', () => {
    const detected = detectRecurrences({
      today,
      transactions: [
        tx({
          id: 't1',
          postedAt: '2026-07-23',
          amountCents: -570,
          description: 'BR-376 Garuva',
        }),
        tx({
          id: 't2',
          postedAt: '2026-07-24',
          amountCents: -570,
          description: 'BR-376 Garuva',
        }),
        tx({
          id: 't3',
          postedAt: '2026-08-24',
          amountCents: -570,
          description: 'BR-376 Garuva',
        }),
      ],
    })
    expect(detected).toHaveLength(0)
  })

  it('ignora pares tarifa e cashback do banco', () => {
    const detected = detectRecurrences({
      today,
      transactions: [
        tx({
          id: 'f1',
          postedAt: '2026-07-08',
          amountCents: -1_700,
          description: 'Inter Pre 4gb',
        }),
        tx({
          id: 'f2',
          postedAt: '2026-07-08',
          amountCents: 170,
          description: 'Inter Pre 4gb',
        }),
        tx({
          id: 'f3',
          postedAt: '2026-08-08',
          amountCents: -1_700,
          description: 'Inter Pre 4gb',
        }),
        tx({
          id: 'f4',
          postedAt: '2026-08-08',
          amountCents: 170,
          description: 'Inter Pre 4gb',
        }),
      ],
    })
    expect(detected).toHaveLength(0)
  })

  it('não sugere o que já é recorrência, foi ignorado ou é transferência', () => {
    const base = { transactions: cuidadora, today }
    expect(
      detectRecurrences({
        ...base,
        knownSignatures: new Set(['janete meili']),
      }),
    ).toHaveLength(0)
    expect(
      detectRecurrences({
        ...base,
        ignoredKeys: new Set([detectionKey('janete meili', 'expense')]),
      }),
    ).toHaveLength(0)
    expect(
      detectRecurrences({
        ...base,
        excludedTransactionIds: new Set(['c1', 'c2']),
      }),
    ).toHaveLength(0)
    expect(
      detectRecurrences({
        today,
        transactions: cuidadora.map((item) => ({
          ...item,
          counterpartyAccountId: 'account-pf',
        })),
      }),
    ).toHaveLength(0)
  })

  it('descarta recorrências que pararam de acontecer', () => {
    const detected = detectRecurrences({
      transactions: cuidadora,
      today: '2026-12-15',
    })
    expect(detected).toHaveLength(0)
  })

  it('formata o nome a partir da descrição mais comum', () => {
    expect(
      displayNameFromDescriptions([
        'POSITIVO EDUCACIONAL LTDA.',
        'POSITIVO EDUCACIONAL LTDA.',
        'Positivo E Ltda',
      ]),
    ).toBe('Positivo Educacional Ltda.')
    expect(
      displayNameFromDescriptions(['16/08/2026 17:58*continente Shopping']),
    ).toBe('continente Shopping')
  })
})
