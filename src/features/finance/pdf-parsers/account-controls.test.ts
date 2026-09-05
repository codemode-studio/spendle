import { expect, it } from 'vitest'

import { btgAccountV1Parser } from './btg-account-v1.server'
import { interGlobalV1Parser } from './inter-global-v1.server'

function input(text: string) {
  return {
    text,
    currency: 'BRL',
    institution: null,
    kind: 'unknown' as const,
    lines: text
      .split('\n')
      .map((value, i) => ({
        text: value,
        bounds: { page: 1, x: 0, y: 1000 - i, width: 100, height: 1 },
      }))
      .reverse(),
  }
}
const globalText = `Account type: Digital Account
INTER & CO PAYMENTS
Saldo Inicial: $ 0,00
Saldo Final: $ 0,00
Período do extrato: 01/06/2026 a 30/06/2026
2 de junho de 2026 Saldo do dia:$ 0,00
Resgate enviado $ 100,00
1 de junho de 2026 Saldo do dia:$ 100,00
Transferência ACH recebida Cliente $ 100,00`
it('concilia movimentos Global em ordem inversa, sem somar saldos como receita', () => {
  const result = interGlobalV1Parser.parse(input(globalText))
  expect(result.transactions.map((t) => t.amountCents)).toEqual([-10000, 10000])
  expect(result.transactions.every((t) => t.currency === 'USD')).toBe(true)
  expect(() =>
    interGlobalV1Parser.parse(
      input(
        globalText.replace(
          'Resgate enviado $ 100,00',
          'Resgate enviado $ 99,00',
        ),
      ),
    ),
  ).toThrow('Saldo diário Global não fecha')
})
const btgText = `BTG PACTUAL
Conta corrente - Posição
31/08/26 36.600,00
Conta corrente - Movimentação
01/08/26 Saldo Anterior 35.000,00
01/08/26 TRANSFERÊNCIA A CRÉDITO VIA PIX 1.600,00 36.600,00
31/08/26 Saldo Final + Rendimento Provisionado de Saldo Remunerado - 36.600,00`
it('usa coluna movimentação BTG e trata posição/abertura/fechamento como controles', () => {
  const result = btgAccountV1Parser.parse(input(btgText))
  expect(result.transactions.map((t) => t.amountCents)).toEqual([160000])
  expect(result.controls).toMatchObject({
    openingBalanceCents: 3500000,
    closingBalanceCents: 3660000,
  })
  expect(() =>
    btgAccountV1Parser.parse(
      input(btgText.replace('PIX 1.600,00', 'PIX 1.500,00')),
    ),
  ).toThrow('Saldo por movimento BTG não fecha')
})
