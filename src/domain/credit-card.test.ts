import { describe, expect, it } from 'vitest'

import {
  classifyInstallmentCommitment,
  parseInstallmentDescription,
  projectRemainingInstallments,
  resolveCardCycle,
  summarizeCardStatements,
} from './credit-card'

describe('ciclo de cartão', () => {
  it('leva compras posteriores ao fechamento para a próxima fatura', () => {
    expect(resolveCardCycle('2026-08-03', 5, 12)).toMatchObject({
      closingDate: '2026-08-05',
      dueDate: '2026-08-12',
    })
    expect(resolveCardCycle('2026-08-06', 5, 12)).toMatchObject({
      closingDate: '2026-09-05',
      dueDate: '2026-09-12',
    })
  })

  it('trata vencimento anterior ao fechamento como mês seguinte', () => {
    expect(resolveCardCycle('2026-08-10', 25, 3).dueDate).toBe('2026-09-03')
  })

  it('reconhece e projeta parcelas futuras', () => {
    expect(parseInstallmentDescription('LOJA EXEMPLO 02/10')).toEqual({
      currentInstallment: 2,
      totalInstallments: 10,
      cleanDescription: 'LOJA EXEMPLO',
    })
    expect(
      projectRemainingInstallments({
        installmentAmountCents: 10_000,
        currentInstallment: 2,
        totalInstallments: 4,
        firstChargeDate: '2026-08-31',
      }),
    ).toEqual([
      {
        installment: 3,
        totalInstallments: 4,
        amountCents: 10_000,
        postedAt: '2026-09-30',
      },
      {
        installment: 4,
        totalInstallments: 4,
        amountCents: 10_000,
        postedAt: '2026-10-31',
      },
    ])
  })

  it('trata parcelamentos acima de 3x como despesa fixa temporária', () => {
    expect(classifyInstallmentCommitment(3)).toBe('short_installment')
    expect(classifyInstallmentCommitment(4)).toBe('temporary_fixed')
    expect(classifyInstallmentCommitment(12)).toBe('temporary_fixed')
  })

  it('desconta estorno e exclui pagamento de fatura', () => {
    const result = summarizeCardStatements({
      transactions: [
        { amountCents: -50_000, postedAt: '2026-08-03' },
        { amountCents: 10_000, postedAt: '2026-08-04' },
        {
          amountCents: 40_000,
          postedAt: '2026-08-05',
          categoryId: 'card_payment',
        },
        {
          amountCents: 99_999,
          postedAt: '2026-08-05',
          description: 'Pagamento recebido',
        },
      ],
      installmentPlans: [],
      closingDay: 5,
      dueDay: 12,
      referenceDate: '2026-08-03',
    })
    expect(result.current.amountCents).toBe(40_000)
    expect(result.current.transactionCount).toBe(2)
  })
})

it('preserva total e vencimento documentados mesmo com cadastro de ciclo diferente', () => {
  const result = summarizeCardStatements({
    transactions: [{ postedAt: '2026-08-03', amountCents: -10_000 }],
    installmentPlans: [],
    closingDay: 3,
    dueDay: 10,
    referenceDate: '2026-09-05',
    documentedStatements: [
      {
        closingDate: '2026-09-02',
        dueDate: '2026-09-09',
        totalCents: 1_355_218,
      },
    ],
  })
  expect(result.current).toMatchObject({
    dueDate: '2026-09-09',
    amountCents: 1_355_218,
  })
  expect(
    result.statements.filter((s) => s.dueDate.startsWith('2026-09')),
  ).toHaveLength(1)
})

it('não projeta novamente parcelas de faturas antigas da mesma compra', () => {
  const result = summarizeCardStatements({
    transactions: [],
    installmentPlans: [
      {
        description: 'Compra',
        installmentAmountCents: 52000,
        currentInstallment: 4,
        totalInstallments: 10,
        firstChargeDate: '2026-06-02',
      },
      {
        description: 'Compra',
        installmentAmountCents: 52000,
        currentInstallment: 6,
        totalInstallments: 10,
        firstChargeDate: '2026-08-02',
      },
    ],
    closingDay: 2,
    dueDay: 9,
    referenceDate: '2026-09-05',
  })
  expect(result.outstandingCents).toBe(208000)
})
