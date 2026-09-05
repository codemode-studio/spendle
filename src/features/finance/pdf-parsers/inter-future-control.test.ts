import { expect, it } from 'vitest'
import { readInterFutureControl } from './inter-future-control'

const document = `Próxima fatura
Data de corte: 08/09/2026
|Movimentação|Valor|
|Compra (Parcela 02 de 03)|R$ 3.299,98|
|Outra compra (Parcela 02 de 04)|R$ 2.224,87|
|Saldo total de compras parceladas|R$ 5.524,85|
|Saldo demais compras parceladas|R$ 7.749,72|
|Saldo em aberto total|R$ 13.274,57|`
it('separa próxima parcela do compromisso restante e confere os dois controles', () => {
  expect(readInterFutureControl(document)).toEqual({
    closingDate: '2026-09-08',
    nextCents: 552485,
    remainingCents: 774972,
    totalCents: 1327457,
    monthlyCents: [552485, 552485, 222487],
  })
})
it('não aceita linha perdida ou controle divergente', () => {
  expect(
    readInterFutureControl(document.replace('R$ 2.224,87', 'R$ 2.224,88')),
  ).toBeNull()
  expect(
    readInterFutureControl(document.replace('R$ 13.274,57', 'R$ 13.274,58')),
  ).toBeNull()
})

it('não distribui meses futuros quando as parcelas não explicam o total', () => {
  expect(
    readInterFutureControl(document.replace('02 de 04', '02 de 03'))
      ?.monthlyCents,
  ).toBeNull()
})

it('recupera fração sobreposta somente com parcela anterior única e controle total fechado', () => {
  const broken = document.replace(
    'Compra (Parcela 02 de 03)',
    'Compra (Parcela 02 de x)',
  )
  const previous = {
    description: 'Compra ()',
    installmentAmountCents: 329998,
    currentInstallment: 1,
    totalInstallments: 3,
  }
  expect(readInterFutureControl(broken, [previous])?.monthlyCents).toEqual([
    552485, 552485, 222487,
  ])
  expect(
    readInterFutureControl(broken, [previous, previous])?.monthlyCents,
  ).toBeNull()
})
