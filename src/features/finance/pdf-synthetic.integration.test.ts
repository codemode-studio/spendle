import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { readStatement } from './statement-reader.server'

describe('checked-in synthetic PDF', () => {
  it('extracts actual PDF bytes through the native reader and keeps Valor separate from Saldo', async () => {
    const buffer = await readFile(
      new URL('./fixtures/synthetic-mercado-pago.pdf', import.meta.url),
    )
    const result = await readStatement({
      buffer,
      filename: 'synthetic-mercado-pago.pdf',
      targetType: 'account',
      targetCurrency: 'BRL',
      targetInstitution: 'Mercado Pago',
      targetIdentifiers: [],
      aiConsent: false,
      learnedCoverageTemplates: [],
    })
    expect(result.parserId).toBe('mercado-pago/account-statement/v1')
    expect(result.transactions.map((row) => row.amountCents)).toEqual([
      100_000, -10_000,
    ])
    expect(result.controls).toMatchObject({
      openingBalanceCents: 0,
      closingBalanceCents: 90_000,
    })
    expect(result.coverage).toMatchObject({
      periodStart: '2026-08-01',
      periodEnd: '2026-08-02',
    })
  })
})
