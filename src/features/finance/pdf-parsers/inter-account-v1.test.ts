import { describe, expect, it } from 'vitest'
import { interAccountV1Parser } from './inter-account-v1.server'

function fixture(lastBalance = '130,00') {
  const text = `Instituição: Banco Inter
Período: 01/06/2026 a 30/06/2026
Saldo total Saldo disponível: Saldo bloqueado:
R$ 130,00 R$ 130,00 R$ 0,00
1 de Junho de 2026 Saldo do dia: R$ 150,00 Valor Saldo por transação
Pix recebido: EMPRESA R$ 50,00 R$ 150,00
2 de Junho de 2026 Saldo do dia: R$ 130,00
Pix enviado: LOJA -R$ 20,00 R$ ${lastBalance}`
  return {
    text,
    currency: 'BRL',
    institution: 'Inter',
    kind: 'bank_statement' as const,
    lines: text
      .split('\n')
      .map((lineText, i) => ({
        text: lineText,
        bounds: { page: 1, x: 0, y: 100 - i, width: 100, height: 1 },
      }))
      .reverse(),
  }
}
describe('extrato Inter com saldo por transação', () => {
  it('preserva sinais e infere abertura pelo primeiro saldo após movimento', () => {
    const result = interAccountV1Parser.parse(fixture())
    expect(result.transactions.map((t) => t.amountCents)).toEqual([5000, -2000])
    expect(result.controls).toMatchObject({
      openingBalanceCents: 10000,
      closingBalanceCents: 13000,
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
    })
  })
  it('bloqueia perda de movimento detectada pelo saldo intermediário', () => {
    expect(() => interAccountV1Parser.parse(fixture('131,00'))).toThrow(
      'Saldo por transação Inter não fecha',
    )
  })
  it('bloqueia saldo final divergente mesmo com movimentos coerentes', () => {
    const input = fixture()
    input.lines = input.lines.filter((l) => !l.text.startsWith('Pix enviado'))
    expect(() => interAccountV1Parser.parse(input)).toThrow(
      'Saldo total Inter não confere',
    )
  })
})
