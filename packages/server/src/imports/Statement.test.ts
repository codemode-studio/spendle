import { assert, describe, it } from '@effect/vitest'

import {
  fingerprintIds,
  parseDate,
  parseMoney,
  parseOfxAmount,
} from './Statement.ts'

describe('parseMoney', () => {
  it('reads Brazilian and international notations exactly', () => {
    assert.deepStrictEqual(
      [
        '1.234,56',
        '1,234.56',
        'R$ -10,00',
        '(10,00)',
        '10,00-',
        '-0.1',
        '1500',
        '0,05',
      ].map((text) => parseMoney(text)),
      [123456, 123456, -1000, -1000, -1000, -10, 150000, 5],
    )
  })

  it('rejects text without digits', () => {
    assert.strictEqual(parseMoney('R$'), null)
    assert.strictEqual(parseMoney(''), null)
  })
})

describe('parseDate', () => {
  it('accepts ISO, Brazilian and OFX dates and rejects impossible ones', () => {
    assert.deepStrictEqual(
      [
        '2026-09-30',
        '30/09/2026',
        '30/09/26',
        '20260930120000[-3:BRT]',
        '31/02/2026',
        '29/02/2028',
      ].map(parseDate),
      [
        '2026-09-30',
        '2026-09-30',
        '2026-09-30',
        '2026-09-30',
        null,
        '2028-02-29',
      ],
    )
  })
})

describe('fingerprintIds', () => {
  it('keeps identical purchases apart and source ids as given', () => {
    const coffee = {
      bookedOn: '2026-09-30',
      amountCents: -500,
      description: 'Café',
      raw: null,
    }
    assert.deepStrictEqual(
      fingerprintIds([
        coffee,
        { ...coffee, description: 'CAFÉ ' },
        { ...coffee, externalId: 'abc' },
      ]).map((line) => line.externalId),
      [
        'fp:2026-09-30%7C-500%7Ccafe@1',
        'fp:2026-09-30%7C-500%7Ccafe@2',
        'id:abc@1',
      ],
    )
  })

  it('never lets a source id collide with a generated one', () => {
    const line = {
      bookedOn: '2026-09-30',
      amountCents: -500,
      description: 'Café',
      raw: null,
    }
    const ids = fingerprintIds([
      { ...line, externalId: 'a' },
      { ...line, externalId: 'a' },
      { ...line, externalId: 'a#2' },
      { ...line, externalId: 'a@2' },
    ]).map((generated) => generated.externalId)
    assert.strictEqual(new Set(ids).size, 4)
  })
})

describe('parseOfxAmount', () => {
  it('reads one decimal separator and no grouping', () => {
    assert.deepStrictEqual(
      ['1.2300', '1,23', '-10.5', '1234', '.50'].map((text) =>
        parseOfxAmount(text),
      ),
      [123, 123, -1050, 123400, 50],
    )
  })

  it('rejects fractions of a centavo and grouped digits', () => {
    assert.deepStrictEqual(
      ['1.234', '1,005', '1.234,56', 'abc'].map((text) => parseOfxAmount(text)),
      [null, null, null, null],
    )
  })
})

describe('parseMoney grouping', () => {
  it('rejects thousands that are not grouped by threes', () => {
    assert.deepStrictEqual(
      ['1.23.4', '12,34,567', '1.234.567,89'].map((text) => parseMoney(text)),
      [null, null, 123456789],
    )
  })
})
