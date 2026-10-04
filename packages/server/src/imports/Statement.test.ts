import { assert, describe, it } from '@effect/vitest'

import { fingerprintIds, parseDate, parseMoney } from './Statement.ts'

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
      ['2026-09-30|-500|cafe', '2026-09-30|-500|cafe#2', 'abc'],
    )
  })
})
