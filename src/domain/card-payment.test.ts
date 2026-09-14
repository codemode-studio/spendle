import { describe, expect, it } from 'vitest'
import {
  isCardPaymentDescription,
  isCardPaymentRow,
  isReceivedCardPayment,
} from './card-payment'

describe('isCardPaymentDescription', () => {
  it.each([
    'Pagamento de fatura',
    'PAGAMENTO FATURA CARTAO',
    'PAGTO FATURA',
    'PAGTO CARTAO 1234',
    'PAG FATURA CARTAO 5678',
    'PAGAMENTO CARTAO DE CREDITO',
    'Pagamento Cartão Nubank',
    'DEB AUT CARTAO',
    'DEBITO AUTOMATICO FATURA INTER',
    'Fatura paga',
    'Fatura quitada',
    'Pagamento efetuado fatura Itaú',
  ])('reconhece "%s"', (description) => {
    expect(isCardPaymentDescription(description)).toBe(true)
  })

  it.each([
    'Pagamento plano de saúde',
    'Pagamento recebido',
    'Pagamento em 10 JAN',
    'Compra cartão loja',
    'Mercado Livre',
    'Fatura de energia',
    'Pagamento boleto fatura energia',
  ])('ignora "%s"', (description) => {
    expect(isCardPaymentDescription(description)).toBe(false)
  })
})

describe('isReceivedCardPayment', () => {
  it('só aceita crédito dentro de um cartão', () => {
    expect(
      isReceivedCardPayment({
        creditCardId: 'card',
        amountCents: 1000,
        description: 'Pagamento recebido',
      }),
    ).toBe(true)
    expect(
      isReceivedCardPayment({
        creditCardId: 'card',
        amountCents: 1000,
        description: 'Pagamento em 10 JAN',
      }),
    ).toBe(true)
    expect(
      isReceivedCardPayment({
        creditCardId: null,
        amountCents: 1000,
        description: 'Pagamento recebido',
      }),
    ).toBe(false)
    expect(
      isReceivedCardPayment({
        creditCardId: 'card',
        amountCents: -1000,
        description: 'Pagamento recebido',
      }),
    ).toBe(false)
  })
})

describe('isCardPaymentRow', () => {
  it('cobre categoria liquidada e crédito recebido', () => {
    expect(
      isCardPaymentRow({
        amountCents: -500,
        categoryId: 'card_payment',
        description: 'x',
      }),
    ).toBe(true)
    expect(
      isCardPaymentRow({
        amountCents: -500,
        categoryId: 'transfer',
        description: 'x',
      }),
    ).toBe(true)
    expect(
      isCardPaymentRow({
        amountCents: 500,
        categoryId: null,
        description: 'Pagamento recebido',
      }),
    ).toBe(true)
    expect(
      isCardPaymentRow({
        amountCents: -500,
        categoryId: 'groceries',
        description: 'Mercado',
      }),
    ).toBe(false)
  })
})
