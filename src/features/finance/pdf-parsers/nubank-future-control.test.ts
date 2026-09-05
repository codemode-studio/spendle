import { expect, it } from 'vitest'
import { readNubankFutureControl } from './nubank-future-control'

const doc = `PRÓXIMAS FATURAS
|Fechamento da próxima fatura|02 OUT 2026|
|Saldo em aberto da próxima fatura|R$ 10,00|
|Saldo em aberto total|R$ 14,00|`
const plans = [
  { installmentAmountCents: 400, currentInstallment: 2, totalInstallments: 4 },
]
it('usa o saldo documentado seguinte e preserva a parcela sem composição identificada', () => {
  expect(readNubankFutureControl(doc, plans)).toMatchObject({
    nextCents: 1000,
    totalCents: 1400,
    unexplainedNextCents: 600,
    monthlyCents: [1000, 400],
  })
})
it('não distribui todo o saldo quando as parcelas não explicam o restante', () => {
  expect(
    readNubankFutureControl(doc.replace('14,00', '15,00'), plans)?.monthlyCents,
  ).toBeNull()
  expect(readNubankFutureControl('')).toBeNull()
})
