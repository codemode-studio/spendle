import type { TextItem } from '@firecrawl/pdf-inspector'
import { describe, expect, it } from 'vitest'

import {
  classifyClosingBalanceLabel,
  groupPositionedTextIntoLines,
  parseLocalizedMoney,
  parsePositionedTransactions,
} from './pdf-inspector.server'

function textItem(text: string, page: number, x: number, y: number) {
  return {
    text,
    page,
    x,
    y,
    width: text.length * 5,
    height: 10,
    font: 'Inter',
    fontTag: 'F1',
    fontSize: 10,
    isBold: false,
    isItalic: false,
    isUnderline: false,
    isStrikeout: false,
    itemType: 'Text',
  } as TextItem
}

describe('extração posicional de PDF', () => {
  it('agrupa fragmentos por página e coordenada vertical', () => {
    const lines = groupPositionedTextIntoLines([
      textItem('01/06/2026', 1, 10, 20),
      textItem('Pix recebido', 1, 90, 20.8),
      textItem('1.234,56 C', 1, 250, 20.2),
      textItem('02/06/2026 Compra 50,00 D', 1, 10, 40),
    ])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      text: '01/06/2026 Pix recebido 1.234,56 C',
      bounds: { page: 1 },
    })
  })

  it('preserva sinal e evidência da linha', () => {
    const lines = groupPositionedTextIntoLines([
      textItem('01/06/2026 Pix recebido 1.234,56 C', 2, 10, 20),
      textItem('02/06/2026 Compra mercado 50,00 D', 2, 10, 40),
    ])
    expect(
      parsePositionedTransactions({
        lines,
        targetType: 'account',
        currency: 'BRL',
        periodStart: '2026-06-01',
        periodEnd: '2026-06-30',
      }),
    ).toMatchObject([
      {
        postedAt: '2026-06-01',
        amountCents: 123_456,
        raw: { bounds: { page: 2 } },
      },
      { postedAt: '2026-06-02', amountCents: -5_000 },
    ])
  })

  it('interpreta formatos monetários brasileiros sem ponto flutuante', () => {
    expect(parseLocalizedMoney('R$ 1.234,56 CR')).toEqual({
      cents: 123_456,
      explicit: true,
    })
    expect(parseLocalizedMoney('(89,90)')).toEqual({
      cents: -8_990,
      explicit: true,
    })
  })

  it('interpreta oito casas decimais de BTC como satoshis', () => {
    expect(parseLocalizedMoney('BTC 0,00000001 CR', 'BTC')).toEqual({
      cents: 1,
      explicit: true,
    })
  })

  it('preserva saldo disponível como observação, não como saldo contábil', () => {
    expect(
      classifyClosingBalanceLabel('Saldo disponível R$ 1.234,56', 'account'),
    ).toBe('available')
    expect(
      classifyClosingBalanceLabel('Saldo final R$ 1.234,56', 'account'),
    ).toBe('posted')
  })
})
