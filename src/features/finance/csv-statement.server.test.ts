import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { parseCsvStatement } from './csv-statement.server'

describe('importação CSV', () => {
  it('usa satoshis e a moeda da conta quando o CSV não repete BTC', () => {
    const result = parseCsvStatement(
      Buffer.from('date,description,amount\n2026-08-25,Aporte,0.00000001'),
      'account',
      undefined,
      'BTC',
    )

    expect(result.detectedCurrency).toBe('BTC')
    expect(result.transactions[0]).toMatchObject({
      amountCents: 1,
      currency: 'BTC',
    })
  })

  it('detecta delimitador, cabeçalhos em português e linhas inválidas', () => {
    const result = parseCsvStatement(
      Buffer.from(
        [
          'Data;Descrição;Débito;Crédito;Identificador',
          '01/06/2026;Mercado;50,00;;tx-1',
          '02/06/2026;Pix recebido;;1.234,56;tx-2',
          'linha inválida;;;;',
        ].join('\n'),
      ),
      'account',
    )
    expect(result).toMatchObject({
      sourceTransactionCount: 3,
      invalidTransactionCount: 1,
      periodStart: '2026-06-01',
      periodEnd: '2026-06-02',
    })
    expect(result.transactions).toMatchObject([
      { externalId: 'tx-1', amountCents: -5_000 },
      { externalId: 'tx-2', amountCents: 123_456 },
    ])
  })

  it('trata valores sem sinal como compras em CSV de cartão', () => {
    const result = parseCsvStatement(
      Buffer.from('date,description,amount\n2026-06-03,Cafeteria,"25,90"'),
      'card',
    )
    expect(result.transactions[0]?.amountCents).toBe(-2_590)
  })

  it('lê o fixture sanitizado de conta do Inter', () => {
    const fixture = readFileSync(
      new URL('./fixtures/inter-account-statement.csv', import.meta.url),
    )
    const result = parseCsvStatement(fixture, 'account')

    expect(result).toMatchObject({
      sourceTransactionCount: 86,
      invalidTransactionCount: 0,
      periodStart: '2025-05-27',
      periodEnd: '2025-08-24',
      detectedLastFour: '4321',
      closingBalanceCents: 6_027_836,
      balanceAsOf: '2025-08-24',
    })
    expect(result.transactions[0]).toMatchObject({
      postedAt: '2025-08-24',
      description: 'Destinatário teste 001',
      amountCents: -1_373,
      raw: { saldo: '60.278,36' },
    })
    expect(result.transactions.at(-1)).toMatchObject({
      postedAt: '2025-06-02',
      description: 'Remetente teste 086',
      amountCents: 217_289,
    })
  })

  it('separa cobertura declarada da atividade no CSV sanitizado do Nubank', () => {
    const fixture = readFileSync(
      new URL('./fixtures/nubank-account-statement.csv', import.meta.url),
    )
    const result = parseCsvStatement(
      fixture,
      'account',
      'NU_54686607_01MAI2026_31MAI2026.csv',
    )

    expect(result).toMatchObject({
      sourceTransactionCount: 3,
      invalidTransactionCount: 0,
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
      activityStart: '2026-05-09',
      activityEnd: '2026-05-18',
      periodSource: 'filename',
      coverageConfidence: 'high',
      closingBalanceCents: null,
    })
    expect(
      result.transactions.map((transaction) => transaction.amountCents),
    ).toEqual([-12_540, 250_000, -8_990])
  })

  it('rejeita datas impossíveis em vez de normalizá-las silenciosamente', () => {
    const result = parseCsvStatement(
      Buffer.from('date,description,amount\n2026-02-30,Inválida,10.00'),
      'account',
    )
    expect(result).toMatchObject({
      sourceTransactionCount: 1,
      invalidTransactionCount: 1,
      transactions: [],
    })
  })

  it('valida saldo crescente com duas movimentações na mesma data', () => {
    const result = parseCsvStatement(
      Buffer.from(
        [
          'date;description;amount;balance',
          '2026-05-31;A;10,00;110,00',
          '2026-05-31;B;20,00;130,00',
        ].join('\n'),
      ),
      'account',
    )
    expect(result).toMatchObject({
      closingBalanceCents: 13_000,
      balanceAsOf: '2026-05-31',
    })
  })

  it('exige confirmação quando a atividade cai fora do período do nome', () => {
    const result = parseCsvStatement(
      Buffer.from('date,description,amount\n2026-06-01,Fora do mês,10.00'),
      'account',
      'NU_00000000_01MAI2026_31MAI2026.csv',
    )
    expect(result).toMatchObject({
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
      periodSource: 'activity',
      coverageConfidence: 'low',
    })
  })
})
