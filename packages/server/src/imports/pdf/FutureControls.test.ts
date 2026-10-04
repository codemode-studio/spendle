import { assert, describe, it } from '@effect/vitest'

import {
  readInterFutureControl,
  readNubankFutureControl,
} from './FutureControls.ts'

describe('readNubankFutureControl', () => {
  const bill = `PRÓXIMAS FATURAS
|Fechamento da próxima fatura|02 OUT 2026|
|Saldo em aberto da próxima fatura|R$ 10,00|
|Saldo em aberto total|R$ 14,00|`
  const plans = [
    {
      installmentAmountCents: 400,
      currentInstallment: 2,
      totalInstallments: 4,
    },
  ]

  it('keeps the documented next bill and the share its plans do not explain', () => {
    const control = readNubankFutureControl(bill, plans)
    assert.deepStrictEqual(
      [
        control?.closingDate,
        control?.nextCents,
        control?.totalCents,
        control?.unexplainedNextCents,
        control?.monthlyCents,
      ],
      ['2026-10-02', 1000, 1400, 600, [1000, 400]],
    )
  })

  it('does not spread the total when the plans do not explain the rest', () => {
    assert.isNull(
      readNubankFutureControl(bill.replace('14,00', '15,00'), plans)
        ?.monthlyCents,
    )
    assert.isNull(readNubankFutureControl(''))
  })
})

describe('readInterFutureControl', () => {
  const bill = `Próxima fatura
Data de corte: 08/09/2026
|Movimentação|Valor|
|Compra (Parcela 02 de 03)|R$ 3.299,98|
|Outra compra (Parcela 02 de 04)|R$ 2.224,87|
|Saldo total de compras parceladas|R$ 5.524,85|
|Saldo demais compras parceladas|R$ 7.749,72|
|Saldo em aberto total|R$ 13.274,57|`

  it('separates the next installments from the rest and checks both totals', () => {
    const control = readInterFutureControl(bill)
    assert.deepStrictEqual(
      [
        control?.closingDate,
        control?.nextCents,
        control?.remainingCents,
        control?.totalCents,
        control?.monthlyCents,
      ],
      ['2026-09-08', 552485, 774972, 1327457, [552485, 552485, 222487]],
    )
  })

  it('refuses a lost row or a diverging total', () => {
    assert.isNull(
      readInterFutureControl(bill.replace('R$ 2.224,87', 'R$ 2.224,88')),
    )
    assert.isNull(
      readInterFutureControl(bill.replace('R$ 13.274,57', 'R$ 13.274,58')),
    )
  })

  it('does not spread future months when the installments do not explain the total', () => {
    assert.isNull(
      readInterFutureControl(bill.replace('02 de 04', '02 de 03'))
        ?.monthlyCents,
    )
  })

  it('recovers a garbled fraction only from a single previous installment', () => {
    const garbled = bill.replace(
      'Compra (Parcela 02 de 03)',
      'Compra (Parcela 02 de x)',
    )
    const previous = {
      description: 'Compra ()',
      installmentAmountCents: 329998,
      currentInstallment: 1,
      totalInstallments: 3,
    }
    assert.deepStrictEqual(
      readInterFutureControl(garbled, [previous])?.monthlyCents,
      [552485, 552485, 222487],
    )
    assert.isNull(
      readInterFutureControl(garbled, [previous, previous])?.monthlyCents,
    )
  })
})
