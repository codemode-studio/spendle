import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'

import { db } from '#/db/index.server'
import * as schema from '#/db/schema'

export async function fetchPtax(date: string) {
  const cached = await db
    .select()
    .from(schema.exchangeRates)
    .where(
      and(
        eq(schema.exchangeRates.date, date),
        eq(schema.exchangeRates.fromCurrency, 'USD'),
        eq(schema.exchangeRates.toCurrency, 'BRL'),
        eq(schema.exchangeRates.source, 'bcb_ptax'),
      ),
    )
    .limit(1)
  if (cached[0]) return cached[0].rateMicros

  const [year, month, day] = date.split('-')
  const formatted = `${month}-${day}-${year}`
  const url = `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarDia(dataCotacao=@dataCotacao)?@dataCotacao='${formatted}'&$top=1&$format=json`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4_000) })
    if (!response.ok) return null
    const body = (await response.json()) as {
      value?: Array<{ cotacaoVenda?: number }>
    }
    const rate = body.value?.[0]?.cotacaoVenda
    if (!rate) return null
    const rateMicros = Math.round(rate * 1_000_000)
    await db
      .insert(schema.exchangeRates)
      .values({
        id: randomUUID(),
        date,
        fromCurrency: 'USD',
        toCurrency: 'BRL',
        rateMicros,
        source: 'bcb_ptax',
      })
      .onConflictDoNothing()
    return rateMicros
  } catch {
    return null
  }
}
