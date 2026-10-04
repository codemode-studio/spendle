import { assert, describe, it } from '@effect/vitest'

import { positionedText } from '../../testing/SyntheticPdf.ts'
import {
  addMonths,
  cents,
  groupLines,
  nextDay,
  signedAmount,
} from './Layout.ts'

describe('groupLines', () => {
  it('joins fragments on the same page and baseline, left to right', () => {
    const lines = groupLines([
      positionedText('01/06/2026', 1, 10, 20),
      positionedText('1.234,56 C', 1, 250, 20.2),
      positionedText('Pix recebido', 1, 90, 20.8),
      positionedText('02/06/2026 Compra 50,00 D', 1, 10, 40),
      positionedText('02/06/2026 Compra 50,00 D', 2, 10, 40),
    ])
    assert.deepStrictEqual(
      lines.map((line) => [line.text, line.bounds.page]),
      [
        ['01/06/2026 Pix recebido 1.234,56 C', 1],
        ['02/06/2026 Compra 50,00 D', 1],
        ['02/06/2026 Compra 50,00 D', 2],
      ],
    )
  })
})

describe('calendar arithmetic', () => {
  it('shifts months clamping to the last day and crosses years', () => {
    assert.deepStrictEqual(
      [
        addMonths('2026-01-31', 1),
        addMonths('2024-01-31', 1),
        addMonths('2026-01-15', -1),
        addMonths('2026-11-08', 2),
      ],
      ['2026-02-28', '2024-02-29', '2025-12-15', '2027-01-08'],
    )
    assert.deepStrictEqual(
      [nextDay('2026-02-28'), nextDay('2026-12-31'), nextDay('2026-04-08')],
      ['2026-03-01', '2027-01-01', '2026-04-09'],
    )
  })
})

describe('signedAmount', () => {
  // A row whose description is followed by its amount, as layouts read it.
  const row = (currency: 'optional' | 'required') => {
    const pattern = new RegExp(`^(.*?)\\s+(${signedAmount({ currency })})$`)
    return (text: string) => {
      const match = text.match(pattern)
      return match ? [match[1], cents(match[2]!)] : null
    }
  }

  it('keeps a minus with the amount however it is drawn', () => {
    const read = row('optional')
    assert.deepStrictEqual(
      [
        'Pix enviado - R$ 50,00',
        'Pix enviado -R$50,00',
        'Pix enviado R$ -50,00',
        'Pix enviado - 50,00',
        'Pix enviado − R$ 1.234,56',
        'Pix enviado – R$ 50,00',
        'Pix enviado R$ (50,00)',
        'Pix recebido R$ 50,00',
        'Pix recebido 1.234,56',
      ].map(read),
      [
        ['Pix enviado', -5_000],
        ['Pix enviado', -5_000],
        ['Pix enviado', -5_000],
        ['Pix enviado', -5_000],
        ['Pix enviado', -123_456],
        ['Pix enviado', -5_000],
        ['Pix enviado', -5_000],
        ['Pix recebido', 5_000],
        ['Pix recebido', 123_456],
      ],
    )
  })

  it('requires the currency sign when asked and never reads part of a number', () => {
    const read = row('required')
    assert.deepStrictEqual(
      [
        read('Pix enviado - R$ 50,00'),
        read('Pix enviado - 50,00'),
        read('Pix 1234.567,00'),
      ],
      [['Pix enviado', -5_000], null, null],
    )
  })
})
